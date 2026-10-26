/**
 * Site Counts API v1
 * POST /api/v1/lookup/counts
 *
 * How many rows each of up to 100 sites has, without the rows: for a list of platforms that is all that is wanted, and a lookup caps what it returns.
 *
 * Body (JSON):
 *   { domains: string[], imported_after?: string, imported_before?: string }
 *   imported_after / imported_before (UTC; exclusive / inclusive; see lib/imported-range.ts) count only rows imported in that window.
 *
 * A site is the host an entry stands for and every subdomain of it, reported separately:
 *   count            rows under the site (host_count + subdomain_count)
 *   host_count       rows on the host itself (and its `www.` spelling)
 *   subdomain_count  rows on subdomains; subdomains = how many different ones; top_subdomains = the ones with the most rows
 * An entry may be a URL, a `www.` host, `host:port` or a `*.host` wildcard: it is cleaned to the bare host the table stores (lib/batch-input.ts),
 * the path is ignored, and `searched_as` says what was counted when it differs from what was sent. An entry that is not a site has `error`
 * and null numbers; so does a site too broad to count in the time allowed. `subdomains_counted: false` means only hosts could be counted.
 *
 * Max 100 sites per request. Counting is by 20 at about 22 ms a site (docs/superpowers/specs/2026-10-26-site-counts-design.md).
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { answerSiteCounts } from "@/lib/site-counts"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ["admin", "analyst"])
  if (!authResult.success) {
    return NextResponse.json(
      { success: false, error: authResult.error },
      { status: authResult.status || 401 }
    )
  }

  await logApiRequest(authResult.apiKey!, request, "v1/lookup/counts")

  let body: { domains?: unknown; imported_after?: unknown; imported_before?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = await answerSiteCounts(body)
  return addRateLimitHeaders(NextResponse.json(reply.json, { status: reply.status }), authResult.rateLimit)
}
