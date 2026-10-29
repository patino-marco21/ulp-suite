/**
 * Internal Site Marks API (the Site Counts page)
 * POST /api/lookup/marks   body { hosts: string[] }
 *                          -> { success, marks: { [host]: { status, note, updated_by, updated_at } } }   only the hosts that have a mark
 * PUT  /api/lookup/marks   body { host: string, status?: 'done' | 'skip' | 'todo' | null, note?: string | null }
 *                          -> { success, host, mark: { status, note, updated_by, updated_at } | null }     the mark as stored after the change
 *
 * Session-authenticated (the same auth as /api/lookup/counts): any signed-in user, admin or analyst, as the page itself. A mark is kept under the host
 * the counts name, is shared by everyone who signs in, and is not on /api/v1: an API key has no person to attribute it to. The checks, the SQL and the
 * answers are in lib/site-marks.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerMarkChange, answerMarksRead } from "@/lib/site-marks"

export const dynamic = "force-dynamic"

async function readJson(request: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false }
  }
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const parsed = await readJson(request)
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = answerMarksRead(parsed.body)
  return NextResponse.json(reply.json, { status: reply.status })
}

export async function PUT(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const parsed = await readJson(request)
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = answerMarkChange(parsed.body, user.email ?? user.username)
  return NextResponse.json(reply.json, { status: reply.status })
}
