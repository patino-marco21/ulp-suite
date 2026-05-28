/**
 * Quick Lookup API v1
 * GET /api/v1/lookup?email=john@example.com
 * GET /api/v1/lookup?domain=example.com
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/lookup')

  const { searchParams } = new URL(request.url)
  const email = searchParams.get('email') || ''
  const domain = searchParams.get('domain') || ''

  if (!email && !domain) {
    return NextResponse.json({ success: false, error: 'Provide email or domain parameter' }, { status: 400 })
  }

  try {
    let results: any[]

    if (email) {
      results = await executeQuery(
        `SELECT url, email, domain, source_file, imported_at
         FROM ulp.credentials
         WHERE (${NORM_EMAIL_EXPR}) = {email:String}
         ORDER BY imported_at DESC LIMIT 100`,
        { email }
      )
      const response = NextResponse.json({
        success: true,
        found: results.length > 0,
        email,
        count: results.length,
        results,
      })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    results = await executeQuery(
      `SELECT url, email, domain, source_file, imported_at
       FROM ulp.credentials
       WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
       ORDER BY imported_at DESC LIMIT 100`,
      { domain }
    )
    const response = NextResponse.json({
      success: true,
      found: results.length > 0,
      domain,
      count: results.length,
      results,
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    console.error('v1 lookup error:', error)
    return NextResponse.json({ success: false, error: 'Lookup failed' }, { status: 500 })
  }
}
