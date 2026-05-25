/**
 * Search API v1 - ULP Credentials Search
 * GET /api/v1/search/credentials?q=<query>&page=1&limit=100
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { parseULPQuery, buildULPWhere } from "@/lib/ulp-search"

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/search/credentials')

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '100')))
  const offset = (page - 1) * limit

  if (!q.trim()) {
    const response = NextResponse.json({ success: true, results: [], total: 0, page: 1, pages: 0 })
    return addRateLimitHeaders(response, authResult.rateLimit)
  }

  try {
    const { clause, params } = buildULPWhere(parseULPQuery(q))

    const [countResult, rows] = await Promise.all([
      executeQuery(`SELECT count() as total FROM ulp.credentials WHERE ${clause}`, params),
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE ${clause}
         ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        { ...params, limit, offset }
      ),
    ])

    const total = Number(countResult[0]?.total || 0)
    const response = NextResponse.json({
      success: true,
      results: rows,
      total,
      page,
      pages: Math.ceil(total / limit),
      query: q,
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    console.error('v1 search error:', error)
    return NextResponse.json({ success: false, error: 'Search failed' }, { status: 500 })
  }
}
