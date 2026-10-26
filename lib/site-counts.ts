/**
 * How many rows ulp.credentials holds for each site of a pasted list: the counting behind POST /api/lookup/counts, POST /api/v1/lookup/counts and the
 * Site Counts page (design and measurements: docs/superpowers/specs/2026-10-26-site-counts-design.md). The parts that need no database are in
 * lib/site-counts-input.ts, which the page imports too.
 *
 * A site is its host and every subdomain of it (the same meaning as a domain monitor, lib/domain-match.ts). `domain` stores the bare host, so the
 * rows of `app.corp.tld` are not found by `domain = 'corp.tld'`; and a suffix match cannot use the primary key. The reversed-domain projection
 * (proj_domain_rev, `ORDER BY reverse(domain)`) turns it into prefix ranges: `endsWith(domain, '.x')` is `startsWith(reverse(domain), reverse('.x'))`,
 * byte for byte. The query reads only the granules those ranges leave, counts the rows of every stored domain among them, and then gives each stored
 * domain to every listed host it is a subdomain of (its dot-boundary suffixes are looked up in the list), so one pass answers every site of a chunk.
 *
 * Why chunks of 20. The prefix conditions are evaluated on every row of the granules that are read, so the work grows with rows x hosts: 25 sites took
 * 0.75 s and 100 sites 5 s in one query (23 ms and 50 ms per site), and a 419-site list with a few very broad sites did not finish in 60 s. By 20 the cost is
 * about 22 ms a site, and one very broad site (80 million rows) adds a second or two to its own chunk only.
 *
 * Why the condition is not wrapped in indexHint (as the e-mail lookups do for their text index): the projection index does not see through it, and the
 * same query then read all 2.23 billion rows (24 s). And why `max_projection_rows_to_use_projection_index` is raised: with an imported window the
 * default (1,000,000) makes the planner skip the projection and read every month the window touches (a 15 s timeout against 0.6 s with the setting).
 */
import { executeQuery } from '@/lib/clickhouse'
import { searchedAsField, stringList } from '@/lib/batch-lookup'
import { isDomainRevProjectionReady } from '@/lib/credentials-projections'
import { importedRangeAndSql, importedRangeEchoIfSet, importedRangePlain, parseImportedRange, type ImportedRange } from '@/lib/imported-range'
import { SITE_COUNTS_MAX_PER_REQUEST, planSites, splitRequests, type SiteCount, type SiteEntry } from '@/lib/site-counts-input'

/** Sites counted by one ClickHouse query. */
export const SITE_COUNTS_CHUNK = 20

/** Subdomains listed under a site (the ones with the most rows). */
export const SITE_COUNTS_TOP = 10

/** One query's time limit, and the time one request spends on all its queries: a site that would need longer is reported, not waited for. */
export const SITE_COUNTS_QUERY_SECONDS = 20
export const SITE_COUNTS_BUDGET_MS = 45_000

const TOO_BROAD = 'too broad to count in the time allowed'
const OUT_OF_TIME = 'not counted: the time limit for one request was reached, send this site again'

export interface HostCounts {
  host_count: number
  /** null when only hosts were counted. */
  subdomain_count: number | null
  subdomains: number | null
  top_subdomains: Array<{ domain: string; count: number }>
}

const SETTINGS = `SETTINGS max_execution_time = ${SITE_COUNTS_QUERY_SECONDS}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1`

// ── The two queries ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The count of every site of `hosts`, subdomains included, in one pass. The WHERE is the pruning condition: per host an equality and a label-boundary
 * prefix on the reversed key (ClickHouse folds the equalities into one set). The rows it lets through are only those of the granules the key leaves, so the
 * outer part decides which host each stored domain belongs to: `suffix` runs over the dot-boundary suffixes of the domain (`a.b.tld` -> `a.b.tld`, `b.tld`,
 * `tld`) and only a suffix that is a listed host stays. A row of the host itself or of its `www.` spelling (4,605 older rows keep one) is the host's; any
 * other is a subdomain's.
 */
