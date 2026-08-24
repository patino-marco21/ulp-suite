import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor, markMatchesNewSinceLastView, recordMonitorViewed } from "@/lib/domain-monitor"
import { executeQuery } from "@/lib/clickhouse"
import {
  buildDomainSetWhereClause,
  buildCandidateColumnWhereClause,
  buildCandidateValueBranches,
  type CandidateColumn,
  type MatchMode,
} from "@/lib/domain-match"
import { NORM_DOMAIN_EXPR } from "@/lib/ulp-normalize"
import { checkLimit, getClientIP } from "@/lib/rate-limiter"

export const dynamic = 'force-dynamic'

// Phase 1 measured 21.4 s cold (see below); the route budget has to cover that
// plus phase 2, with headroom for a colder page cache.
export const maxDuration = 90

// Bounded "what's currently matching" snapshot.
const MATCH_LIMIT = 100

/**
 * ── Why this endpoint is two queries ──────────────────────────────────────
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
 * hide it for a NARROW monitor — the ordinary case this endpoint exists for —
 * because proving there are fewer than LIMIT matches requires reading every
 * row. Measured on the old single-query form, aave.com + trezor.io (620
 * matches) died on `max_execution_time = 60`, i.e. the endpoint 500'd for
 * exactly the monitors it was built to serve. Counting that same condition
 * without a LIMIT took 522 s over 2.40 billion rows / 198.51 GiB. Adding a
 * primary-key-ordered LIMIT does NOT rescue it either — measured, still a
 * 60 s timeout — because the filter cannot be evaluated without reading
 * (url, email, password) for every granule.
 *
 * So:
 *   Phase 1 (cacheable, expensive) resolves the SET of exact `domain` /
 *     `email_domain` column values that could belong to a matching row, by
 *     scanning ONLY that one narrow column. Measured cold on a fresh domain
 *     set: 20.24 s / 40.90 GiB for the full `domain` column, 8.79 s for
 *     `email_domain` (its ngram skip index does serve endsWith, unlike
 *     anything on `domain`), 21.4 s wall with the probe below in parallel.
 *   Phase 2 (per request, cheap) filters `domain IN (<those values>)`, an
 *     exact-value IN-list, which IS primary-key and bloom-filter prunable:
 *     37350 granules to 38. Measured 0.25 s for the same aave.com + trezor.io
 *     monitor that used to time out at 60 s, returning the identical row set
 *     (620 matches under both plans).
 *
 * Phase 2 keeps the full buildDomainSetWhereClause condition ANDed on top, so
 * the IN-list only ever prunes work — it can never widen the result set.
 */

/**
 * Cap on phase 1's resolved value set. Past this the monitor is broad enough
 * that it certainly has more than MATCH_LIMIT matches, so the plain unordered
 * LIMIT short-circuits on its own and the fallback query below is the cheaper
 * plan. `SELECT DISTINCT ... LIMIT n` short-circuits too, so detecting the
 * overflow is itself cheap: 0.17 s for roblox.com + facebook.com.
 */
const CANDIDATE_LIMIT = 1000

/** Phase 1 is a full column scan; measured 21.4 s cold, so allow real headroom. */
const PHASE1_MAX_EXECUTION_TIME = 45

/** Phase 2 reads a pruned candidate set; measured 0.25 s. */
const PHASE2_MAX_EXECUTION_TIME = 30

/** Fallback plan for monitors too broad to enumerate; measured 4.03 s. */
const FALLBACK_MAX_EXECUTION_TIME = 60

/**
 * Sort key for the pruned plan. Fully deterministic — without it each view
 * samples a different arbitrary MATCH_LIMIT rows and the is_new badge flickers
 * — and cheap, because the candidate set is already small: measured 0.2–1.1 s.
 * Leads with `domain`, ulp.credentials' primary-key first column.
 */
const MATCH_ORDER_BY = 'domain, email, url, password'

/**
 * Sort key for the fallback plan: EXACTLY the table's primary-key prefix, so
 * ClickHouse reads in order and stops at LIMIT rather than sorting. The extra
 * (url, password) tiebreak forces a sort inside every (domain, email) group
 * and measured 54.97 s on roblox.com + facebook.com, against 4.03 s for this
 * prefix (and 0.48 s for the old unordered form). The caller re-sorts the
 * returned page with compareMatches so its display order still matches the
 * pruned plan's; what stays unpinned is only WHICH rows of a single
 * (domain, email) group land in the page when that group straddles the LIMIT.
 */
const FALLBACK_ORDER_BY = 'domain, email'

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

interface MatchRow {
  url: string
  email: string
  password: string
  domain: string
}

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
   */
  legacyRows: MatchRow[]
  /** True when a value set hit CANDIDATE_LIMIT — use the fallback plan instead. */
  overflowed: boolean
}

