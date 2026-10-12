import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getHeld, isSafeFileName, releaseFiles } from '@/lib/inbox-helpers'
import { addGateOverride, removeGateOverride } from '@/lib/ingest-gate-store'
import { logUploadAction } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

/**
 * Release files the ingest quality gate held (lib/ingest-quality-gate.ts). A file goes back to the inbox with a one-shot release stored for its name: the watcher
 * imports it once without holding it again, and reports what the gate found. The release is stored BEFORE the file moves, because the watcher can claim the file
 * the moment it is back.
 */
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ success: false, error: 'Body must be an object' }, { status: 400 })
  }

  const b = body as Record<string, unknown>

  let names: string[]
  if (b.all === true) {
    names = getHeld().map(f => f.name)
  } else if (typeof b.filename === 'string' && b.filename.length > 0) {
    names = [b.filename]
  } else {
    return NextResponse.json(
      { success: false, error: 'Body must be { filename: string } or { all: true }' },
      { status: 400 },
    )
  }

  const moved: string[] = []
  for (const name of names) {
    if (!isSafeFileName(name)) continue
    if (!addGateOverride(name, user?.email || null)) continue
    if (releaseFiles([name]).length === 1) moved.push(name)
    else removeGateOverride(name)
  }

  await logUploadAction(
    'inbox.release',
    { id: user ? Number(user.userId) : null, email: user?.email || null },
    null,
    { moved, mode: b.all === true ? 'all' : 'one' },
    request,
  )

  return NextResponse.json({ success: true, moved })
}
