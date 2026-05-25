import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { generateToken, getSecureCookieOptions, isRequestSecure, UserRole, verifyPending2FAToken } from '@/lib/auth'
import { verifyTOTP, verifyBackupCode } from '@/lib/totp'
import { logUserAction } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const { code, isBackupCode } = await request.json()
  const pending2FAToken = request.cookies.get('pending_2fa')?.value

  if (!pending2FAToken || !code) {
    return NextResponse.json({ success: false, error: 'Pending 2FA token and code are required' }, { status: 400 })
  }

  const userId = await verifyPending2FAToken(pending2FAToken)
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Invalid or expired 2FA session. Please login again.' }, { status: 401 })
  }

  try {
    const row = dbGet(
      'SELECT id, email, name, role, totp_secret, totp_enabled, backup_codes FROM users WHERE id = ?',
      [userId]
    ) as { id: number; email: string; name: string; role: string; totp_secret: string | null; totp_enabled: number; backup_codes: string | null } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
    if (!row.totp_enabled || !row.totp_secret) {
      return NextResponse.json({ success: false, error: '2FA is not enabled for this user' }, { status: 400 })
    }

    let isValid = false
    if (isBackupCode) {
      const codes: string[] = row.backup_codes ? JSON.parse(row.backup_codes) : []
      const result = verifyBackupCode(codes, code)
      isValid = result.isValid
      if (isValid) {
        dbRun(`UPDATE users SET backup_codes = ?, updated_at = datetime('now') WHERE id = ?`,
          [JSON.stringify(result.remainingCodes), userId])
      }
    } else {
      isValid = verifyTOTP(row.totp_secret, code)
    }

    if (!isValid) {
      await logUserAction('user.login.fail', { id: row.id, email: row.email }, row.id,
        { reason: 'invalid_2fa_code', method: isBackupCode ? 'backup_code' : 'totp' }, request)
      return NextResponse.json({
        success: false,
        error: isBackupCode ? 'Invalid backup code' : 'Invalid verification code',
      }, { status: 400 })
    }

    const userRole = (row.role || 'analyst') as UserRole
    const token = await generateToken({ userId: String(row.id), username: row.name || row.email, email: row.email, role: userRole })

    await logUserAction('user.login', { id: row.id, email: row.email }, row.id,
      { method: isBackupCode ? 'password_with_backup_code' : 'password_with_2fa', role: userRole }, request)

    const response = NextResponse.json({ success: true, user: { id: row.id, email: row.email, name: row.name, role: userRole } })
    response.cookies.set('auth', token, getSecureCookieOptions(request))
    response.cookies.set('user_role', userRole, { httpOnly: false, secure: isRequestSecure(request), sameSite: 'strict', maxAge: 24 * 60 * 60, path: '/' })
    response.cookies.set('pending_2fa', '', { httpOnly: true, secure: isRequestSecure(request), sameSite: 'strict', path: '/api/auth/verify-totp', maxAge: 0 })
    return response
  } catch (err) {
    console.error('Verify TOTP error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
