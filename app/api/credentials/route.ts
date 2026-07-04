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

  const orderBy    = SORT_MAP[sortKey as SortKey] ?? SORT_MAP['imported_desc']
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
  // Non-destructive: hides the row from this result set, never deletes it.
  // Filters the precomputed is_noise column (cheap UInt8 → PREWHERE), NOT a
  // per-row function chain — see lib/ulp-noise.ts for why.
  if (excludeNoise) conditions.push(NOISE_FILTER)

  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const where = conditions.join(' AND ') + tierExtra + loginTypeExtra

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
    // when paging through it. The first page is always cursor-less, so count() runs
    // there; on deeper cursor pages we skip it entirely (total = null) and the client
    // carries the page-1 total forward. At billions of rows a filtered search can
    // match tens of millions, and count() has no LIMIT — re-counting all of them on
    // every page turn is the single most expensive avoidable part of the request.
    const countPromise: Promise<Array<{ total?: unknown }> | null> = cursorToken
      ? Promise.resolve(null)
      // optimize_trivial_count_query: for WHERE-free queries ClickHouse reads
      // the partition metadata instead of scanning rows — nearly instant.
      // For filtered queries the setting is a no-op and the WHERE runs normally.
      // Count uses break so a partial count is returned rather than an error.
      // use_query_cache = 0: ClickHouse 26.x throws error 731 when use_query_cache=1
      // (active from the user profile) is combined with timeout_overflow_mode='break'.
      // Partial/timed-out counts must not be cached anyway — they are not the real count.
      : executeQuery(
          // When deduping, total = distinct credentials via uniq() (HLL, cheap).
          `SELECT ${dedupeCountExpr(dedupe)} AS total FROM ulp.credentials WHERE ${where}
           SETTINGS optimize_trivial_count_query = 1,
                    max_execution_time = 300,
                    timeout_overflow_mode = 'break',
                    use_query_cache = 0`,
          params
        )

    const [countResult, rows] = await Promise.all([
      countPromise,
      executeQuery(
        // Data query uses throw so a timeout produces a clear error (caught below)
        // rather than silently returning 0 rows (timeout_overflow_mode=break with
        // ORDER BY does not flush the sort buffer — ClickHouse issue #52234).
        //
        // Split into an inner (raw columns, ORDER BY, LIMIT) and outer (NORM_COLS)
        // query — see RAW_COLS above for why. The inner query alone is what needs
        // to read in order via proj_imported_desc; wrapping NORM_COLS around it
        // instead of inlining it keeps that projection usable.
        `SELECT ${SELECT}
         FROM (
           SELECT ${RAW_COLS}
           FROM ulp.credentials
           WHERE ${where}${cursorClause}
           ORDER BY ${orderBy}
           ${dedupeLimitBy(dedupe)}
           LIMIT {limit:UInt32}
         ) AS t
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
        allParams
      ),
    ])
    const query_ms = Date.now() - t0
    // null on cursor pages (count skipped above) — the client keeps the page-1 total.
    const total = countResult ? Number(countResult[0]?.total || 0) : null
    const timed_out = query_ms > 250_000

    const nextCursor = (rows as unknown[]).length === limit
      ? encodeCursor(sortKey as SortKey, (rows as Record<string, unknown>[])[rows.length - 1])
      : null

    return NextResponse.json({
      success:     true,
      results:     rows,
      total,
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
