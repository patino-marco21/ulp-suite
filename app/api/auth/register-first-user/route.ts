import { NextRequest, NextResponse } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import bcrypt from 'bcryptjs'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const { email, password, name } = await request.json()

    if (!email || !password || !name) {
      return NextResponse.json({ success: false, error: 'Email, password, and name are required' }, { status: 400 })
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'Invalid email format' }, { status: 400 })
    }

    if (password.length < 12) {
      return NextResponse.json({ success: false, error: 'Password must be at least 12 characters long' }, { status: 400 })
    }
    if (!/[A-Z]/.test(password)) {
      return NextResponse.json({ success: false, error: 'Password must contain at least one uppercase letter' }, { status: 400 })
    }
    if (!/[a-z]/.test(password)) {
      return NextResponse.json({ success: false, error: 'Password must contain at least one lowercase letter' }, { status: 400 })
    }
    if (!/[0-9]/.test(password)) {
      return NextResponse.json({ success: false, error: 'Password must contain at least one number' }, { status: 400 })
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return NextResponse.json({ success: false, error: 'Password must contain at least one special character' }, { status: 400 })
    }

    // Atomically check + insert: only succeeds when no users exist
    const existingCount = (dbGet('SELECT COUNT(*) as c FROM users') as { c: number }).c
    if (existingCount > 0) {
      return NextResponse.json({ success: false, error: 'Registration is only allowed when no users exist.' }, { status: 403 })
    }

    const hash = await bcrypt.hash(password, 12)
    dbRun(`INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`, [email, hash, name])

    return NextResponse.json({ success: true, message: 'First user created successfully. You can now login.', user: { email, name } })
  } catch (err: unknown) {
    console.error('Register first user error:', err)
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      return NextResponse.json({ success: false, error: 'Email already exists' }, { status: 400 })
    }
    return NextResponse.json({ success: false, error: 'Failed to create user' }, { status: 500 })
  }
}
