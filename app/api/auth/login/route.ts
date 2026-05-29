import { NextRequest, NextResponse } from 'next/server'
import { dbGet } from '@/lib/sqlite'
import bcrypt from 'bcryptjs'
import { generateToken, generatePending2FAToken, getSecureCookieOptions, isRequestSecure, UserRole } from '@/lib/auth'
import { logUserAction } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const { email, password } = await request.json()

  try {
    const user = dbGet(
      'SELECT id, email, password_hash, name, role, is_active, totp_enabled FROM users WHERE email = ?',
      [email]
    ) as { id: number; email: string; password_hash: string; name: string; role: string; is_active: number; totp_enabled: number } | undefined

    if (!user) {
      await logUserAction('user.login.fail', { id: null, email }, null, { reason: 'user_not_found', attempted_email: email }, request)
      return NextResponse.json({ success: false, error: 'Invalid email or password.' }, { status: 401 })
    }

    const match = await bcrypt.compare(password, user.password_hash || '')
    if (!match) {
      await logUserAction('user.login.fail', { id: user.id, email: user.email }, user.id, { reason: 'invalid_password' }, request)
      return NextResponse.json({ success: false, error: 'Invalid email or password.' }, { status: 401 })
    }

    if (!user.is_active) {
      await logUserAction('user.login.fail', { id: user.id, email: user.email }, user.id, { reason: 'account_inactive' }, request)
      return NextResponse.json({ success: false, error: 'Your account has been deactivated.' }, { status: 403 })
    }

    if (user.totp_enabled) {
      const pending2FAToken = await generatePending2FAToken(String(user.id))
      const response = NextResponse.json({ success: true, requires2FA: true, message: 'Please enter your 2FA code' })
      response.cookies.set('pending_2fa', pending2FAToken, {
        httpOnly: true,
        secure: isRequestSecure(request),
        sameSite: 'strict',
        path: '/api/auth/verify-totp',
        maxAge: 300,
      })
      return response
    }

    const userRole = (user.role || 'analyst') as UserRole
    const token = await generateToken({ userId: String(user.id), username: user.name || user.email, email: user.email, role: userRole })

    await logUserAction('user.login', { id: user.id, email: user.email }, user.id, { method: 'password_only', role: userRole }, request)

    const response = NextResponse.json({
      success: true,
      requires2FA: false,
      user: { id: user.id, email: user.email, name: user.name, role: userRole },
    })
    response.cookies.set('auth', token, getSecureCookieOptions(request))
    // SECURITY: httpOnly: true — role is read server-side via await cookies()
    // in app/layout.tsx for SSR sidebar rendering.  Client JS doesn't need it.
    response.cookies.set('user_role', userRole, {
      httpOnly: true, secure: isRequestSecure(request), sameSite: 'strict', maxAge: 24 * 60 * 60, path: '/',
    })
    return response
  } catch (err) {
    console.error('Login error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 })
  }
}
