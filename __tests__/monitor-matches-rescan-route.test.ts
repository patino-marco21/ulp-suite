import { readFileSync } from 'fs'
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn(),
  requireAdminRole: vi.fn(),
}))

// tryAcquireRescanLock/releaseRescanLock are passed through to their REAL
// implementation (only resolveMonitorMatches is a mock) — final-review Fix 1
// moved the in-flight-rescan lock here so the route and the cron
// (lib/monitor-rescan-cron.ts) share it. The concurrency tests below need
// genuine has()/add()/delete() Set behavior to prove anything real; a
// vi.fn() stub would just re-assert whatever the test hard-codes it to
// return. MATCH_LIMIT is likewise passed through since final-review Fix 3
// made the route import it (rather than redeclare its own copy) from here.
vi.mock('@/lib/monitor-match-resolver', async () => {
  const actual = await vi.importActual<typeof import('@/lib/monitor-match-resolver')>('@/lib/monitor-match-resolver')
  return {
    resolveMonitorMatches: vi.fn(),
    MATCH_LIMIT: actual.MATCH_LIMIT,
    tryAcquireRescanLock: actual.tryAcquireRescanLock,
    releaseRescanLock: actual.releaseRescanLock,
  }
})

vi.mock('@/lib/domain-monitor', () => ({
  getMonitor: vi.fn(),
  writeMonitorMatchCache: vi.fn().mockResolvedValue(undefined),
  recordMonitorRescanFailure: vi.fn().mockResolvedValue(undefined),
  getMonitorMatchesCache: vi.fn(),
  markMatchesNewSinceLastView: vi.fn(async (_id: number, _uid: number, rows: unknown[]) =>
    (rows as Record<string, unknown>[]).map(r => ({ ...r, is_new: false }))),
  recordMonitorViewed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/rate-limiter', () => ({
  checkLimit: vi.fn().mockReturnValue({ allowed: true, resetAt: 0 }),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}))

import { POST } from '@/app/api/monitoring/monitors/[id]/matches/rescan/route'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { getMonitor, writeMonitorMatchCache, recordMonitorRescanFailure, getMonitorMatchesCache } from '@/lib/domain-monitor'
import { checkLimit } from '@/lib/rate-limiter'
import { NextRequest } from 'next/server'

const mockValidateRequest = vi.mocked(validateRequest)
const mockRequireAdminRole = vi.mocked(requireAdminRole)
const mockResolveMonitorMatches = vi.mocked(resolveMonitorMatches)
const mockGetMonitor = vi.mocked(getMonitor)
const mockWriteMonitorMatchCache = vi.mocked(writeMonitorMatchCache)
const mockRecordMonitorRescanFailure = vi.mocked(recordMonitorRescanFailure)
const mockGetMonitorMatchesCache = vi.mocked(getMonitorMatchesCache)
const mockCheckLimit = vi.mocked(checkLimit)

const ADMIN_USER = { userId: '1', role: 'admin' }
const MONITOR = { id: 1, name: 'Wallets', domains: ['trezor.io'], match_mode: 'url' as const, is_active: true }

function req() {
  return new NextRequest('http://localhost/api/monitoring/monitors/1/matches/rescan', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateRequest.mockResolvedValue(ADMIN_USER as never)
  mockRequireAdminRole.mockReturnValue(null as never)
  mockCheckLimit.mockReturnValue({ allowed: true, resetAt: 0 })
  mockGetMonitor.mockResolvedValue(MONITOR as never)
  mockGetMonitorMatchesCache.mockResolvedValue({ rows: [], status: 'ok', checkedAt: '2026-08-25 00:00:00', lastError: null })
})

