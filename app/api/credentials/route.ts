import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS } from "@/lib/ulp-normalize"
import { SORT_MAP, type SortKey, encodeCursor, decodeCursor, buildCursorWhere } from "@/lib/cursor-pagination"

export const dynamic = 'force-dynamic'

// Valid password mask values — whitelisted so they can be safely interpolated.
const VALID_MASKS = new Set(['alpha', 'numeric', 'alphanumeric', 'mixed', 'empty'])


const SELECT = `${NORM_COLS},
  source_file, breach_name,
  country_tier, login_type, password_length, password_mask,
  url_scheme, is_corporate_email, email_domain,
  url_host, password_entropy_band, imported_at`

/**
 * GET /api/credentials — browse all credentials with pagination, filtering, and sorting.
 *
 * Query params:
 *   page          number    (default 1)
 *   limit         number    (default 50, max 200)
 *   q             string    text search (indexed — hasToken / bloom-filter, NOT LIKE)
 *   regex         '1'       treat q as RE2 regex
 *   sort          string    see SORT_MAP keys (default imported_desc)
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
 */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const sp = new URL(request.url).searchParams
  const cursorToken = sp.get('cursor') || ''
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50')))

  const q           = sp.get('q')            || ''
  const regex       = sp.get('regex')         === '1'
  const sortKey     = sp.get('sort')          || 'imported_desc'
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

  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const where = conditions.join(' AND ') + tierExtra + loginTypeExtra

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
    const [countResult, rows] = await Promise.all([
      // optimize_trivial_count_query: for WHERE-free queries ClickHouse reads
      // the partition metadata instead of scanning rows — nearly instant.
      // For filtered queries the setting is a no-op and the WHERE runs normally.
      executeQuery(
        // Count uses break so a partial count is returned rather than an error.
        `SELECT count() AS total FROM ulp.credentials WHERE ${where}
         SETTINGS optimize_trivial_count_query = 1,
                  max_execution_time = 300,
                  timeout_overflow_mode = 'break'`,
        params
      ),
      executeQuery(
        // Data query uses throw so a timeout produces a clear error (caught below)
        // rather than silently returning 0 rows (timeout_overflow_mode=break with
        // ORDER BY does not flush the sort buffer — ClickHouse issue #52234).
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${where}${cursorClause}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
        allParams
      ),
    ])
    const query_ms = Date.now() - t0
    const total = Number(countResult[0]?.total || 0)
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
