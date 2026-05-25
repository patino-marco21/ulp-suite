import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbQuery, dbRun } from '@/lib/sqlite'
import bcrypt from 'bcryptjs'
import { validateRequest, requireAdminRole, UserRole } from '@/lib/auth'
import { logUserAction } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  const users = dbQuery('SELECT id, email, name, role, is_active, created_at, updated_at FROM users ORDER BY created_at DESC')
  return NextResponse.json({ success: true, users })
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const { email, password, name, role } = await request.json()
    if (!email || !password || !name) {
      return NextResponse.json({ success: false, error: 'Email, password, and name are required' }, { status: 400 })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'Invalid email format' }, { status: 400 })
    }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return NextResponse.json({ success: false, error: 'Password must be 8+ chars with upper, lower, and digit' }, { status: 400 })
    }

    const validRoles: UserRole[] = ['admin', 'analyst']
    const userRole: UserRole = validRoles.includes(role) ? role : 'analyst'

    const existing = dbGet('SELECT id FROM users WHERE email = ?', [email])
    if (existing) return NextResponse.json({ success: false, error: 'Email already exists' }, { status: 400 })

    const hash = await bcrypt.hash(password, 12)
    const { lastId } = dbRun('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      [email, hash, name, userRole])

    await logUserAction('user.create', { id: Number(user.userId), email: user.email || null }, lastId,
      { email, name, role: userRole }, request)

    return NextResponse.json({ success: true, message: 'User created successfully', user: { id: lastId, email, name, role: userRole } })
  } catch (err) {
    console.error('Create user error:', err)
    return NextResponse.json({ success: false, error: 'Failed to create user' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const { id, email, name, role, password, is_active } = await request.json()
    if (!id) return NextResponse.json({ success: false, error: 'User ID is required' }, { status: 400 })

    if (!dbGet('SELECT id FROM users WHERE id = ?', [id])) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
    }

    const parts: string[] = []
    const params: unknown[] = []

    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json({ success: false, error: 'Invalid email format' }, { status: 400 })
      }
      if (dbGet('SELECT id FROM users WHERE email = ? AND id != ?', [email, id])) {
        return NextResponse.json({ success: false, error: 'Email already in use' }, { status: 400 })
      }
      parts.push('email = ?'); params.push(email)
    }
    if (name) { parts.push('name = ?'); params.push(name) }
    if (role) {
      if (!['admin', 'analyst'].includes(role)) {
        return NextResponse.json({ success: false, error: 'Invalid role' }, { status: 400 })
      }
      parts.push('role = ?'); params.push(role)
    }
    if (password) {
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return NextResponse.json({ success: false, error: 'Password too weak' }, { status: 400 })
      }
      parts.push('password_hash = ?'); params.push(await bcrypt.hash(password, 12))
    }
    if (typeof is_active === 'boolean') {
      if (String(id) === user.userId && !is_active) {
        return NextResponse.json({ success: false, error: 'Cannot deactivate your own account' }, { status: 400 })
      }
      if (!is_active) {
        const target = dbGet('SELECT role, is_active FROM users WHERE id = ?', [id]) as { role: string; is_active: number } | undefined
        const adminCount = (dbGet('SELECT COUNT(*) as c FROM users WHERE role = "admin" AND is_active = 1') as { c: number }).c
        if (adminCount <= 1 && target?.role === 'admin' && target?.is_active) {
          return NextResponse.json({ success: false, error: 'Cannot deactivate the last active admin' }, { status: 400 })
        }
      }
      parts.push('is_active = ?'); params.push(is_active ? 1 : 0)
    }

    if (parts.length === 0) return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })

    parts.push("updated_at = datetime('now')")
    params.push(id)
    dbRun(`UPDATE users SET ${parts.join(', ')} WHERE id = ?`, params)

    const updateDetails: Record<string, unknown> = {}
    if (email) updateDetails.email = email
    if (name) updateDetails.name = name
    if (role) updateDetails.role = role
    if (password) updateDetails.password_changed = true
    if (typeof is_active === 'boolean') updateDetails.is_active = is_active

    await logUserAction(
      password ? 'user.password.change' : 'user.update',
      { id: Number(user.userId), email: user.email || null }, id, updateDetails, request
    )

    return NextResponse.json({ success: true, message: 'User updated successfully' })
  } catch (err) {
    console.error('Update user error:', err)
    return NextResponse.json({ success: false, error: 'Failed to update user' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, error: 'User ID is required' }, { status: 400 })
    if (id === user.userId) return NextResponse.json({ success: false, error: 'Cannot delete your own account' }, { status: 400 })

    const target = dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [id]) as
      | { id: number; email: string; name: string; role: string } | undefined
    if (!target) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })

    const adminCount = (dbGet('SELECT COUNT(*) as c FROM users WHERE role = "admin"') as { c: number }).c
    if (adminCount <= 1 && target.role === 'admin') {
      return NextResponse.json({ success: false, error: 'Cannot delete the last admin user' }, { status: 400 })
    }

    dbRun('DELETE FROM users WHERE id = ?', [id])
    await logUserAction('user.delete', { id: Number(user.userId), email: user.email || null }, id,
      { deleted_user_email: target.email, deleted_user_role: target.role }, request)

    return NextResponse.json({ success: true, message: 'User deleted successfully' })
  } catch (err) {
    console.error('Delete user error:', err)
    return NextResponse.json({ success: false, error: 'Failed to delete user' }, { status: 500 })
  }
}
