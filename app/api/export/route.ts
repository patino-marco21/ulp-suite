import { type NextRequest, NextResponse } from "next/server"
import { executeQuery, getClient } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS, NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from "@/lib/ulp-normalize"

export const dynamic = 'force-dynamic'

// Allowed ORDER BY expressions — mirrors search route whitelist
const SORT_MAP: Record<string, string> = {
  'imported_desc': 'imported_at DESC',
  'imported_asc':  'imported_at ASC',
  'domain_asc':    'domain ASC, imported_at DESC',
  'domain_desc':   'domain DESC, imported_at DESC',
  'email_asc':     'email ASC',
  'pw_len_desc':   'password_length DESC',
  'pw_len_asc':    'password_length ASC',
}

// GET /api/export?format=wordlist&tier_include=T1
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const sp          = new URL(request.url).searchParams
  const format      = sp.get('format')
  const domain      = sp.get('domain')       || ''
  const tierInclude = sp.get('tier_include') || ''
  const tierExclude = sp.get('tier_exclude') || ''
  const loginType   = sp.get('login_type')   || ''

  const { include: incTiers, exclude: excTiers } = parseTierParams(tierInclude, tierExclude)
  const loginTypes = parseLoginTypeParam(loginType)

  if (format === 'wordlist') return streamWordlist(incTiers, excTiers, loginTypes)
  if (format === 'spray')    return streamSprayList('', domain, '', incTiers, excTiers, loginTypes)

  return NextResponse.json({ success: false, error: "Use POST for other formats" }, { status: 400 })
}