export function subdomainCountsSql(hosts: string[], range: ImportedRange): { sql: string; params: Record<string, string | number> } {
  const params: Record<string, string | number> = { top: SITE_COUNTS_TOP }
  const names = hosts.map((host, i) => {
    params[`site${i}`] = host
    return `{site${i}:String}`
  })
  const prune = names.map(n => `reverse(domain) = reverse(${n}) OR startsWith(reverse(domain), reverse(concat('.', ${n})))`).join('\n         OR ')
  const rangeSql = importedRangePlain(range)
  Object.assign(params, rangeSql.params)
  const isHost = `d = suffix OR d = concat('www.', suffix)`
  const sql = `SELECT
  suffix AS host,
  sumIf(n, ${isHost}) AS host_count,
  sumIf(n, NOT (${isHost})) AS subdomain_count,
  countIf(NOT (${isHost})) AS subdomains,
  arraySlice(arraySort(x -> (-toInt64(x.1), x.2), groupArrayIf((n, d), NOT (${isHost}))), 1, {top:UInt8}) AS top_pairs,
  arrayMap(x -> x.2, top_pairs) AS top_names,
  arrayMap(x -> toString(x.1), top_pairs) AS top_counts
FROM (
  SELECT domain AS d, count() AS n
  FROM ulp.credentials
  WHERE (${prune})${importedRangeAndSql(rangeSql)}
  GROUP BY d
) AS g
ARRAY JOIN arrayMap(i -> arrayStringConcat(arraySlice(splitByChar('.', d), i), '.'), range(1, length(splitByChar('.', d)) + 1)) AS suffix
WHERE suffix IN (${names.join(', ')})
GROUP BY suffix
${SETTINGS}, max_projection_rows_to_use_projection_index = 200000000`
  return { sql, params }
}

/**
 * The fallback for when the reversed-domain key is missing on some part (a mixed state would read those parts whole): only the hosts themselves,
 * through the primary key (`domain` is its first column), at 0.17 s for 58 hosts.
 */
export function hostCountsSql(hosts: string[], range: ImportedRange): { sql: string; params: Record<string, string | number> } {
  const params: Record<string, string | number> = {}
  const names: string[] = []
  hosts.forEach((host, i) => {
    params[`site${i}`] = host
    params[`www${i}`] = `www.${host}`
    names.push(`{site${i}:String}`, `{www${i}:String}`)
  })
  const rangeSql = importedRangePlain(range)
  Object.assign(params, rangeSql.params)
  const sql = `SELECT domain AS d, count() AS n
FROM ulp.credentials
WHERE domain IN (${names.join(', ')})${importedRangeAndSql(rangeSql)}
GROUP BY d
${SETTINGS}`
  return { sql, params }
}

// ── Rows to counts ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SubdomainRow {
  host: string
  host_count: string | number
  subdomain_count: string | number
  subdomains: string | number
  top_names?: string[]
  top_counts?: Array<string | number>
}

/** 64-bit integers come back from ClickHouse's JSON as strings. A host with no row at all is not in the answer: the caller reads it as 0. */
export function subdomainRowsToCounts(rows: unknown[]): Map<string, HostCounts> {
  const counts = new Map<string, HostCounts>()
  for (const raw of rows as SubdomainRow[]) {
    const names = Array.isArray(raw.top_names) ? raw.top_names : []
    const numbers = Array.isArray(raw.top_counts) ? raw.top_counts : []
    counts.set(raw.host, {
      host_count: Number(raw.host_count),
      subdomain_count: Number(raw.subdomain_count),
      subdomains: Number(raw.subdomains),
      top_subdomains: names.map((domain, i) => ({ domain, count: Number(numbers[i]) })),
    })
  }
  return counts
}

export function hostRowsToCounts(hosts: string[], rows: unknown[]): Map<string, HostCounts> {
  const byDomain = new Map<string, number>()
  for (const raw of rows as Array<{ d: string; n: string | number }>) byDomain.set(raw.d, Number(raw.n))
  const counts = new Map<string, HostCounts>()
  for (const host of hosts) {
    counts.set(host, {
      host_count: (byDomain.get(host) ?? 0) + (byDomain.get(`www.${host}`) ?? 0),
      subdomain_count: null,
      subdomains: null,
      top_subdomains: [],
    })
  }
  return counts
}

const NO_NUMBERS = { count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [] }

/** The answer for every pasted entry, in order, keyed by what was pasted. */
export function siteCountsResults(
  entries: SiteEntry[],
  counted: Map<string, HostCounts>,
  failed: Map<string, string>,
  subdomainsCounted: boolean,
): Record<string, SiteCount> {
  const results: Record<string, SiteCount> = {}
  for (const entry of entries) {
    if (entry.error) {
      results[entry.original] = { host: '', found: false, ...NO_NUMBERS, error: entry.error }
      continue
    }
    const searched = searchedAsField(entry.host, entry.original.trim().toLowerCase())
    const failure = failed.get(entry.host)
    if (failure) {
      results[entry.original] = { host: entry.host, found: false, ...NO_NUMBERS, error: failure, ...searched }
      continue
    }
    const c = counted.get(entry.host) ?? {
      host_count: 0,
      subdomain_count: subdomainsCounted ? 0 : null,
      subdomains: subdomainsCounted ? 0 : null,
      top_subdomains: [],
    }
    const count = c.host_count + (c.subdomain_count ?? 0)
    results[entry.original] = {
      host: entry.host,
      found: count > 0,
      count,
      host_count: c.host_count,
      subdomain_count: c.subdomain_count,
      subdomains: c.subdomains,
      top_subdomains: c.top_subdomains,
      ...searched,
    }
  }
  return results
}

