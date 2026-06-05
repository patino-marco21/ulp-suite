/**
 * Search API v1 - Domain Search
 * GET /api/v1/search/domain?domain=example.com&page=1&limit=100
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/search/domain')

  const { searchParams } = new URL(request.url)
  const domain = (searchParams.get('domain') || '').toLowerCase().trim()
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '100')))
  const offset = (page - 1) * limit

  if (!domain) {
    return NextResponse.json({ success: false, error: 'domain parameter is required' }, { status: 400 })
  }

  try {
    // Raw domain column: all data-repair mutations done, bloom_filter index used.
    const [countResult, rows] = await Promise.all([
      executeQuery(
        `SELECT count() as total FROM ulp.credentials WHERE domain = {domain:String}
         SETTINGS optimize_trivial_count_query = 1, max_execution_time = 30, timeout_overflow_mode = 'break'`,
        { domain }
      ),
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE domain = {domain:String}
         ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw'`,
        { domain, limit, offset }
      ),
    ])

    const total = Number(countResult[0]?.total || 0)
    const response = NextResponse.json({ success: true, domain, results: rows, total, page, pages: Math.ceil(total / limit) })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout')) {
      return NextResponse.json({ success: false, timed_out: true, error: 'Query timed out — domain may have too many results, try adding a breach or date filter' }, { status: 408 })
    }
    console.error('v1 domain search error:', msg)
    return NextResponse.json({ success: false, error: 'Domain search failed' }, { status: 500 })
  }
}
