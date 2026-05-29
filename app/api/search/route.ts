import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS, NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from "@/lib/ulp-normalize"

export const dynamic = 'force-dynamic'

const SELECT = `${NORM_COLS},
                source_file, breach_name,
                country_tier, login_type, password_length, password_mask,
                url_scheme, is_corporate_email, email_domain,
                url_host, password_entropy_band, imported_at`

// Valid password mask values — used to sanitize the pw_mask query param so it
// can be safely interpolated into SQL without a parameterised placeholder.
const VALID_MASKS = new Set(['alpha', 'numeric', 'alphanumeric', 'mixed', 'empty'])

// Allowed ORDER BY expressions (whitelist to prevent injection)
// Sort orders use a multi-column tiebreaker chain that terminates with (domain, email,
// url, password) — the most discriminating per-row combination available without a
// synthetic id column.  This ensures OFFSET pagination returns stable pages even when
// many rows share the same primary sort value (e.g. imported_at from a bulk batch, or
// empty email for username/phone logins).
const SORT_MAP: Record<string, string> = {
  'imported_desc': `imported_at DESC, ${NORM_DOMAIN_EXPR} ASC, ${NORM_EMAIL_EXPR} ASC, url ASC, password ASC`,
  'imported_asc':  `imported_at ASC,  ${NORM_DOMAIN_EXPR} ASC, ${NORM_EMAIL_EXPR} ASC, url ASC, password ASC`,
  'domain_asc':    `(${NORM_DOMAIN_EXPR}='') ASC, ${NORM_DOMAIN_EXPR} ASC,  ${NORM_EMAIL_EXPR} ASC, imported_at ASC, url ASC, password ASC`,
  'domain_desc':   `(${NORM_DOMAIN_EXPR}='') ASC, ${NORM_DOMAIN_EXPR} DESC, ${NORM_EMAIL_EXPR} ASC, imported_at ASC, url ASC, password ASC`,
  'email_asc':     `${NORM_EMAIL_EXPR} ASC,  ${NORM_DOMAIN_EXPR} ASC, imported_at ASC, url ASC, password ASC`,
  'pw_len_desc':   `password_length DESC, ${NORM_DOMAIN_EXPR} ASC, ${NORM_EMAIL_EXPR} ASC, imported_at ASC, url ASC`,
  'pw_len_asc':    `password_length ASC,  ${NORM_DOMAIN_EXPR} ASC, ${NORM_EMAIL_EXPR} ASC, imported_at ASC, url ASC`,
}

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
  // Cap at page 2000 (max offset = 2000 × 1000 = 2 000 000 rows).
  // Deep OFFSET over 100B+ rows is O(offset) — almost no use case needs page > 50.
  const page        = Math.min(2_000, Math.max(1, parseInt(searchParams.get('page')  || '1')))
  const limit       = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '50')))
  const offset      = (page - 1) * limit

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
  const orderBy     = SORT_MAP[sortKey] ?? SORT_MAP['imported_desc']

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
    return NextResponse.json({ success: true, results: [], total: 0, page: 1, pages: 0, query: '' })
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
  const mergedParams: Record<string, unknown> = { ...baseParams, limit, offset }

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

  try {
    const t0 = Date.now()
    const [countResult, rows] = await Promise.all([
      executeQuery(
        `SELECT count() AS total FROM ulp.credentials WHERE ${clause}${allExtras}
         SETTINGS optimize_trivial_count_query = 1, max_execution_time = 30`,
        mergedParams
      ),
      executeQuery(
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${clause}${allExtras}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 30`,
        mergedParams
      ),
    ])
    const query_ms = Date.now() - t0
    const total = Number(countResult[0]?.total || 0)

    return NextResponse.json({
      success:          true,
      results:          rows,
      total,
      page,
      pages:            Math.ceil(total / limit),
      query:            q,
      query_ms,
      sort:             sortKey,
      breach_filter:    breach,
      tier_include:     tierInclude,
      tier_exclude:     tierExclude,
      login_type_filter: loginType,
      regex_mode:       regexMode,
    })
  } catch (error) {
    console.error('Search error:', error)
    return NextResponse.json({ success: false, error: 'Search failed' }, { status: 500 })
  }
}
