/**
 * Data behind GET /api/v1/summary: table-wide totals and the top domains.
 *
 * Why this is not computed per request. Measured 2026-09-30 on 1.39B rows (cold):
 *   - `countDistinct(domain), countDistinct(email)` (exact) died after 12.7 s with MEMORY_LIMIT_EXCEEDED
 *     (code 241, the server-wide 18 GiB cap) -- so the endpoint returned 500 on every call, and every call
 *     was a reason for the server to allocate 18 GiB.
 *   - `uniq(domain), uniq(email)` (HyperLogLog-style, ~1-2 % error, a few hundred KB of state): 17.6 s, bounded
 *     memory. `GROUP BY domain ... LIMIT 20` with optimize_aggregation_in_order = 1: 11.0 s, bounded memory.
 * Both read the whole table, so the result is kept for SUMMARY_TTL_MS and refreshed in the background:
 * a caller never waits for a refresh once one value exists (stale-while-revalidate), and concurrent callers
 * share one computation instead of each scanning 1.39B rows.
 */

import { executeQuery } from '@/lib/clickhouse'

/** How long a computed summary counts as fresh. */
export const SUMMARY_TTL_MS = 10 * 60_000
/** After a failed refresh, wait this long before scanning again. */
export const SUMMARY_RETRY_MS = 60_000

const SETTINGS = `SETTINGS max_execution_time = 120, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, use_query_cache = 0`

/** Fields that are estimates (HyperLogLog-style `uniq`), not exact counts. */
export const SUMMARY_APPROXIMATE_FIELDS = ['unique_domains', 'unique_emails'] as const

export interface SummaryPayload {
  stats: {
    credentials: number
    unique_domains: number
    unique_emails: number
    sources: number
  }
  top_domains: Array<{ domain: string; count: number | string }>
  as_of: string
}

let cached: { value: SummaryPayload; computedAt: number } | null = null
let inflight: Promise<SummaryPayload> | null = null
let retryNotBefore = 0
let lastError: unknown = null

async function compute(): Promise<SummaryPayload> {
  const [credStats, sourceStats, topDomains] = await Promise.all([
    executeQuery(
      `SELECT count() AS total_credentials,
              uniq(domain) AS total_domains,
              uniq(email) AS unique_emails
       FROM ulp.credentials
       ${SETTINGS}`,
    ),
    executeQuery(`SELECT count() AS total_sources, sum(line_count) AS total_lines FROM ulp.sources`),
    executeQuery(
      `SELECT domain, count() AS count
       FROM ulp.credentials
       GROUP BY domain
       ORDER BY count DESC
       LIMIT 20
       SETTINGS optimize_aggregation_in_order = 1, max_execution_time = 120, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, use_query_cache = 0`,
    ),
  ])

  return {
    stats: {
      credentials: Number(credStats[0]?.total_credentials || 0),
      unique_domains: Number(credStats[0]?.total_domains || 0),
      unique_emails: Number(credStats[0]?.unique_emails || 0),
      sources: Number(sourceStats[0]?.total_sources || 0),
    },
    top_domains: topDomains as SummaryPayload['top_domains'],
    as_of: new Date().toISOString(),
  }
}

/** One shared computation at a time; a failure leaves the previous value (if any) in place. */
function refresh(): Promise<SummaryPayload> {
  if (!inflight) {
    inflight = compute()
      .then(value => {
        cached = { value, computedAt: Date.now() }
        lastError = null
        return value
      })
      .catch(err => {
        retryNotBefore = Date.now() + SUMMARY_RETRY_MS
        lastError = err
        throw err
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/**
 * The current summary. With no value yet the caller waits for the first computation (and sees its
 * error if it fails; a failed first computation is not retried for SUMMARY_RETRY_MS, so a table-wide
 * scan that cannot finish is not re-run by every request); afterwards it always gets the latest value
 * immediately, `stale` once that value is older than SUMMARY_TTL_MS, while a refresh runs in the background.
 */
export async function getSummary(): Promise<{ summary: SummaryPayload; stale: boolean }> {
  if (!cached) {
    if (lastError && !inflight && Date.now() < retryNotBefore) throw lastError
    return { summary: await refresh(), stale: false }
  }

  const stale = Date.now() - cached.computedAt > SUMMARY_TTL_MS
  if (stale && !inflight && Date.now() >= retryNotBefore) {
    refresh().catch(err => console.error('v1 summary refresh failed (serving the previous value):', err))
  }
  return { summary: cached.value, stale }
}

/** Test seam: forget the cached value and any in-flight computation. */
export function resetSummaryCache(): void {
  cached = null
  inflight = null
  retryNotBefore = 0
  lastError = null
}
