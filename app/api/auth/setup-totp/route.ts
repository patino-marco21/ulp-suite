import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { validateRequest } from '@/lib/auth'
import { generateTOTPSecret, generateQRCode, generateBackupCodes } from '@/lib/totp'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const row = dbGet('SELECT id, email, totp_enabled FROM users WHERE id = ?', [user.userId]) as
      | { id: number; email: string; totp_enabled: number } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
    if (row.totp_enabled) {
      return NextResponse.json({ success: false, error: '2FA is already enabled. Disable it first.' }, { status: 400 })
    }

    const secret = generateTOTPSecret()
    const qrCode = await generateQRCode(secret, row.email)
    const backupCodes = generateBackupCodes(10)

    dbRun(`UPDATE users SET totp_secret = ?, backup_codes = ?, updated_at = datetime('now') WHERE id = ?`,
      [secret, JSON.stringify(backupCodes), user.userId])

    return NextResponse.json({ success: true, data: { secret, qrCode, backupCodes } })
  } catch (err) {
    console.error('Setup TOTP error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const row = dbGet('SELECT totp_enabled, totp_secret FROM users WHERE id = ?', [user.userId]) as
      | { totp_enabled: number; totp_secret: string | null } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })

    return NextResponse.json({
      success: true,
      data: { totpEnabled: Boolean(row.totp_enabled), hasSecret: row.totp_secret !== null },
    })
  } catch (err) {
    console.error('Get TOTP status error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
