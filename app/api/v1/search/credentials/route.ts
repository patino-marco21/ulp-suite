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
      // Count: break mode returns a partial count rather than throwing on timeout.
      executeQuery(
        `SELECT count() as total FROM ulp.credentials WHERE ${clause}
         SETTINGS optimize_trivial_count_query = 1,
                  max_execution_time = 300,
                  timeout_overflow_mode = 'break'`,
        params
      ),
      // Data: throw mode on timeout so we return a 408 instead of silent 0 rows
      // (timeout_overflow_mode=break with ORDER BY does not flush sort buffer —
      // ClickHouse issue #52234).
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE ${clause}
         ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
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
      query:  q,
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const isTimeout = msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')

    if (isTimeout) {
      const response = NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — use a more specific search term (exact email, domain, or breach name) for fast results at this data size.',
        results:   [],
        total:     0,
        pages:     0,
      }, { status: 408 })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    console.error('v1 search error:', msg)
    return NextResponse.json({ success: false, error: 'Search failed' }, { status: 500 })
  }
}
