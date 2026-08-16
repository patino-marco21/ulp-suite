import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue(null),
}))

import { middleware, config } from '@/middleware'

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

describe('middleware — /api/auth/logout self-guard gap', () => {
  it('treats /api/auth/logout as public (must clear an expired/invalid cookie without requiring a valid one)', async () => {
    const req = new NextRequest(new URL('http://localhost/api/auth/logout'), { method: 'POST' })
    const res = await middleware(req)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('middleware — config.matcher excludes /api (prevents Next.js from cloning API request bodies into memory)', () => {
  // Mirrors the documented idiom for this matcher form (a regex source
  // matched against the pathname): does NOT replicate Next.js's full
  // build-time compiler (which layers in RSC-suffix / _next/data-prefix /
  // locale handling — irrelevant here since this app has no i18n config and
  // none of that wrapping changes whether the /api exclusion itself matches).
  function isMatched(pathname: string): boolean {
    return config.matcher.some((source) => new RegExp(`^${source}$`).test(pathname))
  }

  it('excludes ordinary /api routes (these self-guard via validateRequest/withApiKeyAuth)', () => {
    expect(isMatched('/api/upload')).toBe(false)
    expect(isMatched('/api/credentials')).toBe(false)
    expect(isMatched('/api/v1/search/domain')).toBe(false)
  })

  it('excludes /api/auth/logout (guarded by PUBLIC_PATHS instead, not the JWT gate)', () => {
    expect(isMatched('/api/auth/logout')).toBe(false)
  })

  it('still matches /api/auth/login and /api/auth/verify-totp (their brute-force rate limiter lives inside middleware() itself)', () => {
    expect(isMatched('/api/auth/login')).toBe(true)
    expect(isMatched('/api/auth/verify-totp')).toBe(true)
  })

  it('still matches ordinary page paths (JWT gate unchanged for pages)', () => {
    expect(isMatched('/dashboard')).toBe(true)
    expect(isMatched('/')).toBe(true)
  })

  it('still excludes static/image/favicon paths (pre-existing behavior, unchanged)', () => {
    expect(isMatched('/_next/static/chunks/1.js')).toBe(false)
    expect(isMatched('/_next/image')).toBe(false)
    expect(isMatched('/favicon.ico')).toBe(false)
  })
})
