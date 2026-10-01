/**
 * Summary API v1 - ULP Stats Endpoint
 * GET /api/v1/summary
 *
 * Table-wide totals and the top 20 domains. The numbers come from lib/v1-summary.ts: they are
 * computed in the background at most every 10 minutes (`as_of` says when), and `unique_domains` /
 * `unique_emails` are estimates (see `approximate`). Counting them exactly exhausts ClickHouse's
 * memory cap at this table's size.
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { getSummary, SUMMARY_APPROXIMATE_FIELDS } from "@/lib/v1-summary"

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/summary')

  try {
    const { summary, stale } = await getSummary()

    const response = NextResponse.json({
      success: true,
      stats: summary.stats,
      top_domains: summary.top_domains,
      as_of: summary.as_of,
      stale,
      approximate: SUMMARY_APPROXIMATE_FIELDS,
    })

    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    console.error('v1 summary error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch summary' }, { status: 500 })
  }
}
