import { NextRequest, NextResponse } from 'next/server'
import { validateRequest, isAdmin } from '@/lib/auth'
import { deleteApiKey } from '@/lib/api-key-auth'
import { dbGet, dbRun } from '@/lib/sqlite'
import { logApiKeyAction } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

interface RouteParams { params: Promise<{ id: string }> }

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const keyId = Number(id)
    if (isNaN(keyId) || keyId <= 0) return NextResponse.json({ success: false, error: 'Invalid API key ID' }, { status: 400 })

    const keyInfo = dbGet('SELECT id, name, key_prefix, role, user_id FROM api_keys WHERE id = ?', [keyId]) as
      | { id: number; name: string; key_prefix: string; role: string; user_id: number } | undefined

    const userId = isAdmin(user) ? undefined : Number(user.userId)
    const deleted = await deleteApiKey(keyId, userId)

    if (!deleted) return NextResponse.json({ success: false, error: 'API key not found or permission denied' }, { status: 404 })

    if (keyInfo) {
      await logApiKeyAction('apikey.delete', { id: Number(user.userId), email: user.email || null }, keyId,
        { name: keyInfo.name, key_prefix: keyInfo.key_prefix, role: keyInfo.role }, request)
    }

    return NextResponse.json({ success: true, message: 'API key deleted successfully' })
  } catch (err) {
    console.error('Delete API key error:', err)
    return NextResponse.json({ success: false, error: 'Failed to delete API key' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const keyId = Number(id)
    if (isNaN(keyId) || keyId <= 0) return NextResponse.json({ success: false, error: 'Invalid API key ID' }, { status: 400 })

    const { name, isActive, rateLimit, rateLimitWindow } = await request.json()

    const parts: string[] = []
    const values: unknown[] = []

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return NextResponse.json({ success: false, error: 'Name cannot be empty' }, { status: 400 })
      parts.push('name = ?'); values.push(name.trim())
    }
    if (isActive !== undefined) { parts.push('is_active = ?'); values.push(isActive ? 1 : 0) }
    if (rateLimit !== undefined) { parts.push('rate_limit = ?'); values.push(Math.min(Math.max(1, Number(rateLimit)), 10000)) }
    if (rateLimitWindow !== undefined) { parts.push('rate_limit_window = ?'); values.push(Math.min(Math.max(1, Number(rateLimitWindow)), 3600)) }

    if (parts.length === 0) return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })

    parts.push("updated_at = datetime('now')")
    values.push(keyId)
    let sql = `UPDATE api_keys SET ${parts.join(', ')} WHERE id = ?`
    if (!isAdmin(user)) { sql += ' AND user_id = ?'; values.push(Number(user.userId)) }

    const { changes } = dbRun(sql, values)
    if (changes === 0) return NextResponse.json({ success: false, error: 'API key not found or permission denied' }, { status: 404 })

    const updated = dbGet(
      'SELECT id, name, key_prefix, role, rate_limit, rate_limit_window, is_active, expires_at, last_used_at, created_at, updated_at FROM api_keys WHERE id = ?',
      [keyId]
    ) as Record<string, unknown>

    const details: Record<string, unknown> = {}
    if (name !== undefined) details.name = name.trim()
    if (isActive !== undefined) details.is_active = isActive
    if (rateLimit !== undefined) details.rate_limit = rateLimit
    if (rateLimitWindow !== undefined) details.rate_limit_window = rateLimitWindow

    await logApiKeyAction(
      isActive === false ? 'apikey.revoke' : 'apikey.update',
      { id: Number(user.userId), email: user.email || null }, keyId, details, request
    )

    return NextResponse.json({
      success: true,
      message: 'API key updated successfully',
      apiKey: {
        id: updated.id, name: updated.name, keyPrefix: updated.key_prefix, role: updated.role,
        rateLimit: updated.rate_limit, rateLimitWindow: updated.rate_limit_window,
        isActive: updated.is_active, expiresAt: updated.expires_at, lastUsedAt: updated.last_used_at,
        createdAt: updated.created_at, updatedAt: updated.updated_at,
      },
    })
  } catch (err) {
    console.error('Update API key error:', err)
    return NextResponse.json({ success: false, error: 'Failed to update API key' }, { status: 500 })
  }
}
