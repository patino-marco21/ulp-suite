import { NextRequest, NextResponse } from 'next/server'
import { dbGet } from '@/lib/sqlite'
import { validateRequest, UserRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const row = dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [user.userId]) as
      | { id: number; email: string; name: string; role: string } | undefined

    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })

    const userRole = (row.role || 'analyst') as UserRole
    return NextResponse.json({
      success: true,
      user: { id: row.id, email: row.email, name: row.name || row.email.split('@')[0], role: userRole },
    })
  } catch (err) {
    console.error('Get user error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
