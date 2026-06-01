import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS, NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from "@/lib/ulp-normalize"

export const dynamic = 'force-dynamic'

// Valid password mask values — whitelisted so they can be safely interpolated.
const VALID_MASKS = new Set(['alpha', 'numeric', 'alphanumeric', 'mixed', 'empty'])

// Allowed ORDER BY expressions — prevents SQL injection via sort param.
//
// domain_asc/desc: must use NORM_DOMAIN_EXPR rather than the raw `domain` column.
//   ClickHouse resolves ORDER BY identifiers to the raw column first
//   (prefer_column_name_to_alias = 1 by default), so `ORDER BY domain` sorts by
//   the un-normalised stored value even though SELECT displays the NORM_COLS alias.
//   Corrupted rows (Case A jsessionid, Case C scheme-split, Case D blank-tab)
//   have wrong raw domain values (e.g. 'jsessionid', 'https', '').
//
//   The (expr='') ASC prefix pushes email-only credentials (no domain) to the
//   bottom of BOTH sort directions so real domains fill the visible pages.
//
// email_asc/desc: same logic — sort by NORM_EMAIL_EXPR to handle corrupted rows.
const SORT_MAP: Record<string, string> = {
  imported_desc: 'imported_at DESC',
  imported_asc:  'imported_at ASC',
  domain_asc:    `(${NORM_DOMAIN_EXPR}='') ASC, ${NORM_DOMAIN_EXPR} ASC, imported_at DESC`,
  domain_desc:   `(${NORM_DOMAIN_EXPR}='') ASC, ${NORM_DOMAIN_EXPR} DESC, imported_at DESC`,
  email_asc:     `${NORM_EMAIL_EXPR} ASC, imported_at DESC`,
  email_desc:    `${NORM_EMAIL_EXPR} DESC, imported_at DESC`,
  pw_len_desc:   'password_length DESC, imported_at DESC',
  pw_len_asc:    'password_length ASC, imported_at DESC',
}

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
  // Cap at page 2000 (max offset = 2000 × 200 = 400 000 rows).
  // Deep OFFSET scans over 100B+ rows are O(offset) even with primary-key
  // pruning.  Almost no legitimate use case goes beyond page ~50.
  const page  = Math.min(2_000, Math.max(1, parseInt(sp.get('page')  || '1')))
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50')))
  const offset = (page - 1) * limit

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

  const orderBy    = SORT_MAP[sortKey] ?? SORT_MAP['imported_desc']
  const { include: incTiers, exclude: excTiers } = parseTierParams(tierInclude, tierExclude)
  const loginTypes = parseLoginTypeParam(loginType)
  const pwMasks    = pwMaskRaw.split(',').map(m => m.trim()).filter(m => VALID_MASKS.has(m))

  // ── WHERE clause ─────────────────────────────────────────────────────────────
  const conditions: string[] = ['1=1']
  const params: Record<string, unknown> = { limit, offset }

  // Text search: uses hasToken() / bloom-filter indexes — NOT a LIKE full scan
  if (q.trim()) {
    const tokens = parseULPQuery(q.trim())
    const { clause: qClause, params: qParams } = regex
      ? buildULPWhereRegex(tokens)
      : buildULPWhere(tokens)
    conditions.push(`(${qClause})`)
    Object.assign(params, qParams)
  }

  if (domain)      { conditions.push(`(${NORM_DOMAIN_EXPR}) = {domain:String}`); params.domain = domain }
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

  try {
    const t0 = Date.now()
    const [countResult, rows] = await Promise.all([
      // optimize_trivial_count_query: for WHERE-free queries ClickHouse reads
      // the partition metadata instead of scanning rows — nearly instant.
      // For filtered queries the setting is a no-op and the WHERE runs normally.
      executeQuery(
        `SELECT count() AS total FROM ulp.credentials WHERE ${where}
         SETTINGS optimize_trivial_count_query = 1, max_execution_time = 240`,
        params
      ),
      executeQuery(
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 240`,
        // max_rows_to_sort removed: it caused ORDER BY queries to return 0 rows
        // when the sort buffer hit the cap before flushing (ClickHouse issue #52234).
        // timeout_overflow_mode=break (set in the server profile) still provides a
        // hard stop — the 240s limit is the correct guard at 1B+ row scale.
        params
      ),
    ])
    const query_ms = Date.now() - t0
    const total = Number(countResult[0]?.total || 0)
    // timed_out: query ran close to the limit — results may be incomplete.
    // count>0 + results=0 is the classic timeout_overflow_mode=break symptom with ORDER BY.
    const timed_out = query_ms > 200_000

    return NextResponse.json({
      success: true,
      results: rows,
      total,
      page,
      pages: Math.ceil(total / limit),
      query_ms,
      timed_out,
      sort: sortKey,
    })
  } catch (error) {
    console.error('Credentials browse error:', error)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
