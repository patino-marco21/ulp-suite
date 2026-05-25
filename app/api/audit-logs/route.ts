import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { validateRequest, requireAdminRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number(searchParams.get('page')) || 1)
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 50))
    const offset = (page - 1) * limit

    const conditions: string[] = []
    const params: unknown[] = []

    const action = searchParams.get('action')
    const resourceType = searchParams.get('resource_type')
    const userId = searchParams.get('user_id')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const search = searchParams.get('search')

    if (action) { conditions.push('action = ?'); params.push(action) }
    if (resourceType) { conditions.push('resource_type = ?'); params.push(resourceType) }
    if (userId) { conditions.push('user_id = ?'); params.push(Number(userId)) }
    if (startDate) { conditions.push('created_at >= ?'); params.push(startDate) }
    if (endDate) { conditions.push('created_at <= ?'); params.push(endDate) }
    if (search) {
      conditions.push('(user_email LIKE ? OR resource_id LIKE ? OR details LIKE ?)')
      const p = `%${search}%`; params.push(p, p, p)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = ((dbGet(`SELECT COUNT(*) as c FROM audit_logs ${where}`, params) as { c: number }).c)

    const logs = dbQuery(
      `SELECT id, user_id, user_email, action, resource_type, resource_id, details, ip_address, user_agent, created_at
       FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ) as Array<Record<string, unknown>>

    const parsedLogs = logs.map(log => ({
      ...log,
      details: (() => { try { return JSON.parse(log.details as string || '{}') } catch { return {} } })(),
    }))

    return NextResponse.json({ success: true, logs: parsedLogs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } })
  } catch (err) {
    console.error('Get audit logs error:', err)
    return NextResponse.json({ success: false, error: 'Failed to fetch audit logs' }, { status: 500 })
  }
}

export async function OPTIONS(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const actions = (dbQuery('SELECT DISTINCT action FROM audit_logs ORDER BY action') as { action: string }[]).map(r => r.action)
    const resourceTypes = (dbQuery('SELECT DISTINCT resource_type FROM audit_logs ORDER BY resource_type') as { resource_type: string }[]).map(r => r.resource_type)
    return NextResponse.json({ success: true, actions, resourceTypes })
  } catch (err) {
    console.error('Get audit log options error:', err)
    return NextResponse.json({ success: false, error: 'Failed to fetch options' }, { status: 500 })
  }
}
