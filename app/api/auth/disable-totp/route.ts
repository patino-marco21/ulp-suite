import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { validateRequest } from '@/lib/auth'
import bcrypt from 'bcryptjs'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { password } = await request.json()
  if (!password) return NextResponse.json({ success: false, error: 'Password is required' }, { status: 400 })

  try {
    const row = dbGet('SELECT id, password_hash, totp_enabled FROM users WHERE id = ?', [user.userId]) as
      | { id: number; password_hash: string; totp_enabled: number } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
    if (!row.totp_enabled) return NextResponse.json({ success: false, error: '2FA is not enabled' }, { status: 400 })

    if (!(await bcrypt.compare(password, row.password_hash))) {
      return NextResponse.json({ success: false, error: 'Invalid password' }, { status: 400 })
    }

    dbRun(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, backup_codes = NULL, updated_at = datetime('now') WHERE id = ?`,
      [user.userId])

    return NextResponse.json({ success: true, message: 'Two-factor authentication disabled' })
  } catch (err) {
    console.error('Disable TOTP error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
