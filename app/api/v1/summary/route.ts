/**
 * Summary API v1 - ULP Stats Endpoint
 * GET /api/v1/summary
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/summary')

  try {
    const [credStats, sourceStats, topDomains] = await Promise.all([
      executeQuery(`
        SELECT count() as total_credentials,
               countDistinct(domain) as total_domains,
               countDistinct(email) as unique_emails
        FROM ulp.credentials
      `),
      executeQuery(`SELECT count() as total_sources, sum(line_count) as total_lines FROM ulp.sources`),
      executeQuery(`
        SELECT domain, count() as count
        FROM ulp.credentials GROUP BY domain ORDER BY count DESC LIMIT 20
      `),
    ])

    const response = NextResponse.json({
      success: true,
      stats: {
        credentials: Number(credStats[0]?.total_credentials || 0),
        unique_domains: Number(credStats[0]?.total_domains || 0),
        unique_emails: Number(credStats[0]?.unique_emails || 0),
        sources: Number(sourceStats[0]?.total_sources || 0),
      },
      top_domains: topDomains,
    })

    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    console.error('v1 summary error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch summary' }, { status: 500 })
  }
}