describe('POST .../matches/rescan', () => {
  test('non-admin is rejected before any ClickHouse call', async () => {
    mockRequireAdminRole.mockReturnValue(new Response(null, { status: 403 }) as never)

    await POST(req(), { params: Promise.resolve({ id: '1' }) })

    expect(mockResolveMonitorMatches).not.toHaveBeenCalled()
  })

  test('on success, writes the cache and returns the fresh cache read', async () => {
    mockResolveMonitorMatches.mockResolvedValue({ rows: [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io' }], limited: false })
    mockGetMonitorMatchesCache.mockResolvedValue({
      rows: [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io' }],
      status: 'ok', checkedAt: '2026-08-25 00:00:01', lastError: null,
    })

    const res = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    const data = await res.json()

    expect(mockWriteMonitorMatchCache).toHaveBeenCalledWith(1, [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io' }])
    expect(data.success).toBe(true)
    expect(data.results).toHaveLength(1)
    expect(data.checked_at).toBe('2026-08-25 00:00:01')
    // final-review Fix 6: field-for-field symmetry with the GET route's
    // response shape, which already includes never_scanned.
    expect(data.never_scanned).toBe(false)
  })

  test('on resolver failure, records the failure and still returns success:true with last_error (a stale/empty cache read is not itself a request failure)', async () => {
    mockResolveMonitorMatches.mockRejectedValue(new Error('Timeout exceeded'))
    mockGetMonitorMatchesCache.mockResolvedValue({ rows: [], status: 'failed', checkedAt: null, lastError: 'Timeout exceeded' })

    const res = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    const data = await res.json()

    expect(mockRecordMonitorRescanFailure).toHaveBeenCalledWith(1, 'Timeout exceeded')
    expect(data.success).toBe(true)
    expect(data.last_error).toBe('Timeout exceeded')
  })

  test('two concurrent rescans of the same monitor: the second is rejected with 409, not a duplicate ClickHouse query', async () => {
    let resolveFirst!: (v: { rows: never[]; limited: boolean }) => void
    mockResolveMonitorMatches.mockReturnValueOnce(new Promise(r => { resolveFirst = r }))

    const first = POST(req(), { params: Promise.resolve({ id: '1' }) })
    // Let the first request's synchronous setup (including acquiring the lock) run.
    await new Promise(r => setTimeout(r, 0))

    const second = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    expect(second.status).toBe(409)

    resolveFirst({ rows: [], limited: false })
    await first
    expect(mockResolveMonitorMatches).toHaveBeenCalledTimes(1)
  })

  test('rate limited returns 429', async () => {
    mockCheckLimit.mockReturnValue({ allowed: false, resetAt: Date.now() + 5000 })

    const res = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(429)
    expect(mockResolveMonitorMatches).not.toHaveBeenCalled()
  })
})

describe('POST .../matches/rescan — lock acquisition is atomic (final-review Fix 1: lock now shared via lib/monitor-match-resolver.ts)', () => {
  // The behavioral test above ("two concurrent rescans...") only proves that
  // a SECOND request started after the first has fully settled its
  // synchronous setup (the `setTimeout(0)` gap) is rejected. It cannot prove
  // atomicity against a genuinely interleaved race — e.g. two admins' POSTs
  // both suspended on their own `validateRequest` await, resuming in
  // whatever order the microtask queue happens to drain them — because JS
  // only guarantees run-to-completion across a single synchronous stretch,
  // not across an `await`. This test pins that stretch directly by source
  // inspection: if a future edit ever inserts an `await` between the has()
  // check and the add() write inside tryAcquireRescanLock (e.g. "cleaning
  // up" by making the check itself async), two truly concurrent callers —
  // this route AND the cron, now that they share one lock — could both pass
  // the check before either performs the write, silently reopening the
  // check-then-act race the lock exists to close — and unlike a
  // timing-based test, this one can't flake and can't be fooled by a
  // convenient gap.
  //
  // This now lives in lib/monitor-match-resolver.ts, not this route — Fix 1
  // moved the lock there specifically so the rescan cron
  // (lib/monitor-rescan-cron.ts) can share it instead of racing a
  // route-private Set it could never see.
  test('has() and add() are separated by no await', () => {
    const resolverSource = readFileSync(
      new URL('../lib/monitor-match-resolver.ts', import.meta.url),
      'utf8'
    )
    const checkIdx = resolverSource.indexOf('inFlightRescans.has(monitorId)')
    const addIdx = resolverSource.indexOf('inFlightRescans.add(monitorId)')
    expect(checkIdx).toBeGreaterThan(-1)
    expect(addIdx).toBeGreaterThan(checkIdx)

    const between = resolverSource.slice(checkIdx, addIdx)
    expect(between).not.toContain('await')
  })

  test('the route releases the lock in a finally so a thrown error cannot leave a monitor permanently locked', () => {
    const routeSource = readFileSync(
      new URL('../app/api/monitoring/monitors/[id]/matches/rescan/route.ts', import.meta.url),
      'utf8'
    )
    const acquireIdx = routeSource.indexOf('tryAcquireRescanLock(monitorId)')
    const releaseIdx = routeSource.indexOf('releaseRescanLock(monitorId)')
    expect(acquireIdx).toBeGreaterThan(-1)
    expect(releaseIdx).toBeGreaterThan(acquireIdx)
    // The release call must be the first statement inside a `finally`
    // block, not on a success-only path that a thrown error could skip.
    expect(routeSource.slice(0, releaseIdx)).toMatch(/finally\s*\{\s*$/)
  })
})