// POST /api/export
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const {
    format       = 'csv',
    query        = '',
    domain       = '',
    breach_name  = '',
    tier_include = '',
    tier_exclude = '',
    login_type   = '',
    // New filter params
    pw_mask      = '',
    url_scheme   = '',
    is_corporate = '',
    pw_len_min   = null,
    pw_len_max   = null,
    date_from    = '',
    date_to      = '',
    email_domain = '',
    source_file  = '',
    sort         = 'imported_desc',
    regex_mode   = false,
  } = await request.json()

  const { include: incTiers, exclude: excTiers } = parseTierParams(tier_include, tier_exclude)
  const loginTypes = parseLoginTypeParam(login_type)

  if (format === 'wordlist') return streamWordlist(incTiers, excTiers, loginTypes)
  if (format === 'spray')    return streamSprayList(query, domain, breach_name, incTiers, excTiers, loginTypes, { pw_mask, url_scheme, is_corporate, pw_len_min, pw_len_max, date_from, date_to, email_domain, regex_mode })

  // Build WHERE for non-streaming formats
  const tokens = parseULPQuery(query)
  const { clause, params: baseParams } = regex_mode
    ? buildULPWhereRegex(tokens)
    : buildULPWhere(tokens)

  const extras: string[] = []
  const mergedParams: Record<string, unknown> = { ...baseParams }

  if (domain)      { extras.push(' AND domain = {exportDomain:String}');     mergedParams.exportDomain = domain }
  if (breach_name) { extras.push(' AND breach_name = {exportBreach:String}'); mergedParams.exportBreach = breach_name }
  if (email_domain){ extras.push(' AND email_domain = {emailDomain:String}'); mergedParams.emailDomain = email_domain.toLowerCase() }
  if (source_file) { extras.push(' AND source_file = {sourceFile:String}');  mergedParams.sourceFile = source_file }
  if (url_scheme)  { extras.push(' AND url_scheme = {urlScheme:String}');     mergedParams.urlScheme = url_scheme }
  if (is_corporate === '1' || is_corporate === true) extras.push(' AND is_corporate_email = 1')
  if (pw_len_min !== null) { extras.push(' AND password_length >= {pwLenMin:UInt8}'); mergedParams.pwLenMin = pw_len_min }
  if (pw_len_max !== null) { extras.push(' AND password_length <= {pwLenMax:UInt8}'); mergedParams.pwLenMax = pw_len_max }
  if (date_from) { extras.push(' AND imported_at >= {dateFrom:DateTime}'); mergedParams.dateFrom = `${date_from} 00:00:00` }
  if (date_to)   { extras.push(' AND imported_at <= {dateTo:DateTime}');   mergedParams.dateTo   = `${date_to} 23:59:59` }
  if (pw_mask) {
    const masks = String(pw_mask).split(',').map(m => `'${m.trim()}'`).filter(Boolean)
    if (masks.length) extras.push(` AND password_mask IN (${masks.join(',')})`)
  }

  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const allExtras      = extras.join('') + tierExtra + loginTypeExtra

  // For hcmask, we only need passwords — handled specially
  if (format === 'hcmask') {
    return exportHcmask(clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes)
  }

  // For emails-only and domains-only — dedicated streaming-friendly queries
  if (format === 'emails') {
    return streamUniqueList('email', clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes)
  }
  if (format === 'domains') {
    return streamUniqueList('domain', clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes)
  }

  try {
    const orderBy = SORT_MAP[sort] ?? SORT_MAP['imported_desc']
    const rows = await executeQuery(
      `SELECT ${NORM_COLS},
              source_file, breach_name,
              country_tier, login_type, password_length, password_mask,
              url_scheme, is_corporate_email, email_domain,
              url_host, password_entropy_band, imported_at
       FROM ulp.credentials
       WHERE ${clause}${allExtras}
       ORDER BY ${orderBy}
       LIMIT 10000`,
      mergedParams
    ) as Array<Record<string, string>>

    let content: string
    let contentType: string
    let ext: string

    if (format === 'json') {
      content = JSON.stringify(rows, null, 2)
      contentType = 'application/json'
      ext = 'json'
    } else if (format === 'ndjson') {
      content = rows.map(r => JSON.stringify(r)).join('\n')
      contentType = 'application/x-ndjson'
      ext = 'ndjson'
    } else if (format === 'csv') {
      const csvEscape = (s: string) => `"${String(s).replace(/"/g, '""')}"`
      content = 'url,email,password,domain,source_file,breach_name,country_tier,login_type,password_length,password_mask,url_scheme,is_corporate_email,email_domain,url_host,password_entropy_band,imported_at\n' +
        rows.map(r => [
          r.url, r.email, r.password, r.domain, r.source_file, r.breach_name,
          r.country_tier, r.login_type, r.password_length, r.password_mask,
          r.url_scheme, r.is_corporate_email, r.email_domain,
          r.url_host, r.password_entropy_band, r.imported_at,
        ].map(csvEscape).join(',')).join('\n')
      contentType = 'text/csv'
      ext = 'csv'
    } else if (format === 'userpass') {
      content = rows.map(r => `${r.email}:${r.password}`).join('\n')
      contentType = 'text/plain'
      ext = 'txt'
    } else {
      // ulp format: url:email:password
      content = rows.map(r => `${r.url}:${r.email}:${r.password}`).join('\n')
      contentType = 'text/plain'
      ext = 'txt'
    }

    const base = buildFilenameBase(breach_name, domain, incTiers, excTiers, loginTypes)
    return new NextResponse(content, {
      headers: {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${base}.${ext}"`,
      },
    })
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json({ success: false, error: 'Export failed' }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashcat .hcmask export
// ─────────────────────────────────────────────────────────────────────────────

function toHcMask(password: string): string {
  return Array.from(password).map(c => {
    if (/[A-Z]/.test(c)) return '?u'
    if (/[a-z]/.test(c)) return '?l'
    if (/[0-9]/.test(c)) return '?d'
    return '?s'
  }).join('')
}

async function exportHcmask(
  clause: string, allExtras: string, mergedParams: Record<string, unknown>,
  breach_name: string, domain: string, incTiers: string[], excTiers: string[], loginTypes: string[],
): Promise<NextResponse> {
  try {
    const rows = await executeQuery(
      `SELECT password, count() AS freq
       FROM ulp.credentials
       WHERE ${clause}${allExtras} AND length(password) > 0
       GROUP BY password
       ORDER BY freq DESC
       LIMIT 2000`,
      mergedParams
    ) as Array<{ password: string; freq: string }>

    // Compute mask for each password, weighted by frequency
    const maskFreq = new Map<string, number>()
    for (const row of rows) {
      const mask = toHcMask(row.password)
      if (mask) maskFreq.set(mask, (maskFreq.get(mask) || 0) + Number(row.freq))
    }

    // Sort by frequency descending
    const sorted = [...maskFreq.entries()].sort((a, b) => b[1] - a[1])
    const total = sorted.reduce((s, [, n]) => s + n, 0)

    const lines = [
      `# Hashcat mask file generated from ULP credential data`,
      `# Generated: ${new Date().toISOString()}`,
      `# Masks: ${sorted.length} | Passwords sampled: ${rows.length} | Total covered: ${total.toLocaleString()}`,
      `# Format: mask  (sorted by frequency)`,
      ...sorted.map(([mask]) => mask),
    ]

    const base = buildFilenameBase(breach_name, domain, incTiers, excTiers, loginTypes)
    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.hcmask"`,
      },
    })
  } catch (_error) {
    return NextResponse.json({ success: false, error: 'hcmask export failed' }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream unique field values (email-only / domain-only lists)
// ─────────────────────────────────────────────────────────────────────────────

function streamUniqueList(
  field: 'email' | 'domain',
  clause: string, allExtras: string, mergedParams: Record<string, unknown>,
  breach_name: string, domain: string, incTiers: string[], excTiers: string[], loginTypes: string[],
): NextResponse {
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const chClient = getClient()
        const normExpr = field === 'email' ? NORM_EMAIL_EXPR
                       : field === 'domain' ? NORM_DOMAIN_EXPR
                       : field
        const resultSet = await chClient.query({
          query: `SELECT DISTINCT ${normExpr} AS ${field}
                  FROM ulp.credentials
                  WHERE ${clause}${allExtras} AND ${normExpr} != ''
                  ORDER BY ${field}`,
          query_params: mergedParams,
          format: 'JSONEachRow',
        })
        const stream = resultSet.stream<Record<string, string>>()
        for await (const rows of stream) {
          for (const row of rows) {
            const val = row.json()[field]
            if (val) controller.enqueue(encoder.encode(val + '\n'))
          }
        }
      } catch (err) { controller.error(err); return }
      controller.close()
    },
  })

  const base = buildFilenameBase(breach_name, domain, incTiers, excTiers, loginTypes)
  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${base}-${field}s.txt"`,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream: password wordlist (sorted by frequency)
