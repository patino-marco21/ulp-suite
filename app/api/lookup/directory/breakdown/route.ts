/**
 * Internal Site Directory breakdown API
 * POST /api/lookup/directory/breakdown   body { host }  -> { success, site }   the site as the list sends it, with its split
 *
 * Works out how the logins of one site (its host and every subdomain) split into e-mail, phone, user name and other, stores it, and answers. Called when a
 * directory row with no split is opened. Session-authenticated, any signed-in user; at most two run at once in the app. The query, the limits and the
 * answers are in lib/site-directory-breakdown.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerBreakdown } from "@/lib/site-directory-breakdown"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
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

  const reply = await answerBreakdown(body)
  return NextResponse.json(reply.json, { status: reply.status })
}
