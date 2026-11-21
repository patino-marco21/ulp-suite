/**
 * Internal Site Directory status API
 * GET /api/lookup/directory/status -> { success, total, out_of_date, state: 'current' | 'waiting' | 'refreshing', refreshed_at }
 *
 * What the line above the directory list says: how many sites the last import has outgrown and whether the refresh (lib/site-directory-cron.ts) is
 * running. Session-authenticated, any signed-in user.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerDirectoryStatus } from "@/lib/site-directory-cron"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const reply = await answerDirectoryStatus()
  return NextResponse.json(reply.json, { status: reply.status })
}
