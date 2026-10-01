import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS } from "@/lib/ulp-normalize"
import { NOISE_FILTER } from "@/lib/ulp-noise"
import { dedupeLimitBy, dedupeCountExpr } from "@/lib/ulp-dedupe"
import { SORT_MAP, type SortKey, encodeCursor, decodeCursor, buildCursorWhere } from "@/lib/cursor-pagination"
import {
  DEFAULT_CREDENTIAL_LIMIT,
  DEFAULT_CREDENTIAL_SORT,
  MAX_CREDENTIAL_LIMIT,
} from "@/lib/credential-browse-defaults"

export const dynamic = 'force-dynamic'

// Valid password mask values — whitelisted so they can be safely interpolated.
const VALID_MASKS = new Set(['alpha', 'numeric', 'alphanumeric', 'mixed', 'empty'])


// Read by the inner query (see query site below) — deliberately raw url/email/
// password/domain, no NORM_COLS. NORM_COLS's nested-if correction (for ~38K
// legacy corrupted rows) is expensive enough per-row that including it here
// defeats proj_imported_desc: confirmed via force_optimize_projection=1 that
// the identical query WITH NORM_COLS inline gets PROJECTION_NOT_USED, while
// this raw-column form uses the projection successfully. Below the fold at
// 67M+ rows that difference is a full unindexed table scan vs. a bounded
// read — the former is what took production down with MEMORY_LIMIT_EXCEEDED
// (2026-07-04).
const RAW_COLS = `url, email, password, domain,
  source_file, breach_name,
  country_tier, login_type, password_length, password_mask,
  url_scheme, is_corporate_email, email_domain,
  url_host, password_entropy_band, imported_at`

// Outer SELECT — NORM_COLS applied to the inner query's already-bounded
// (LIMIT-sized) result, not to every scanned row. See RAW_COLS above.
const SELECT = `${NORM_COLS},
  source_file, breach_name,
  country_tier, login_type, password_length, password_mask,
  url_scheme, is_corporate_email, email_domain,
  url_host, password_entropy_band, imported_at`

// Confirmed live against ulp.credentials (2.4B+ rows, measured 2026-08-23/26 —
// see docs/superpowers/specs/2026-09-24-scale-audit-followups-design.md):
// with dedupe=1, any sort
// whose leading column isn't `domain` (the table's actual primary-key leading
// column — see ORDER BY (domain, email, imported_at)) hits MEMORY_LIMIT_EXCEEDED
// (code 241). ClickHouse's `ORDER BY ... LIMIT 1 BY <key> ... LIMIT n` can't
// bound the sort to the primary key or to proj_imported_desc once LIMIT BY is
// present, so it fully materializes and sorts the filtered set first,
// regardless of the final LIMIT or how many ORDER BY tiebreaker columns exist
// (tested — extra columns do not help). domain-leading sorts (domain_asc/desc)
// stay safe and don't need this. Forcing an external (disk-spill) sort past
// this threshold converts the crash into a slower (~16-30s) but successful
// query instead. (At 1.39B rows that stopped being enough -- the sort + LIMIT BY
// read 1.22B rows and hit the 300 s cap -- so the Unique view now de-duplicates
// inside a bounded top-N window instead; see DEDUPE_WINDOW_FACTOR below.)
const SORT_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

// Unique view + a sort whose leading column is NOT `domain`: `ORDER BY ... LIMIT 1 BY
// content_key_hash LIMIT n` makes ClickHouse sort and de-duplicate the whole filtered set
// before the final LIMIT (read 1.22B rows, 9.8 GiB, and hit the 300 s cap on the 1.39B-row table,
// measured 2026-09-30), although the same query without LIMIT BY is a streaming top-N that
// finishes in ~40 s. So those sorts take the top DEDUPE_WINDOW_FACTOR * n rows first and
// collapse duplicates inside that window -- the same "dupes are collapsed within each page
// window" semantics lib/ulp-dedupe.ts documents; ulp.credentials is already de-duplicated at rest
// by lib/content-dedup.ts, so a window this size yields a full page. (domain-leading sorts read
// in primary-key order and stay on the plain form.)
const DEDUPE_WINDOW_FACTOR = 3

