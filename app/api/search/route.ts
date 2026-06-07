import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS } from "@/lib/ulp-normalize"
import { SORT_MAP, type SortKey, encodeCursor, decodeCursor, buildCursorWhere } from "@/lib/cursor-pagination"

export const dynamic = 'force-dynamic'

const SELECT = `${NORM_COLS},
                source_file, breach_name,
                country_tier, login_type, password_length, password_mask,
                url_scheme, is_corporate_email, email_domain,
                url_host, password_entropy_band, imported_at`

// Valid password mask values — used to sanitize the pw_mask query param so it
// can be safely interpolated into SQL without a parameterised placeholder.
const VALID_MASKS = new Set(['alpha', 'numeric', 'alphanumeric', 'mixed', 'empty'])


export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const q           = searchParams.get('q')           || ''
  const breach      = searchParams.get('breach')      || ''
  const tierInclude = searchParams.get('tier_include') || ''
  const tierExclude = searchParams.get('tier_exclude') || ''
  const loginType   = searchParams.get('login_type')  || ''
  const cursorToken = searchParams.get('cursor') || ''
  const limit       = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '50')))

  // Filters
  const pwMaskRaw   = searchParams.get('pw_mask')      || ''
  const urlScheme   = searchParams.get('url_scheme')   || ''
  const isCorporate = searchParams.get('is_corporate') || ''
  const pwLenMin    = searchParams.get('pw_len_min') ? parseInt(searchParams.get('pw_len_min')!) : null
  const pwLenMax    = searchParams.get('pw_len_max') ? parseInt(searchParams.get('pw_len_max')!) : null
  const dateFrom    = searchParams.get('date_from') || ''
  const dateTo      = searchParams.get('date_to')   || ''
  const emailDomain = searchParams.get('email_domain') || ''
  const sourceFile  = searchParams.get('source_file')  || ''
  const regexMode   = searchParams.get('regex') === '1'

  // Sort: whitelist-validated to prevent injection
  const sortKey     = searchParams.get('sort') || 'imported_desc'
  const orderBy     = SORT_MAP[sortKey as SortKey] ?? SORT_MAP['imported_desc']

  // Sanitise password mask — only allow known values
  const pwMasks = pwMaskRaw
    .split(',')
    .map(m => m.trim())
    .filter(m => VALID_MASKS.has(m))

  // Require at least one filter
  const hasFilter = q.trim() || breach || tierInclude || tierExclude || loginType ||
                    pwMasks.length || urlScheme || isCorporate || pwLenMin !== null ||
                    pwLenMax !== null || dateFrom || dateTo || emailDomain || sourceFile
  if (!hasFilter) {
    return NextResponse.json({ success: true, results: [], total: 0, next_cursor: null, query: '' })
  }

  const { include: incTiers, exclude: excTiers } = parseTierParams(tierInclude, tierExclude)
  const loginTypes = parseLoginTypeParam(loginType)

  // Core search clause
  const tokens = parseULPQuery(q)
  const { clause, params: baseParams } = regexMode
    ? buildULPWhereRegex(tokens)
    : buildULPWhere(tokens)

  // Extra WHERE fragments
  const extras: string[] = []
  const mergedParams: Record<string, unknown> = { ...baseParams, limit }

  if (breach)      { extras.push(' AND breach_name = {breachFilter:String}');   mergedParams.breachFilter = breach }
  if (emailDomain) { extras.push(' AND email_domain = {emailDomain:String}');   mergedParams.emailDomain = emailDomain.toLowerCase() }
  if (urlScheme)   { extras.push(' AND url_scheme = {urlScheme:String}');        mergedParams.urlScheme = urlScheme }
  if (sourceFile)  { extras.push(' AND source_file = {sourceFile:String}');      mergedParams.sourceFile = sourceFile }
  if (isCorporate === '1') extras.push(' AND is_corporate_email = 1')
  if (pwLenMin !== null) { extras.push(' AND password_length >= {pwLenMin:UInt8}'); mergedParams.pwLenMin = pwLenMin }
  if (pwLenMax !== null) { extras.push(' AND password_length <= {pwLenMax:UInt8}'); mergedParams.pwLenMax = pwLenMax }
  if (dateFrom) { extras.push(' AND imported_at >= {dateFrom:DateTime}'); mergedParams.dateFrom = `${dateFrom} 00:00:00` }
  if (dateTo)   { extras.push(' AND imported_at <= {dateTo:DateTime}');   mergedParams.dateTo   = `${dateTo} 23:59:59` }

  // Password mask: already sanitised to known values — safe to interpolate
  if (pwMasks.length) {
    extras.push(` AND password_mask IN (${pwMasks.map(m => `'${m}'`).join(',')})`)
  }

  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const allExtras      = extras.join('') + tierExtra + loginTypeExtra

  // Cursor values compare against raw storage columns. Safe because all data-repair
  // mutations are done — raw columns match normalized values for all rows.
  let cursorClause = ''
  let cursorParams: Record<string, unknown> = {}

  if (cursorToken) {
    const cur = decodeCursor(cursorToken)
    if (cur && cur.sort === sortKey) {
      const { clause: cc, params: cp } = buildCursorWhere(sortKey as SortKey, cur)
      cursorClause = ` AND ${cc}`
      cursorParams = cp
    }
  }

  const allParams = { ...mergedParams, ...cursorParams }

  try {
    const t0 = Date.now()
    const [countResult, rows] = await Promise.all([
      executeQuery(
        `SELECT count() AS total FROM ulp.credentials WHERE ${clause}${allExtras}
         SETTINGS optimize_trivial_count_query = 1,
                  max_execution_time = 300,
                  timeout_overflow_mode = 'break'`,
        mergedParams
      ),
      executeQuery(
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${clause}${allExtras}${cursorClause}
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
      success:           true,
      results:           rows,
      total,
      next_cursor:       nextCursor,
      query:             q,
      query_ms,
      timed_out,
      sort:              sortKey,
      breach_filter:     breach,
      tier_include:      tierInclude,
      tier_exclude:      tierExclude,
      login_type_filter: loginType,
      regex_mode:        regexMode,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const isTimeout = msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')

    if (isTimeout) {
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — use an exact domain, email, or breach name for fast results at this data size.',
        results:   [],
        total:     0,
      }, { status: 408 })
    }

    console.error('Search error:', msg)
    return NextResponse.json({ success: false, error: 'Search failed' }, { status: 500 })
  }
}