// ─────────────────────────────────────────────────────────────────────────────

function streamWordlist(incTiers: string[], excTiers: string[], loginTypes: string[]): NextResponse {
  const encoder        = new TextEncoder()
  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const where          = tierExtra || loginTypeExtra
    ? `WHERE 1=1${tierExtra}${loginTypeExtra}`
    : ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const chClient = getClient()
        const resultSet = await chClient.query({
          query: `SELECT password, count() AS freq FROM ulp.credentials ${where} GROUP BY password ORDER BY freq DESC`,
          format: 'JSONEachRow',
        })
        const stream = resultSet.stream<{ password: string; freq: string }>()
        for await (const rows of stream) {
          for (const row of rows) {
            const { password } = row.json()
            controller.enqueue(encoder.encode(password + '\n'))
          }
        }
      } catch (err) { controller.error(err); return }
      controller.close()
    },
  })

  const suffix = buildFilenameBase('', '', incTiers, excTiers, loginTypes).replace('ulp-export', '')
  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="wordlist${suffix}.txt"`,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream: credential spray list (unique usernames / email local-parts)
// ─────────────────────────────────────────────────────────────────────────────

function streamSprayList(
  query: string, domain: string, breach_name: string,
  incTiers: string[], excTiers: string[], loginTypes: string[],
  _extra: Record<string, unknown> = {},
): NextResponse {
  const encoder        = new TextEncoder()
  const tokens         = parseULPQuery(query)
  const { clause, params } = buildULPWhere(tokens)
  const domainExtra    = domain      ? ' AND domain = {sprayDomain:String}' : ''
  const breachExtra    = breach_name ? ' AND breach_name = {sprayBreach:String}' : ''
  const tierExtra      = tierWhereMulti(incTiers, excTiers)
  const loginTypeExtra = loginTypeWhere(loginTypes)
  const mergedParams: Record<string, unknown> = {
    ...params,
    ...(domain      ? { sprayDomain: domain }      : {}),
    ...(breach_name ? { sprayBreach: breach_name } : {}),
  }

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const chClient = getClient()
        const resultSet = await chClient.query({
          query: `SELECT DISTINCT arrayElement(splitByChar('@', email), 1) AS username
                  FROM ulp.credentials
                  WHERE ${clause}${domainExtra}${breachExtra}${tierExtra}${loginTypeExtra}
                  ORDER BY username`,
          query_params: mergedParams,
          format: 'JSONEachRow',
        })
        const stream = resultSet.stream<{ username: string }>()
        for await (const rows of stream) {
          for (const row of rows) {
            const { username } = row.json()
            if (username) controller.enqueue(encoder.encode(username + '\n'))
          }
        }
      } catch (err) { controller.error(err); return }
      controller.close()
    },
  })

  const base = buildFilenameBase(breach_name, domain, incTiers, excTiers, loginTypes)
  const filename = domain ? `spray-${base}.txt` : `spray-list${base.replace('ulp-export', '')}.txt`
  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Filename helper
// ─────────────────────────────────────────────────────────────────────────────

function buildFilenameBase(
  breach_name: string, domain: string,
  incTiers: string[], excTiers: string[], loginTypes: string[],
): string {
  const tierTag = incTiers.length
    ? `-${incTiers.map(t => t.toLowerCase()).join('')}`
    : excTiers.length
      ? `-excl${excTiers.map(t => t.toLowerCase()).join('')}`
      : ''
  const ltTag = loginTypes.length ? `-${loginTypes.join('+')}` : ''
  if (breach_name) return `breach-${breach_name}${tierTag}${ltTag}`
  if (domain)      return `ulp-export-${domain}${tierTag}${ltTag}`
  return `ulp-export${tierTag}${ltTag}`
}
