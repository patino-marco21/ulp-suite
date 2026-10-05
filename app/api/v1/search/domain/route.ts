/**
 * Search API v1 - Domain Search
 * GET /api/v1/search/domain?domain=example.com&page=1&limit=100
 * Optional: &imported_after=<instant>&imported_before=<instant> (UTC; exclusive / inclusive), see lib/imported-range.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { importedRangeFromSearchParams, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"

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

  // `domain = X` already narrows the read by the primary key, so the plain bound is all it needs (measured 2026-10-05: 18-175 ms for a
  // popular domain with or without a predicate on the projection's key).
  const parsedRange = importedRangeFromSearchParams(searchParams)
  if (!parsedRange.ok) {
    return addRateLimitHeaders(NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 }), authResult.rateLimit)
  }
  const importedRange = parsedRange.range
  const rangeSql = importedRangePlain(importedRange)
  const rangeAnd = importedRangeAndSql(rangeSql)

  try {
    // Raw domain column: all data-repair mutations done, bloom_filter index used.
    const [countResult, rows] = await Promise.all([
      executeQuery(
        `SELECT count() as total FROM ulp.credentials WHERE domain = {domain:String}${rangeAnd}
         SETTINGS optimize_trivial_count_query = 1, max_execution_time = 30, timeout_overflow_mode = 'break', use_query_cache = 0`,
        { domain, ...rangeSql.params }
      ),
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE domain = {domain:String}${rangeAnd}
         ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1`,
        { domain, ...rangeSql.params, limit, offset }
      ),
    ])

    const total = Number(countResult[0]?.total || 0)
    const response = NextResponse.json({ success: true, domain, results: rows, total, page, pages: Math.ceil(total / limit), ...importedRangeEchoIfSet(importedRange) })
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
