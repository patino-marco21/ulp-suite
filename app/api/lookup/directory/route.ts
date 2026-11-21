/**
 * Internal Site Directory API (the Site Directory page)
 * GET    /api/lookup/directory?sort=<count|host_count|subdomain_count|subdomains|mark>&dir=desc|asc&q=<text>&mark=all|done|skip|todo|none&offset=<n>&limit=<<=200>&host=<exact>
 *        -> { success, sites[], next_offset, total, marks, refreshed_at }   (total and marks only on the first page)
 * DELETE /api/lookup/directory   body { host }  -> { success, host }
 *
 * Session-authenticated (the same auth as /api/lookup/counts): any signed-in user, admin or analyst. The directory is shared by everyone who signs in and
 * is not on /api/v1: an API key has no person, though an API count still feeds it. The checks, the SQL and the answers are in lib/site-directory.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerDirectoryList, answerDirectoryRemove } from "@/lib/site-directory"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const reply = answerDirectoryList(request.nextUrl.searchParams)
  return NextResponse.json(reply.json, { status: reply.status })
}

export async function DELETE(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = answerDirectoryRemove(body)
  return NextResponse.json(reply.json, { status: reply.status })
}
