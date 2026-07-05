/**
 * Content-level deduplication of ulp.credentials — the durable follow-up to the
 * one-time scripts/dedup-credentials-content.sh.
 *
 * WHY this exists (and why OPTIMIZE can't): content duplicates — identical
 * email/password and the same URL once scheme and a trailing slash are
 * ignored (see lib/url-content-key.ts) — arrive across DIFFERENT source files /
 * import times. `OPTIMIZE … DEDUPLICATE BY`
 * cannot collapse them — ClickHouse requires the DEDUPLICATE key to include the
 * ORDER BY + partition columns (domain, email, imported_at), and `imported_at`
 * being mandatory is exactly what keeps cross-import copies distinct. So content
 * dedup must compare only (url,email,password).
 *
 * MECHANISM: a race-safe `ALTER TABLE … DELETE` (a background mutation — concurrent
 * inserts are never lost, unlike a rewrite+swap). For each content group it keeps
 * the single row with the smallest full-row hash and deletes the rest.
 *
 * SAFETY: report-only by default. It logs how many rows it WOULD delete; nothing
 * is removed unless CONTENT_DEDUP_APPLY=true. The scheduled cron
 * (lib/dedup-cron.ts) invokes this routine; operators can also run the verified
 * content-key cleanup script at scripts/dedup-credentials-content.sh.
 *
 * SCALE: the stats query (uniqExact) is fine through the current ~91M rows
 * (confirmed live 2026-07-04, 5s). The DELETE mutation used to be a heavyweight
 * `ALTER TABLE ... DELETE`, whose CONTENT_DUPLICATE_PREDICATE subquery (~67M
 * distinct groups) exceeded 4 GiB in ~1.6s for a single evaluation — and
 * ClickHouse re-evaluates big-table mutation subqueries per merge per part, not
 * once, so under this instance's ~20-thread background pool the real cost could
 * multiply well past the server's memory ceiling. Fixed 2026-07-05: switched to
 * a lightweight `DELETE FROM` (matching scripts/purge-existing-t3.sh's proven
 * fix for the same class of problem on this table) with max_threads=2 (bounds
 * concurrent subquery re-evaluation) and max_bytes_before_external_group_by
 * (CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES below) deliberately NOT paired with
 * an explicit max_memory_usage override — unlike lib/clickhouse-query-limits.ts's
 * exportGroupBySettings(), where setting max_memory_usage below the profile's
 * 20 GiB spill threshold made spilling unreachable. Full investigation:
 * docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md.
 * Do not set CONTENT_DEDUP_APPLY=true until that spec's "Verification plan"
 * has actually been completed against disposable data — this fix is confirmed
 * against an equivalent read-only SELECT, not yet against a real mutation.
 */
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

/** Content identity: same destination + same credential (scheme/trailing-slash-insensitive on the URL). */
export const CONTENT_KEY = `${URL_CONTENT_KEY}, email, password`

/** Full-row hash — picks one deterministic survivor per content group. */
export const FULL_HASH =
  'cityHash64(url, email, password, domain, source_file, breach_name, imported_at)'

/**
 * Rows to delete: those whose full-row hash is NOT the minimum within their
 * content group — i.e. every copy except one per unique (url,email,password).
 * (A singleton's hash is trivially its group min, so singletons are never deleted.)
 */
export const CONTENT_DUPLICATE_PREDICATE =
  `${FULL_HASH} NOT IN (SELECT min(${FULL_HASH}) FROM ulp.credentials GROUP BY ${CONTENT_KEY})`

/** Distinctive substring of the DELETE command, for the in-flight mutation check. */
const MUTATION_MARKER = `GROUP BY ${CONTENT_KEY}`

export function buildStatsSql(): string {
  return `SELECT
    count() AS total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS distinct_creds,
    total - distinct_creds AS excess
  FROM ulp.credentials
  SETTINGS max_execution_time = 300`
}

export function buildDeleteSql(): string {
  return `DELETE FROM ulp.credentials WHERE ${CONTENT_DUPLICATE_PREDICATE}`
}

