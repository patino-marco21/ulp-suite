/**
 * Shared "resolve current matches for a monitor's domain set" logic —
 * extracted from app/api/monitoring/monitors/[id]/matches/route.ts so the
 * rescan cron (lib/monitor-rescan-cron.ts) and the manual rescan endpoint
 * (app/api/monitoring/monitors/[id]/matches/rescan/route.ts) use the exact
 * same query strategy the live-matches endpoint was already tuned for,
 * instead of each maintaining their own. See
 * docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md.
 *
 * ── Why this is two queries ────────────────────────────────────────────────
 *
 * ulp.credentials holds 2,395,186,450 rows (measured 2026-08-23, not the 91M
 * an older comment elsewhere in this codebase quotes). Its subdomain test —
 * `endsWith(domain, '.example.com')`, which is semantically required, dropping
 * it reintroduces a bug a prior session fixed — is prunable by no index on the
 * table. `EXPLAIN indexes=1`: bare `domain = 'x'` prunes 37350 granules to 38,
 * `domain = 'x' OR endsWith(domain, '.x')` prunes 37350 to 37350.
 *
 * An unordered LIMIT hides that for a BROAD monitor: ClickHouse stops as soon
 * as it has LIMIT matching rows (roblox.com + facebook.com: 0.48 s). It cannot
 * hide it for a NARROW monitor — the ordinary case this function exists to
 * serve — because proving there are fewer than LIMIT matches requires reading
 * every row. Measured on the old single-query form, aave.com + trezor.io (620
 * matches) died on `max_execution_time = 60`, i.e. the endpoint 500'd for
 * exactly the monitors it was built to serve. Counting that same condition
 * without a LIMIT took 522 s over 2.40 billion rows / 198.51 GiB. Adding a
 * primary-key-ordered LIMIT does NOT rescue it either — measured, still a
 * 60 s timeout — because the filter cannot be evaluated without reading
 * (url, email, password) for every granule.
 *
 * So:
 *   Phase 1 (cacheable) resolves the SET of exact `domain` / `email_domain`
 *     column values that could belong to a matching row, by scanning ONLY that
 *     one narrow column. Cheap for a reason worth knowing: `SELECT DISTINCT
 *     domain` reads the LEADING primary-key column, so with the server's
 *     `optimize_distinct_in_order = 1` ClickHouse seeks between distinct key
 *     values instead of reading every granule — measured 0.14–0.35 s over
 *     4.72M rows / 73 marks for aave.com + trezor.io. That optimization, not
 *     index pruning, is what makes phase 1 affordable: forcing the same query
 *     to scan (`optimize_distinct_in_order = 0, use_skip_indexes = 0`) costs
 *     10.58 s over 2.40 billion rows / 40.90 GiB / 37350 marks — and returns
 *     the identical 15 values, which is the check that phase 1 is COMPLETE and
 *     not merely fast. `email_domain` is not a key column but carries a bloom
 *     filter and an ngram index: 0.17 s narrow, 5.5 s for a broad provider.
 *     The real cost driver is the legacy-normalization probe below (5–13 s).
 *   Phase 2 (per request, cheap) filters `domain IN (<those values>)`, an
 *     exact-value IN-list, which IS primary-key and bloom-filter prunable:
 *     37350 granules to 38. Measured 0.22 s for the same aave.com + trezor.io
 *     monitor that used to time out at 60 s, returning the identical row set.
 *
 * Phase 2 keeps the full buildDomainSetWhereClause condition ANDed on top, so
 * the IN-list only ever prunes work — it can never widen the result set.
 *
 * Measure with `use_query_cache = 0`. lib/clickhouse.ts enables the query cache
 * (TTL 30 s) for every app query, so a re-run inside that window reports the
 * cache's timing rather than the plan's.
 */

import { executeQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
import {
  buildDomainSetWhereClause,
  buildCandidateColumnWhereClause,
  buildCandidateValueBranches,
  compareMatches,
  mergeMatchPages,
  type CandidateColumn,
  type MatchMode,
  type MatchRow,
} from '@/lib/domain-match'

// Bounded "what's currently matching" snapshot. Exported so the GET route
// and the rescan route import this one constant instead of each
// redeclaring their own copy (final-review Fix 3).
export const MATCH_LIMIT = 100

/**
 * Cap on phase 1's resolved value set. Past this the monitor is broad enough
 * that it certainly has more than MATCH_LIMIT matches, so the plain unordered
 * LIMIT short-circuits on its own and the fallback query below is the cheaper
 * plan. `SELECT DISTINCT ... LIMIT n` short-circuits too, so detecting the
 * overflow is itself cheap: 0.17 s for roblox.com + facebook.com.
 */
const CANDIDATE_LIMIT = 1000

/**
 * Phase 1's slowest branch is the legacy probe, measured 5.3–13.5 s for a
 * narrow (1–2 domain) monitor; the column scans run 0.14–6.5 s in that same
 * regime. Neither number holds for a broader monitor.
 *
 * Measured 2026-08-25 against the real "Dedicated / general hardware
 * wallets" monitor (17 domains, mode 'both'), which was 500ing with a
 * garbled "Unexpected token 'C' ... is not valid JSON" error: isolated, the
 * legacy probe took 46.2 s and the `email_domain` candidate scan took
 * 42.7 s — both over or right at the old 45 s cap, and run concurrently via
 * Promise.all in resolveCandidates so real contention only made it worse.
 *
 * Root cause of why `email_domain` is so much slower than `domain` here:
 * its ngram (idx_ngram_email_domain) and bloom filter (idx_bf_email_domain)
 * skip indexes exist and are materialized (verified via
 * system.data_skipping_indices and system.mutations — both show
 * is_done = 1) but measured ZERO pruning at this table's current
 * 2.4-billion-row scale: `rows_read` was the full table for
 * `email_domain = 'x'` alone, for `... OR endsWith(...)`, and for `... OR
 * LIKE '%.x'` alike (all three tested directly against ClickHouse with
 * EXPLAIN and real execution). `domain` doesn't have this problem only
 * because it's the primary key's leading column, so it prunes on key order
 * regardless of whether its own ngram index helps. `email_domain` has no
 * such fallback. This is a real, unexplained gap in its own right — worth
 * a dedicated investigation the way `domain`'s pruning got one (see the
 * design doc referenced at the top of this file) — not something this
 * timeout bump fixes. 90 s is a verified-sufficient budget for the monitor
 * that surfaced this (2× the slower of the two measured costs), not a
 * guarantee for an even broader one.
 */
const PHASE1_MAX_EXECUTION_TIME = 90

/**
 * Phase 2 reads a pruned candidate set: 0.22 s narrow, 1.25 s for the broadest
 * still-enumerable monitor measured (facebook.com in credential mode).
 */
const PHASE2_MAX_EXECUTION_TIME = 30

/**
 * Fallback plan for monitors too broad to enumerate; measured 0.61–4.81 s.
 *
 * The phases run in sequence, so their caps have to SUM to less than
 * whatever wall-clock budget the caller actually has. None of this
 * resolver's callers currently declares a `maxDuration` — not the GET route
 * (which no longer calls this resolver at all; it only reads the SQLite
 * cache now), not the rescan route, not the cron. That's correct rather
 * than an oversight: `maxDuration` is a Vercel-only route config with no
 * effect on this project's self-hosted Docker deployment (next.config's
 * `output: 'standalone'`) — same reasoning documented in
 * __tests__/monitor-matches-route.test.ts. What actually protects a caller
 * from a runaway request is each phase's own `max_execution_time` below,
 * together with `timeout_overflow_mode = 'throw'`: an overrun phase throws a
 * specific TIMEOUT_EXCEEDED instead of running unbounded, independent of any
 * platform-level request timeout.
 */
const FALLBACK_MAX_EXECUTION_TIME = 30

/**
 * The ONE sort key every plan here uses: EXACTLY ulp.credentials' primary-key
 * prefix (the table is `ORDER BY (domain, email, imported_at)`), so ClickHouse
 * reads in key order and stops at LIMIT instead of materializing and sorting
 * the filtered set.
 *
 * Some stable sort is required: the old unordered LIMIT sampled a different
 * arbitrary MATCH_LIMIT rows per view, so is_new badges flickered independently
 * of actual newness.
 *
 * Adding a (url, password) tiebreak forces a sort inside every (domain, email)
 * group, and that is affordable only when the candidate set is small. It is not
 * always small: a monitor whose value set is BROAD but still under
 * CANDIDATE_LIMIT — facebook.com in credential mode resolves just 181
 * email_domain values — takes the pruned path, and there the fuller key
 * measured 14.88 s / 838.7M rows / 54.75 GiB against 1.25 s / 54.4M rows /
 * 3.24 GiB for this prefix. On a narrow monitor the two are indistinguishable
 * (0.22 s vs 0.20 s), so the prefix costs nothing where the tiebreak was cheap
 * and saves an order of magnitude where it was not.
 *
 * Determinism is not lost by dropping the tiebreak: every page is re-sorted
 * in-process by compareMatches, which DOES compare all four fields, so display
 * order is fully pinned. What stays unpinned is only WHICH rows of a single
 * (domain, email) group land in the page when that one group straddles the
 * LIMIT — and a monitor narrow enough for the badge to matter never reaches it.
 */
const MATCH_ORDER_BY = 'domain, email'

/**
 * Raw `domain` values that lib/ulp-normalize.ts's Case A–D corrections can
 * rewrite into some OTHER domain, so a phase-1 scan of the raw column alone
 * would not surface them. Case D (url='', real URL in the email column) and
 * Case A (jsessionid rows) store domain=''; Case C stores the bare scheme.
 * Measured 2026-08-23: 4,080,347 Case D + 117 Case A rows sit under domain='',
 * and Cases B/C currently have zero rows.
 *
 * KNOWN GAP: 225 Case A rows table-wide (of 2.4 billion) carry a non-empty raw
 * domain — the email provider's, e.g. 'gmail.com' — while normalizing to the
 * bank URL buried in their password column. Enumerating those needs a 19.9 s
 * `hasToken(email, 'jsessionid')` scan whose resolved values ('gmail.com',
 * 'hotmail.com', …) would then drag tens of millions of unrelated rows into
 * phase 2. Accepted: 225 / 2,395,186,450 rows, only reachable by a monitor
 * watching the exact bank domain inside them.
 */
const NORMALIZED_LEGACY_DOMAINS = ['', 'http', 'https']

interface CandidateResolution {
  /**
   * Exact column values phase 2 may restrict to. Ordered most-selective
   * first — buildCandidateValueBranches makes later branches exclude earlier
   * ones, so the order decides which branch does the cheap work.
   */
  columns: Array<{ column: CandidateColumn; values: string[] }>
  /**
   * Matches that live under one of NORMALIZED_LEGACY_DOMAINS, carried as ROWS
   * rather than as extra values for phase 2's IN-list. Putting '' in that list
   * instead drags all 21.3M domain-less rows into every single request —
   * measured 8.2 s per view on a monitor that has such a match, versus 0.2 s
   * once they are resolved here and phase 2 skips that bucket entirely.
   * They age with the cache entry like everything else phase 1 resolves.
   *
   * This page is the SOLE owner of that bucket — every phase-2 branch excludes
   * it (see the buildCandidateValueBranches call in resolveMonitorMatches) so
   * the two never return the same row. It is also CACHED, so nothing
   * downstream may sort or otherwise mutate it in place; mergeMatchPages
   * copies before sorting.
   *
   * Sole ownership means sole freshness path too: a newly imported row in this
   * bucket (credential/both mode) now only becomes visible once this cache
   * entry expires (CANDIDATE_TTL_MS below), not on the next request the way
   * phase 2's fresh-every-request branches do. Up to that lag, it can combine
   * with the known recordMonitorViewed limitation (see
   * markMatchesNewSinceLastView's doc comment in lib/domain-monitor.ts — the
   * shared mechanism both the GET route and the rescan POST route call) to
   * render without a "new" badge on first real appearance — the row still
   * shows, only the badge is affected.
   */
  legacyRows: MatchRow[]
  /** True when a value set hit CANDIDATE_LIMIT — use the fallback plan instead. */
  overflowed: boolean
}

/**
 * Phase-1 results keyed by (match_mode, domain set) — the only inputs they
 * depend on, and both change only when an admin edits the monitor. In-process
 * and single-node on purpose (same tradeoff as lib/rate-limiter.ts): losing it
 * on restart costs one slow query, not correctness.
 *
 * The in-flight Promise is what's cached, so concurrent misses for the same
 * monitor share one scan instead of each starting their own.
 */
const CANDIDATE_TTL_MS = 10 * 60_000
const candidateCache = new Map<string, { expiresAt: number; resolution: Promise<CandidateResolution> }>()

function candidateCacheKey(mode: MatchMode, domains: string[]): string {
  // JSON, not a joined string: an ambiguous separator could collide two
  // different monitors onto one cache entry.
  return JSON.stringify([mode, [...domains].sort()])
}

/**
 * Resolve the exact column values phase 2 can prune to. Runs the per-column
 * scans and the legacy-normalization probe concurrently; the slowest one
 * (the `domain` column scan) sets the wall time.
 */
async function resolveCandidates(mode: MatchMode, domains: string[]): Promise<CandidateResolution> {
  const columns: CandidateColumn[] = []
  if (mode === 'url' || mode === 'both') columns.push('domain')
  if (mode === 'credential' || mode === 'both') columns.push('email_domain')

  const scans = columns.map(async column => {
    const { clause, params } = buildCandidateColumnWhereClause(column, domains)
    const rows = await executeQuery(
      `SELECT DISTINCT ${column} AS value
       FROM ulp.credentials
       WHERE ${clause}
       LIMIT {candidateLimit:UInt32}
       SETTINGS max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1`,
      { ...params, candidateLimit: CANDIDATE_LIMIT + 1 }
    ) as { value: string }[]
    return { column, values: rows.map(r => r.value) }
  })

  // Matches hiding under a legacy-normalization domain, fetched as rows. The
  // scan is bounded by the primary key to those three values (21.3M rows,
  // measured 5.7–7.9 s) and, unlike the column scans above, has to evaluate
  // the full match condition — so it is by far the most expensive thing phase
  // 1 does when it finds nothing, and exactly the thing worth caching.
  const { clause: exactClause, params: exactParams } = buildDomainSetWhereClause(domains, mode)
  const legacyScan = selectMatches(
    `domain IN {legacyDomains:Array(String)} AND ${exactClause}`,
    { ...exactParams, legacyDomains: NORMALIZED_LEGACY_DOMAINS },
    PHASE1_MAX_EXECUTION_TIME,
  )

  const [scanResults, legacyRows] = await Promise.all([Promise.all(scans), legacyScan])

  let overflowed = false
  for (const entry of scanResults) {
    if (entry.values.length > CANDIDATE_LIMIT) overflowed = true
    // Phase 2 must never re-read the legacy bucket: legacyRows already covers
    // it, so re-reading it is both the 8.2 s regression AND a duplicate row.
    // Dropping the values here keeps the IN-list small; the branch's own
    // `domain NOT IN` is what actually guarantees the two pages stay disjoint,
    // since an email_domain branch can reach those rows without their raw
    // `domain` ever appearing in any IN-list.
    entry.values = entry.values.filter(v => !NORMALIZED_LEGACY_DOMAINS.includes(v))
  }

  // `domain` leads: it is the primary key's first column, so its branch prunes
  // hardest and the email branch only has to exclude what it already covered.
  scanResults.sort((a, b) => (a.column === 'domain' ? -1 : b.column === 'domain' ? 1 : 0))

  return { columns: scanResults, legacyRows, overflowed }
}

function getCandidates(mode: MatchMode, domains: string[]): Promise<CandidateResolution> {
  const key = candidateCacheKey(mode, domains)
  const cached = candidateCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.resolution

  const resolution = resolveCandidates(mode, domains)
  candidateCache.set(key, { expiresAt: Date.now() + CANDIDATE_TTL_MS, resolution })
  // A failed scan must not be cached as if it were an answer.
  resolution.catch(() => {
    if (candidateCache.get(key)?.resolution === resolution) candidateCache.delete(key)
  })
  return resolution
}

/**
 * Fetch the bounded snapshot. Filtering is done on RAW columns and
 * NORM_DOMAIN_EXPR applied to the already-bounded LIMIT-sized result, the same
 * shape app/api/credentials/route.ts uses — and here it is load-bearing twice
 * over: a `(...) AS domain` alias in the SELECT list also SHADOWS the `domain`
 * column inside WHERE, which silently turns `domain IN (...)` into
 * `NORM_DOMAIN_EXPR IN (...)` and takes granule pruning from 38/37350 back to
 * 37350/37350. Verified via `EXPLAIN indexes=1`; the subquery form keeps the
 * WHERE referring to the real column.
 *
 * ORDER BY is primary-key aligned — ulp.credentials is `ORDER BY (domain,
 * email, imported_at)` — so ClickHouse reads in order and stops at LIMIT
 * instead of sorting the filtered set (the MEMORY_LIMIT_EXCEEDED failure mode
 * documented in app/api/credentials/route.ts's SORT_MAX_MEMORY_BYTES). Any
 * ORDER BY here must keep `domain` leading for that reason.
 *
 * `http_wait_end_of_query = 1` (like the candidate scan above) makes
 * ClickHouse buffer this LIMIT-100 result server-side instead of streaming
 * it — cheap at this size, and required for a `timeout_overflow_mode =
 * 'throw'` exception hit mid-stream to come back as a normal HTTP error
 * response. Without it, once ANY row has already been sent with the HTTP
 * 200 already committed, ClickHouse can't switch status codes, so it
 * appends the plain-text exception (e.g. "Code: 159. DB::Exception:
 * Timeout exceeded...") straight onto the JSONEachRow body instead.
 * @clickhouse/client's resultSet.json() then does a raw JSON.parse() on
 * that trailing text and throws `SyntaxError: Unexpected token 'C', "Code:
 * 159."... is not valid JSON` — a real, reproduced bug (2026-08-25): it's
 * what a rescan failure actually shows the user instead of the real
 * ClickHouse error, for ANY cause of a mid-stream throw, not just a
 * timeout. Confirmed fixed by adding this setting: the identical forced
 * timeout came back as a proper ClickHouseError (code 159,
 * TIMEOUT_EXCEEDED, a readable message) instead of crashing the parser.
 */
function selectMatches(
  where: string,
  params: Record<string, unknown>,
  maxExecutionTime: number,
) {
  return executeQuery(
    `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
     FROM (
       SELECT url, email, password, domain
       FROM ulp.credentials
       WHERE ${where}
       ORDER BY ${MATCH_ORDER_BY}
       LIMIT {matchLimit:UInt32}
     ) AS t
     SETTINGS max_execution_time = ${maxExecutionTime}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1`,
    { ...params, matchLimit: MATCH_LIMIT }
  ) as Promise<MatchRow[]>
}

export interface ResolvedMatches {
  rows: MatchRow[]
  limited: boolean
}

/**
 * Resolve up to MATCH_LIMIT credentials currently matching this domain set.
 *
 * NORMALIZED_LEGACY_DOMAINS belongs to candidates.legacyRows and to nothing
 * else. Without the exclusion the email_domain branch would re-read that
 * bucket — its rows carry a real email_domain even though their `domain` is
 * blank or scheme-only — and mergeMatchPages, which does not deduplicate,
 * would pad the page with duplicates that evict distinct matches.
 */
export async function resolveMonitorMatches(mode: MatchMode, domains: string[]): Promise<ResolvedMatches> {
  if (domains.length === 0) return { rows: [], limited: false }

  const candidates = await getCandidates(mode, domains)
  const { clause, params: domainParams } = buildDomainSetWhereClause(domains, mode)
  const candidateBranches = buildCandidateValueBranches(candidates.columns, NORMALIZED_LEGACY_DOMAINS)

  let rows: MatchRow[]
  if (candidates.overflowed) {
    // The unpruned condition already covers the legacy bucket, so
    // candidates.legacyRows must NOT be merged in here — that would double
    // any row appearing in both.
    const page = await selectMatches(clause, domainParams, FALLBACK_MAX_EXECUTION_TIME)
    rows = page.sort(compareMatches)
  } else {
    // No branches means phase 1 enumerated every candidate value and found
    // none — the legacy rows, if any, are then the whole answer.
    const pages = await Promise.all(
      candidateBranches.map(branch => selectMatches(
        `${branch.clause} AND ${clause}`,
        { ...branch.params, ...domainParams },
        PHASE2_MAX_EXECUTION_TIME,
      ))
    )
    rows = mergeMatchPages([...pages, candidates.legacyRows], MATCH_LIMIT)
  }

  return { rows, limited: rows.length === MATCH_LIMIT }
}

// ─── Rescan lock coordination (final-review Fix 1) ─────────────────────────
//
// Guards against two overlapping scans of the SAME monitor — an admin
// double-clicking "Rescan now" (app/api/monitoring/monitors/[id]/matches/
// rescan/route.ts), or the 15-minute cron (lib/monitor-rescan-cron.ts)
// firing mid-manual-rescan. Shared here, rather than kept private to either
// caller, so both actually coordinate through the same lock — a lock private
// to one caller cannot see the other's in-flight scan, which was the
// original bug this fix addresses: without a shared lock, an overlapping
// cron tick + manual rescan could both run phase 2 concurrently, and
// whichever writeMonitorMatchCache call commits LAST stamps
// monitor_rescan_status.last_success_at, independent of which one actually
// resolved more recent data.
//
// Module-level and in-memory is sufficient given this is a single-process
// deployment (see Dockerfile/docker-compose.yml) — same tradeoff as
// candidateCache above.
//
// The has()-check and the add() below MUST stay adjacent with no `await`
// between them. JS only guarantees run-to-completion across a synchronous
// stretch; a suspension point inserted between the read and the write (e.g.
// moving add() after some awaited call) reopens a check-then-act race where
// two genuinely concurrent callers each observe the set as empty before
// either writes to it. (This exact ordering was the subject of a real,
// previously-fixed TOCTOU bug in this codebase — don't reintroduce it.)
const inFlightRescans = new Set<number>()

/**
 * Attempt to acquire the rescan lock for one monitor. Returns true if
 * acquired — the caller now owns the lock and MUST release it via
 * releaseRescanLock, typically from a `finally` so a thrown error can't
 * leave the monitor permanently locked. Returns false if another rescan for
 * this monitor is already in flight; the caller should skip/reject rather
 * than proceed.
 */
export function tryAcquireRescanLock(monitorId: number): boolean {
  if (inFlightRescans.has(monitorId)) return false
  inFlightRescans.add(monitorId)
  return true
}

/** Release a lock previously acquired via tryAcquireRescanLock. */
export function releaseRescanLock(monitorId: number): void {
  inFlightRescans.delete(monitorId)
}
