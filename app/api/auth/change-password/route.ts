import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import bcrypt from 'bcryptjs'
import { validateRequest } from '@/lib/auth'
import { passwordProblems } from '@/lib/validation'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { currentPassword, newPassword } = await request.json()

  const problems = passwordProblems(newPassword)
  if (problems.length > 0) {
    return NextResponse.json({ success: false, error: problems.join(', ') }, { status: 400 })
  }

  try {
    const row = dbGet('SELECT id, password_hash FROM users WHERE id = ?', [user.userId]) as
      | { id: number; password_hash: string } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })

    const valid = await bcrypt.compare(currentPassword, row.password_hash)
    if (!valid) return NextResponse.json({ success: false, error: 'Current password is incorrect' }, { status: 400 })

    const hash = await bcrypt.hash(newPassword, 12)
    dbRun(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`, [hash, user.userId])

    return NextResponse.json({ success: true, message: 'Password updated successfully' })
  } catch (err) {
    console.error('Change password error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