// Rate limit: this endpoint's phase-1 cache-miss path is a real full-column
// scan, so it must not be hammerable. Mirrors app/api/upload/route.ts's idiom
// (module-level Map + checkLimit, keyed by IP).
const matchesLimiter = new Map<string, { count: number; resetAt: number }>()

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
       SETTINGS max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}, timeout_overflow_mode = 'throw'`,
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
    // it, and pulling it back into the IN-list is the 8.2 s regression.
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
 */
function selectMatches(
  where: string,
  params: Record<string, unknown>,
  maxExecutionTime: number,
  orderBy: string = MATCH_ORDER_BY,
) {
  return executeQuery(
    `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
     FROM (
       SELECT url, email, password, domain
       FROM ulp.credentials
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT {matchLimit:UInt32}
     ) AS t
     SETTINGS max_execution_time = ${maxExecutionTime}, timeout_overflow_mode = 'throw'`,
    { ...params, matchLimit: MATCH_LIMIT }
  ) as Promise<MatchRow[]>
}

/** Same comparator selectMatches sorts by, so merged branches stay in one order. */
function compareMatches(a: MatchRow, b: MatchRow): number {
  return (
    a.domain.localeCompare(b.domain) ||
    a.email.localeCompare(b.email) ||
    a.url.localeCompare(b.url) ||
    a.password.localeCompare(b.password)
  )
}

/**
 * Merge the per-branch pages back into one ordered page.
 *
 * Each page is its own top-MATCH_LIMIT in the shared sort order and the pages
 * cover disjoint row sets, so merging them and keeping the first MATCH_LIMIT
 * yields the same page a single combined query would — if a row is in the
 * global top-MATCH_LIMIT then fewer than MATCH_LIMIT rows sort before it, so
 * it is also within its own page's top-MATCH_LIMIT.
 *
 * The merge compares the NORMALIZED domain while the queries sorted on the raw
 * one. They differ only for the Case A–D rows lib/ulp-normalize.ts rewrites,
 * so the merge can pick a slightly different set than a true global sort would
 * when such a row sits on the boundary. Deterministic either way, which is what
 * the is_new badge needs.
 */
function mergeMatchPages(pages: MatchRow[][]): MatchRow[] {
  const nonEmpty = pages.filter(page => page.length > 0)
  if (nonEmpty.length <= 1) return nonEmpty[0] ?? []
  return nonEmpty.flat().sort(compareMatches).slice(0, MATCH_LIMIT)
}

/**
 * GET /api/monitoring/monitors/[id]/matches
 * Live saved-search: up to MATCH_LIMIT credentials currently matching this
 * monitor's domains, queried directly against ClickHouse. Independent of
 * webhooks/alerts — works even if the monitor has none configured.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const ip = getClientIP(request)
  const rlResult = checkLimit(matchesLimiter, ip, 30, 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many match queries — please wait a moment before retrying.' },
      {
        status: 429,
        headers: {
          'Retry-After':           String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit':     '30',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(rlResult.resetAt),
        },
      }
    )
  }

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const monitor = await getMonitor(monitorId)
  if (!monitor) {
    return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
  }

  // A blank entry would build `domain = ''`, matching every domain-less row.
  const domains = monitor.domains.map(d => d.toLowerCase().trim()).filter(Boolean)
  if (domains.length === 0) {
    return NextResponse.json({ success: true, results: [], total_shown: 0, new_count: 0, limited: false })
  }

  const userId = parseInt(user.userId)

  try {
    const candidates = await getCandidates(monitor.match_mode, domains)
    const { clause, params: domainParams } = buildDomainSetWhereClause(domains, monitor.match_mode)
    const candidateBranches = buildCandidateValueBranches(candidates.columns)

    let rows: MatchRow[]
    if (candidates.overflowed) {
      // The unpruned condition already covers the legacy bucket, so
      // candidates.legacyRows must NOT be merged in here — that would double
      // any row appearing in both.
      const page = await selectMatches(clause, domainParams, FALLBACK_MAX_EXECUTION_TIME, FALLBACK_ORDER_BY)
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
      rows = mergeMatchPages([...pages, candidates.legacyRows])
    }

    const results = await markMatchesNewSinceLastView(monitorId, userId, rows)
    const newCount = results.filter(r => r.is_new).length

    // KNOWN LIMITATION (accepted, not an oversight): this advances the
    // "last viewed" cursor to now for every match recorded up to this
    // moment, including matches that exist but fell outside the MATCH_LIMIT
    // rows above. Such a match can later read as not-new even though this
    // admin never actually saw it. Fixing it properly means replacing the
    // time cursor with a row-level monitor_credential_shown(monitor_id,
    // user_id, fingerprint) ledger — a data-model change deliberately out of
    // scope here.
    await recordMonitorViewed(monitorId, userId)

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: newCount,
      limited: results.length === MATCH_LIMIT,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const isTimeout = msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')

    if (isTimeout) {
      // timeout_overflow_mode=throw: return a structured timeout response so
      // the dialog can say what happened instead of rendering an empty state
      // that reads as an authoritative "nothing matches".
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Match search timed out — this monitor watches a domain set too broad to scan. Narrow its domains, or browse a single domain in Credentials.',
        results:   [],
      }, { status: 408 })
    }

    console.error('Monitor matches query error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