/**
 * GET /api/credentials — browse all credentials with pagination, filtering, and sorting.
 *
 * Query params:
 *   cursor        string    opaque pagination token (absent = first page)
 *   limit         number    (default 200, max 200)
 *   q             string    text search (indexed — hasToken / bloom-filter, NOT LIKE)
 *   regex         '1'       treat q as RE2 regex
 *   sort          string    see SORT_MAP keys (default domain_asc)
 *   domain        string    exact domain match
 *   breach        string    exact breach_name match
 *   source_file   string    exact source_file match
 *   url_host      string    exact url_host match
 *   email_domain  string    exact email domain match
 *   login_type    string    comma-separated login types
 *   pw_mask       string    comma-separated password masks
 *   url_scheme    string    'http' | 'https'
 *   is_corporate  string    '1' = corporate emails only
 *   tier_include  string    comma-separated tiers to include
 *   tier_exclude  string    comma-separated tiers to exclude
 *   pw_len_min    number    minimum password length
 *   pw_len_max    number    maximum password length
 *   date_from     string    ISO date e.g. 2024-01-01
 *   date_to       string    ISO date e.g. 2024-12-31
 *   exclude_noise '1'       hide low-signal rows: IP-host / :port / .php / localhost URLs
 *   dedupe        '1'       collapse exact (url,email,password) duplicates (one row each)
 *   skip_totals   '1'       data query only: total / raw_total come back null
 *   totals_only   '1'       totals only (no rows): { total, raw_total, query_ms, timed_out }
 */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const sp = new URL(request.url).searchParams
  const cursorToken = sp.get('cursor') || ''
  const limit = Math.min(
    MAX_CREDENTIAL_LIMIT,
    Math.max(1, parseInt(sp.get('limit') || String(DEFAULT_CREDENTIAL_LIMIT), 10)),
  )

  const q           = sp.get('q')            || ''
  const regex       = sp.get('regex')         === '1'
  const sortKey     = sp.get('sort') || DEFAULT_CREDENTIAL_SORT
  const domain      = sp.get('domain')        || ''
  const breach      = sp.get('breach')        || ''
  const sourceFile  = sp.get('source_file')   || ''
  const urlHost     = sp.get('url_host')      || ''
  const emailDomain = sp.get('email_domain')  || ''
  const loginType   = sp.get('login_type')    || ''
  const pwMaskRaw   = sp.get('pw_mask')       || ''
  const urlScheme   = sp.get('url_scheme')    || ''
  const isCorporate = sp.get('is_corporate')  || ''
  const pwLenMin    = sp.get('pw_len_min')  ? parseInt(sp.get('pw_len_min')!) : null
  const pwLenMax    = sp.get('pw_len_max')  ? parseInt(sp.get('pw_len_max')!) : null
  const dateFrom    = sp.get('date_from')     || ''
  const dateTo      = sp.get('date_to')       || ''
  const tierInclude = sp.get('tier_include')  || ''
  const tierExclude = sp.get('tier_exclude')  || ''
  // Declutter: hide low-signal rows (IP-host / :port / .php / localhost URLs).
  // Default-on in the UI, but absent param = off here so other API callers and
  // raw /api/credentials hits keep their existing (unfiltered) behavior.
  const excludeNoise = sp.get('exclude_noise') === '1'
  // Dedupe: collapse exact (url,email,password) duplicates in the view (one row
  // per unique credential). Default-on in the UI; absent param = off here.
  const dedupe = sp.get('dedupe') === '1'
  // skip_totals=1: run only the data query and return total/raw_total as null -- the Credentials page
  // asks for the totals separately (totals_only=1) so the table renders as soon as its rows are ready
  // instead of waiting for a whole-table count. totals_only=1: run only the totals, no data query.
  const skipTotals = sp.get('skip_totals') === '1'
  const totalsOnly = sp.get('totals_only') === '1'

  const orderBy    = SORT_MAP[sortKey as SortKey] ?? SORT_MAP['imported_desc']
  // See DEDUPE_WINDOW_FACTOR: Unique + a non-domain-leading sort de-duplicates inside a bounded window.
  const dedupeInWindow = dedupe && !/^domain\b/.test(orderBy)
  const { include: incTiers, exclude: excTiers } = parseTierParams(tierInclude, tierExclude)
  const loginTypes = parseLoginTypeParam(loginType)
  const pwMasks    = pwMaskRaw.split(',').map(m => m.trim()).filter(m => VALID_MASKS.has(m))

  // ── WHERE clause ─────────────────────────────────────────────────────────────
  const conditions: string[] = ['1=1']
  const params: Record<string, unknown> = { limit }

  // Text search: uses hasToken() / bloom-filter indexes — NOT a LIKE full scan
  if (q.trim()) {
    const tokens = parseULPQuery(q.trim())
    const { clause: qClause, params: qParams } = regex
      ? buildULPWhereRegex(tokens)
      : buildULPWhere(tokens)
    conditions.push(`(${qClause})`)
    Object.assign(params, qParams)
  }

  // Raw column: mutations done, all domain/email values are corrected.
  // Querying raw columns uses the primary key index + bloom filters.
  if (domain)      { conditions.push('domain = {domain:String}'); params.domain = domain }
  if (breach)      { conditions.push('breach_name = {breach:String}');           params.breach = breach }
  if (sourceFile)  { conditions.push('source_file = {sourceFile:String}');       params.sourceFile = sourceFile }
  if (urlHost)     { conditions.push('url_host = {urlHost:String}');             params.urlHost = urlHost.toLowerCase() }
  if (emailDomain) { conditions.push('email_domain = {emailDomain:String}');     params.emailDomain = emailDomain.toLowerCase() }
  if (urlScheme)   { conditions.push('url_scheme = {urlScheme:String}');         params.urlScheme = urlScheme.toLowerCase() }
  if (isCorporate === '1') conditions.push('is_corporate_email = 1')
  if (pwLenMin !== null) { conditions.push('password_length >= {pwLenMin:UInt8}'); params.pwLenMin = pwLenMin }
  if (pwLenMax !== null) { conditions.push('password_length <= {pwLenMax:UInt8}'); params.pwLenMax = pwLenMax }
  if (dateFrom) { conditions.push('imported_at >= {dateFrom:DateTime}'); params.dateFrom = `${dateFrom} 00:00:00` }
  if (dateTo)   { conditions.push('imported_at <= {dateTo:DateTime}');   params.dateTo   = `${dateTo} 23:59:59` }
  if (pwMasks.length) {
    conditions.push(`password_mask IN (${pwMasks.map(m => `'${m}'`).join(',')})`)
  }
  // Captured before the noise filter below, so whereRaw (raw_total) reflects
  // "how many rows match your search" without the Declutter/Unique view-only
  // restrictions — see raw_total below.
  const conditionsRaw = [...conditions]

  // Non-destructive: hides the row from this result set, never deletes it.
  // Filters the precomputed is_noise column (cheap UInt8 → PREWHERE), NOT a
  // per-row function chain — see lib/ulp-noise.ts for why.
  if (excludeNoise) conditions.push(NOISE_FILTER)

  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const where    = conditions.join(' AND ') + tierExtra + loginTypeExtra
  const whereRaw = conditionsRaw.join(' AND ') + tierExtra + loginTypeExtra

  // Anything that narrows the result set. Declutter/Unique/sort/limit/cursor do not.
  // With no filter the Unique tally is a plain count() — see dedupeCountExpr.
  const hasUserFilter = conditionsRaw.length > 1 || tierExtra !== '' || loginTypeExtra !== ''

  // Cursor values are captured from result rows (which are normalized via NORM_COLS)
  // and compared against raw storage columns in buildCursorWhere. This is safe because
  // all data-repair mutations are done — raw columns match normalized values for all rows.
  // Verify with: SELECT countIf(is_done=0) FROM system.mutations WHERE table='credentials'
  let cursorClause = ''
  let cursorParams: Record<string, unknown> = {}

  if (cursorToken) {
    const cursor = decodeCursor(cursorToken)
    if (cursor && cursor.sort === sortKey) {
      const { clause, params: cp } = buildCursorWhere(sortKey as SortKey, cursor)
      cursorClause = ` AND ${clause}`
      cursorParams = cp
    }
  }

  const allParams = { ...params, ...cursorParams }

  try {
    const t0 = Date.now()

    // The total only changes when the result SET changes (new filters/sort), not
    // when paging through it. The first page is always cursor-less, so the totals run
    // there; on deeper cursor pages we skip them entirely (total = null) and the client
    // carries the page-1 total forward. At billions of rows a filtered search can
    // match tens of millions, and counting them has no LIMIT -- re-counting all of them on
    // every page turn is the single most expensive avoidable part of the request.
    const wantData   = !totalsOnly
    const wantTotals = totalsOnly || (!cursorToken && !skipTotals)

    // BOTH totals in ONE scan of the search predicate: `total` (the Declutter/Unique view) and `raw_total`
    // (the same search without those view-only restrictions, so the header can say "X of Y total imported"
    // instead of a bare filtered number that looks like missing data). They used to be two separate
    // scans of the same WHERE; measured cold on 1.39B rows for a domain-token search ("binance.com"):
    // 13.9 s + 32.6 s in parallel, 11.0 s as one query, identical numbers (1,233,798 / 1,232,511), and the
    // word token "ledger" 17.8 s -> 11.2 s.
    //
    // The WHERE is whereRaw (no noise condition) and the noise filter moves inside the aggregate
    // (uniqIf / countIf), which is exactly the old `WHERE ${where}` count. When deduping a filtered search,
    // total = distinct credentials via uniq() (HLL); with no filter it is a plain count() -- storage is
    // deduped at rest (see dedupeCountExpr for the measured cost and error bound).
    //
    // optimize_use_projections = 0 unless the search is bounded by a date range: otherwise the planner
    // takes proj_imported_desc as a "thin covering copy" and scans all of it -- 32.6 s against 11.0 s on
    // the base table, whose domain / url_host / email_domain columns are sorted and compress far better.
    // A date range is the one predicate that projection genuinely prunes, so it keeps the planner's choice.
    //
    // optimize_trivial_count_query: for WHERE-free queries ClickHouse reads the partition metadata instead
    // of scanning rows -- nearly instant. For filtered queries the setting is a no-op.
    // Count uses break so a partial count is returned rather than an error.
    // use_query_cache = 0: ClickHouse 26.x throws error 731 when use_query_cache=1
    // (active from the user profile) is combined with timeout_overflow_mode='break'.
    // Partial/timed-out counts must not be cached anyway -- they are not the real count.
    const totalsPromise: Promise<Array<{ total?: unknown; raw_total?: unknown }> | null> = !wantTotals
      ? Promise.resolve(null)
      : executeQuery(
          `SELECT ${dedupeCountExpr(dedupe, hasUserFilter, excludeNoise ? NOISE_FILTER : undefined)} AS total,
                  count() AS raw_total
           FROM ulp.credentials WHERE ${whereRaw}
           SETTINGS optimize_trivial_count_query = 1,
                    max_execution_time = 300,
                    timeout_overflow_mode = 'break',
                    use_query_cache = 0${dateFrom || dateTo ? '' : ',\n                    optimize_use_projections = 0'}`,
          params
        )

    const dataPromise: Promise<unknown[]> = !wantData
      ? Promise.resolve([])
      : executeQuery(
        // Data query uses throw so a timeout produces a clear error (caught below)
        // rather than silently returning 0 rows (timeout_overflow_mode=break with
        // ORDER BY does not flush the sort buffer — ClickHouse issue #52234).
        //
        // Split into an inner (raw columns, ORDER BY, LIMIT) and outer (NORM_COLS)
        // query — see RAW_COLS above for why. The inner query alone is what needs
        // to read in order via proj_imported_desc; wrapping NORM_COLS around it
        // instead of inlining it keeps that projection usable.
        dedupeInWindow
          ? `SELECT ${SELECT}
         FROM (
           SELECT ${RAW_COLS}
           FROM (
             SELECT ${RAW_COLS}, content_key_hash
             FROM ulp.credentials
             WHERE ${where}${cursorClause}
             ORDER BY ${orderBy}
             LIMIT {windowLimit:UInt32}
           )
           ORDER BY ${orderBy}
           ${dedupeLimitBy(true)}
           LIMIT {limit:UInt32}
         ) AS t
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw',
                  http_wait_end_of_query = 1,
                  max_bytes_before_external_sort = ${SORT_MAX_MEMORY_BYTES}`
          : `SELECT ${SELECT}
         FROM (
           SELECT ${RAW_COLS}
           FROM ulp.credentials
           WHERE ${where}${cursorClause}
           ORDER BY ${orderBy}
           ${dedupeLimitBy(dedupe)}
           LIMIT {limit:UInt32}
         ) AS t
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw',
                  http_wait_end_of_query = 1,
                  max_bytes_before_external_sort = ${SORT_MAX_MEMORY_BYTES}`,
        dedupeInWindow ? { ...allParams, windowLimit: limit * DEDUPE_WINDOW_FACTOR } : allParams
      ) as Promise<unknown[]>

    const [totalsResult, rows] = await Promise.all([totalsPromise, dataPromise])
    const query_ms = Date.now() - t0
    // null on cursor pages and with skip_totals (totals not computed) — the client keeps/fetches them separately.
    const total = totalsResult ? Number(totalsResult[0]?.total || 0) : null
    const raw_total = totalsResult ? Number(totalsResult[0]?.raw_total || 0) : null
    const timed_out = query_ms > 250_000

    if (totalsOnly) {
      return NextResponse.json({ success: true, total, raw_total, query_ms, timed_out })
    }

    const nextCursor = rows.length === limit
      ? encodeCursor(sortKey as SortKey, (rows as Record<string, unknown>[])[rows.length - 1])
      : null

    return NextResponse.json({
      success:     true,
      results:     rows,
      total,
      raw_total,
      next_cursor: nextCursor,
      query_ms,
      timed_out,
      sort:        sortKey,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const isTimeout = msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')

    if (isTimeout) {
      // timeout_overflow_mode=throw: return a structured timeout response so the
      // UI can show "query timed out" instead of crashing with a 500 error.
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — add a more specific filter (exact domain, email, or breach name) for faster results.',
        results:   [],
        total:     0,
      }, { status: 408 })
    }

    console.error('Credentials browse error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