// ── Counting ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A site too broad for the time or the memory one query has. Anything else (ClickHouse down, a bad query) is an error of the request. */
function isTooBroad(err: unknown): boolean {
  return /TIMEOUT_EXCEEDED|MEMORY_LIMIT_EXCEEDED|timeout exceeded|memory limit/i.test(err instanceof Error ? err.message : String(err))
}

export interface SiteCountsOutcome {
  results: Record<string, SiteCount>
  /** False when only each host could be counted: the reversed-domain key was not on every part. */
  subdomains_counted: boolean
}

/**
 * Counts the sites of a pasted list. A chunk that is too slow is counted site by site, so only a site that is too broad on its own is left without a
 * number (with the reason); and when the request has used up its time the sites not yet counted say so. Any other error is the request's.
 */
export async function countSites(
  originals: string[],
  range: ImportedRange,
  deps: { now?: () => number } = {},
): Promise<SiteCountsOutcome> {
  const now = deps.now ?? Date.now
  const plan = planSites(originals)
  if (plan.hosts.length === 0) return { results: siteCountsResults(plan.entries, new Map(), new Map(), true), subdomains_counted: true }

  const deadline = now() + SITE_COUNTS_BUDGET_MS
  const subdomainsCounted = await isDomainRevProjectionReady(sql => executeQuery(sql))
  const counted = new Map<string, HostCounts>()
  const failed = new Map<string, string>()

  const countChunk = async (hosts: string[]) => {
    const { sql, params } = subdomainsCounted ? subdomainCountsSql(hosts, range) : hostCountsSql(hosts, range)
    const rows = await executeQuery(sql, params)
    const part = subdomainsCounted ? subdomainRowsToCounts(rows) : hostRowsToCounts(hosts, rows)
    part.forEach((value, host) => counted.set(host, value))
  }

  for (const chunk of splitRequests(plan.hosts, SITE_COUNTS_CHUNK)) {
    if (now() > deadline) {
      chunk.forEach(host => failed.set(host, OUT_OF_TIME))
      continue
    }
    try {
      await countChunk(chunk)
    } catch (err) {
      if (!isTooBroad(err)) throw err
      if (chunk.length === 1) {
        failed.set(chunk[0], TOO_BROAD)
        continue
      }
      for (const host of chunk) {
        if (now() > deadline) {
          failed.set(host, OUT_OF_TIME)
          continue
        }
        try {
          await countChunk([host])
        } catch (alone) {
          if (!isTooBroad(alone)) throw alone
          failed.set(host, TOO_BROAD)
        }
      }
    }
  }
  return { results: siteCountsResults(plan.entries, counted, failed, subdomainsCounted), subdomains_counted: subdomainsCounted }
}

// ── The request ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SiteCountsReply {
  status: number
  json: Record<string, unknown>
}

/**
 * The body of POST /api/lookup/counts and POST /api/v1/lookup/counts, checked and answered. The two routes differ only in how they sign a caller in,
 * so what they say is written once (the batch lookups had two copies of their logic, and both carried the same defects).
 *
 * Body: { domains: string[], imported_after?: string, imported_before?: string }; the window is the one of every other lookup (lib/imported-range.ts).
 * Answer: { success, queried, found, subdomains_counted, results: { [as pasted]: SiteCount }, imported_after?, imported_before? }.
 */
export async function answerSiteCounts(body: { domains?: unknown; imported_after?: unknown; imported_before?: unknown }): Promise<SiteCountsReply> {
  const parsedRange = parseImportedRange({ imported_after: body.imported_after, imported_before: body.imported_before })
  if (!parsedRange.ok) return { status: 400, json: { success: false, error: parsedRange.error } }

  const domains = stringList(body.domains)
  if (domains.length === 0) return { status: 400, json: { success: false, error: 'Provide at least one site in "domains"' } }
  if (domains.length > SITE_COUNTS_MAX_PER_REQUEST) {
    return {
      status: 422,
      json: { success: false, error: `Too many sites (${domains.length}). Maximum is ${SITE_COUNTS_MAX_PER_REQUEST} per request.` },
    }
  }

  try {
    const { results, subdomains_counted } = await countSites(domains, parsedRange.range)
    return {
      status: 200,
      json: {
        success: true,
        queried: domains.length,
        found: Object.values(results).filter(r => r.found).length,
        subdomains_counted,
        results,
        ...importedRangeEchoIfSet(parsedRange.range),
      },
    }
  } catch (error) {
    console.error('site counts error:', error)
    return { status: 500, json: { success: false, error: 'Site counts failed' } }
  }
}