/**
 * Memory ceiling for the DELETE mutation's inline CONTENT_DUPLICATE_PREDICATE
 * subquery. Confirmed live 2026-07-04: without this, the subquery exceeds
 * 4 GiB in ~1.6s; with it, it succeeds in ~17.8s (disk spill). No
 * max_memory_usage override is set alongside this anywhere this is used — see
 * the SCALE comment above for why that pairing matters.
 */
export const CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

/** Full statement runContentDedupTick() submits — exported so its exact shape is testable. */
export function buildDeleteExecSql(): string {
  return `${buildDeleteSql()} SETTINGS mutations_sync = 0, max_threads = 2, max_bytes_before_external_group_by = ${CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES}`
}

// ── env knobs (pure, testable) ──────────────────────────────────────────────────

/** Cron interval in hours; 0 (or invalid) disables the scheduled job. Default 24. */
export function dedupCronHours(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.DEDUP_CRON_HOURS ?? '24', 10)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** Whether the destructive DELETE is allowed to run. Default false (report-only). */
export function contentDedupApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_DEDUP_APPLY === 'true' || env.CONTENT_DEDUP_APPLY === '1'
}

/** Don't fire a (heavy) mutation unless at least this many excess rows exist. Default 1000. */
export function minExcessToApply(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.DEDUP_MIN_EXCESS ?? '1000', 10)
  return Number.isFinite(n) && n >= 0 ? n : 1000
}

/**
 * UTC hour (0-23) the daily cron tick is anchored to. Default 4 (04:00 UTC).
 * Previously the first tick fired 60s after whatever moment the app container
 * happened to start, so its daily recurrence landed at an arbitrary wall-clock
 * time — including, on 2026-06-27, the middle of a heavy-query window. Anchor
 * it to an explicit hour instead; tune DEDUP_CRON_HOUR_UTC to your actual
 * low-traffic window.
 */
export function dedupCronHourUtc(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.DEDUP_CRON_HOUR_UTC ?? '4', 10)
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 4
}

// ── tick (report, and optionally apply) ─────────────────────────────────────────

let tickInFlight = false

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
}

/**
 * Read duplicate stats, log them, and — only when CONTENT_DEDUP_APPLY is on and
 * excess clears the threshold — submit the async DELETE. Never throws.
 */
export async function runContentDedupTick(opts: { trigger?: string } = {}): Promise<DedupTickResult> {
  const trigger = opts.trigger ?? 'tick'
  if (tickInFlight) return { total: 0, excess: 0, applied: false }
  tickInFlight = true
  try {
    const client = getClient()
    const statsRes = await client.query({ query: buildStatsSql(), format: 'JSONEachRow' })
    const [stats] = (await statsRes.json()) as Array<{ total: string; excess: string }>
    const total = Number(stats?.total ?? 0)
    const excess = Number(stats?.excess ?? 0)
    const applyOn = contentDedupApplyEnabled()
    const willApply = applyOn && excess >= minExcessToApply()

    console.log(
      `[content-dedup] ${trigger}: total=${total} excess=${excess} willApply=${willApply}` +
        (applyOn ? '' : ' (report-only — set CONTENT_DEDUP_APPLY=true to enable cleanup)'),
    )
    if (!willApply) return { total, excess, applied: false }

    // Don't stack mutations: skip if a content-dedup DELETE is already running.
    const mutRes = await client.query({
      query: `SELECT count() AS c FROM system.mutations
              WHERE database='ulp' AND table='credentials' AND is_done=0
                AND command LIKE {marker:String}`,
      query_params: { marker: `%${MUTATION_MARKER}%` },
      format: 'JSONEachRow',
    })
    const [mut] = (await mutRes.json()) as Array<{ c: string }>
    if (Number(mut?.c ?? 0) > 0) {
      console.log('[content-dedup] a dedup mutation is already running — skipping')
      return { total, excess, applied: false }
    }

    await client.exec({ query: buildDeleteExecSql() })
    console.log(`[content-dedup] submitted DELETE FROM (~${excess} duplicate rows, async mutation)`)
    return { total, excess, applied: true }
  } catch (err) {
    console.error('[content-dedup] tick error:', err instanceof Error ? err.message : String(err))
    return { total: 0, excess: 0, applied: false }
  } finally {
    tickInFlight = false
  }
}
