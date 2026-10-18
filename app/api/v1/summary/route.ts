/**
 * Summary API v1 - ULP Stats Endpoint
 * GET /api/v1/summary
 * GET /api/v1/summary?imported_after=<instant>[&imported_before=<instant>]
 *
 * Table-wide totals and the top 20 domains. The numbers come from lib/v1-summary.ts: they are
 * computed in the background at most every 10 minutes (`as_of` says when), and `unique_domains` /
 * `unique_emails` are estimates (see `approximate`). Counting them exactly exhausts ClickHouse's
 * memory cap at this table's size.
 *
 * With imported_after (UTC; exclusive; lib/imported-range.ts) the same answer is given for the rows added in that window
 * (imported_before, inclusive, closes it): `sources` is the number of files imported in it, and the response repeats the
 * effective window. A lower bound is required: an upper bound alone is the whole table up to a date, the 28 s scan the
 * table-wide summary runs in the background. A window is computed on request and kept for 2 minutes (10 once it is closed).
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { getSummary, getWindowSummary, SUMMARY_APPROXIMATE_FIELDS } from "@/lib/v1-summary"
import { hasImportedRange, importedRangeEchoIfSet, importedRangeFromSearchParams } from "@/lib/imported-range"

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/summary')

  const parsedRange = importedRangeFromSearchParams(new URL(request.url).searchParams)
  if (!parsedRange.ok) return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
  const range = parsedRange.range
  if (hasImportedRange(range)) {
    if (range.lower === null) {
      return NextResponse.json(
        { success: false, error: 'imported_before alone is the whole table up to a date: add imported_after, or leave both out for the table-wide summary' },
        { status: 400 },
      )
    }
    try {
      const summary = await getWindowSummary(range)
      return addRateLimitHeaders(
        NextResponse.json({
          success: true,
          stats: summary.stats,
          top_domains: summary.top_domains,
          as_of: summary.as_of,
          stale: false,
          approximate: SUMMARY_APPROXIMATE_FIELDS,
          ...importedRangeEchoIfSet(range),
        }),
        authResult.rateLimit,
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (/TIMEOUT_EXCEEDED|timeout/i.test(msg)) {
        return NextResponse.json({ success: false, timed_out: true, error: 'Query timed out: narrow the window (a later imported_after, or add imported_before)' }, { status: 408 })
      }
      console.error('v1 summary (window) error:', error)
      return NextResponse.json({ success: false, error: 'Failed to fetch summary' }, { status: 500 })
    }
  }

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
