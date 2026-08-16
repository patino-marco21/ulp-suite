import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue(null),
}))

import { middleware } from '@/middleware'

describe('middleware — removed db-sync feature', () => {
  it('no longer treats /db-sync as a public path (page was deleted in 114c696)', async () => {
    const req = new NextRequest(new URL('http://localhost/db-sync'))
    const res = await middleware(req)
    expect(res.headers.get('location') ?? '').toContain('/login')
  })

  it('no longer treats /api/db-sync as a public path (route was deleted in 114c696)', async () => {
    const req = new NextRequest(new URL('http://localhost/api/db-sync'))
    const res = await middleware(req)
    expect(res.headers.get('location') ?? '').toContain('/login')
  })
})
