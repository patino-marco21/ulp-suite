import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { validateRequest, requireAdminRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

interface UserPreferences {
  stream_enabled?: boolean
}

const DEFAULTS: UserPreferences = { stream_enabled: true }
const ADMIN_ONLY_KEYS: (keyof UserPreferences)[] = ['stream_enabled']

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const row = dbGet('SELECT preferences FROM users WHERE id = ?', [user.userId]) as { preferences: string | null } | undefined
    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })

    let prefs: UserPreferences = { ...DEFAULTS }
    if (row.preferences) {
      try { prefs = { ...DEFAULTS, ...JSON.parse(row.preferences) } } catch { /**/ }
    }
    return NextResponse.json({ success: true, preferences: prefs })
  } catch (err) {
    console.error('Get preferences error:', err)
    return NextResponse.json({ success: false, error: 'Failed to get preferences' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await request.json()
    const newPrefs: Partial<UserPreferences> = body.preferences || body

    const adminKeys = ADMIN_ONLY_KEYS.filter(k => k in newPrefs)
    if (adminKeys.length > 0) {
      const roleError = requireAdminRole(user)
      if (roleError) return NextResponse.json({ success: false, error: `Fields [${adminKeys.join(', ')}] require admin role` }, { status: 403 })
    }

    const row = dbGet('SELECT preferences FROM users WHERE id = ?', [user.userId]) as { preferences: string | null } | undefined
    if (!row) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })

    let current: UserPreferences = { ...DEFAULTS }
    if (row.preferences) {
      try { current = { ...DEFAULTS, ...JSON.parse(row.preferences) } } catch { /**/ }
    }
    const updated = { ...current, ...newPrefs }
    dbRun(`UPDATE users SET preferences = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify(updated), user.userId])

    return NextResponse.json({ success: true, message: 'Preferences updated', preferences: updated })
  } catch (err) {
    console.error('Update preferences error:', err)
    return NextResponse.json({ success: false, error: 'Failed to update preferences' }, { status: 500 })
  }
}
