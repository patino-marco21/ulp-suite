import { NextRequest, NextResponse } from 'next/server'
import { dbGet } from '@/lib/sqlite'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
  try {
    const row = dbGet('SELECT COUNT(*) as count FROM users') as { count: number }
    const userCount = row?.count ?? 0
    return NextResponse.json({ success: true, userCount, needsInitialSetup: userCount === 0 })
  } catch (err) {
    console.error('Check users error:', err)
    return NextResponse.json({ success: true, userCount: 0, needsInitialSetup: true })
  }
}
