import { NextRequest, NextResponse } from 'next/server'
import { dbQuery } from '@/lib/sqlite'
import { validateRequest, requireAdminRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const actions = (dbQuery('SELECT DISTINCT action FROM audit_logs ORDER BY action') as { action: string }[]).map(r => r.action)
    const resourceTypes = (dbQuery('SELECT DISTINCT resource_type FROM audit_logs ORDER BY resource_type') as { resource_type: string }[]).map(r => r.resource_type)
    const users = (dbQuery('SELECT DISTINCT user_id, user_email FROM audit_logs WHERE user_id IS NOT NULL ORDER BY user_email') as { user_id: number; user_email: string }[]).map(u => ({ id: u.user_id, email: u.user_email }))

    return NextResponse.json({ success: true, actions, resourceTypes, users })
  } catch (err) {
    console.error('Get audit log filters error:', err)
    return NextResponse.json({ success: false, error: 'Failed to fetch filters' }, { status: 500 })
  }
}
