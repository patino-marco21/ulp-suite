/**
 * Password lookup API v1
 * POST /api/v1/lookup/password   { "password": "...", "type": "email", "limit": 100, "domain": "example.com" }
 *
 * The logins that use exactly this password (case-sensitive), one row per login with how many sites and which (up to 5) it was seen on. "type" is
 * email (default), username, phone or any; "domain" narrows to one site. A POST body, not a query string, so the password stays out of URLs and access logs;
 * it is never logged or returned. The scan reads at most 100,000 matching rows: a more common password answers from the first rows in domain order and says
 * "partial": true (narrow it with "domain"). An exact match is pruned by the bloom filter on password, so a rare password answers in well under a second.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from '@/lib/api-key-auth'
import { executeQuery } from '@/lib/clickhouse'
import { lookupPassword, parsePasswordLookup } from '@/lib/login-association'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/lookup/password')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'The request body must be valid JSON' }, { status: 400 })
  }
  const parsed = parsePasswordLookup(body)
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })

  try {
    const out = await lookupPassword(parsed.lookup, (sql, params) => executeQuery(sql, params))
    return addRateLimitHeaders(
      NextResponse.json({
        success: true,
        count: out.results.length,
        has_more: out.hasMore,
        partial: out.partial,
        results: out.results.map(r => ({ login: r.login, login_type: r.loginType, sites: r.sites, domains: r.domains, rows: r.rows })),
      }),
      authResult.rateLimit,
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/TIMEOUT_EXCEEDED|timeout/i.test(msg)) {
      return NextResponse.json({ success: false, timed_out: true, error: 'Query timed out: narrow it with the domain parameter' }, { status: 408 })
    }
    // The message can quote the query, and the query carries the password: log nothing from it.
    console.error('v1 lookup/password failed')
    return NextResponse.json({ success: false, error: 'Lookup failed' }, { status: 500 })
  }
}
