/**
 * Internal Site Counts API (the Site Counts page)
 * POST /api/lookup/counts
 *
 * Session-authenticated endpoint (same JWT auth as the dashboard).
 * Body: { domains: string[], imported_after?: string, imported_before?: string }
 * Response: { success, queried, found, subdomains_counted, results: { [as pasted]: { host, found, count, host_count, subdomain_count, subdomains,
 *             top_subdomains[], searched_as?, error? } } }
 *
 * How many rows each pasted site has: its host plus every subdomain, told apart. The checks, the SQL and the answer are in lib/site-counts.ts and are
 * shared with POST /api/v1/lookup/counts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerSiteCounts } from "@/lib/site-counts"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  let body: { domains?: unknown; imported_after?: unknown; imported_before?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = await answerSiteCounts(body)
  return NextResponse.json(reply.json, { status: reply.status })
}
