import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { validateRequest } from '@/lib/auth'
import { verifyTOTP } from '@/lib/totp'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { code } = await request.json()
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ success: false, error: 'Verification code is required' }, { status: 400 })
  }

  try {
    const row = dbGet('SELECT id, totp_secret, totp_enabled FROM users WHERE id = ?', [user.userId]) as
      | { id: number; totp_secret: string | null; totp_enabled: number } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
    if (!row.totp_secret) return NextResponse.json({ success: false, error: 'No TOTP secret. Setup 2FA first.' }, { status: 400 })
    if (row.totp_enabled) return NextResponse.json({ success: false, error: '2FA is already enabled' }, { status: 400 })

    if (!verifyTOTP(row.totp_secret, code)) {
      return NextResponse.json({ success: false, error: 'Invalid verification code.' }, { status: 400 })
    }

    dbRun(`UPDATE users SET totp_enabled = 1, updated_at = datetime('now') WHERE id = ?`, [user.userId])
    return NextResponse.json({ success: true, message: 'Two-factor authentication enabled successfully' })
  } catch (err) {
    console.error('Enable TOTP error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
