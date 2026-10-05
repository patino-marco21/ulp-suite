/**
 * Quick Lookup API v1
 * GET /api/v1/lookup?email=john@example.com
 * GET /api/v1/lookup?domain=example.com
 * Optional on both: &imported_after=<instant>&imported_before=<instant> (UTC; exclusive / inclusive), see lib/imported-range.ts.
 *
 * Performance: queries raw domain/email columns (indexed) instead of
 * NORM_*_EXPR wrappers.  All background data-repair mutations are done
 * so stored values are correct — raw columns use bloom filters + primary key.
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { importedRangeFromSearchParams, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"

export const dynamic = 'force-dynamic'

// use_query_cache: cache identical repeat lookups in ClickHouse's native LRU cache
// for 60 seconds — eliminates re-scanning for the same email/domain on hot paths.
// query_cache_nondeterministic_function_handling = throw prevents caching of
// functions like now() (not applicable here but good hygiene).
const SETTINGS = `SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw',
                          http_wait_end_of_query = 1,
                          use_query_cache = 1, query_cache_ttl = 60`

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/lookup')

  const { searchParams } = new URL(request.url)
  const email  = searchParams.get('email')?.toLowerCase().trim()  || ''
  const domain = searchParams.get('domain')?.toLowerCase().trim() || ''

  if (!email && !domain) {
    return NextResponse.json({ success: false, error: 'Provide email or domain parameter' }, { status: 400 })
  }

  // An exact email or domain is narrowed by the key and the bloom filter, so the plain bound is all it needs.
  const parsedRange = importedRangeFromSearchParams(searchParams)
  if (!parsedRange.ok) {
    return addRateLimitHeaders(NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 }), authResult.rateLimit)
  }
  const importedRange = parsedRange.range
  const rangeSql = importedRangePlain(importedRange)
  const rangeAnd = importedRangeAndSql(rangeSql)

  try {
    let results: any[]

    if (email) {
      results = await executeQuery(
        `SELECT url, email, domain, source_file, imported_at
         FROM ulp.credentials
         WHERE email = {email:String}${rangeAnd}
         ORDER BY imported_at DESC LIMIT 100
         ${SETTINGS}`,
        { email, ...rangeSql.params }
      )
      const response = NextResponse.json({ success: true, found: results.length > 0, email, count: results.length, results, ...importedRangeEchoIfSet(importedRange) })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    results = await executeQuery(
      `SELECT url, email, domain, source_file, imported_at
       FROM ulp.credentials
       WHERE domain = {domain:String}${rangeAnd}
       ORDER BY imported_at DESC LIMIT 100
       ${SETTINGS}`,
      { domain, ...rangeSql.params }
    )
    const response = NextResponse.json({ success: true, found: results.length > 0, domain, count: results.length, results, ...importedRangeEchoIfSet(importedRange) })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout')) {
      return NextResponse.json({ success: false, timed_out: true, error: 'Query timed out — use exact email or domain' }, { status: 408 })
    }
    console.error('v1 lookup error:', msg)
    return NextResponse.json({ success: false, error: 'Lookup failed' }, { status: 500 })
  }
}
