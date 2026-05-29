import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { retryFiles, retryAllFailed } from '@/lib/inbox-helpers'

export const dynamic = 'force-dynamic'

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

  let moved: string[]

  if (b.all === true) {
    moved = retryAllFailed()
  } else if (typeof b.filename === 'string' && b.filename.length > 0) {
    moved = retryFiles([b.filename])
  } else {
    return NextResponse.json(
      { success: false, error: 'Body must be { filename: string } or { all: true }' },
      { status: 400 },
    )
  }

  return NextResponse.json({ success: true, moved })
}
