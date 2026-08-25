/**
 * Behavioral coverage for app/api/monitoring/monitors/[id]/matches/route.ts's
 * error handling around its SQLite calls (getMonitor, getMonitorMatchesCache,
 * recordMonitorViewed).
 *
 * Task 9 removed this route's ClickHouse call entirely — it now only reads
 * the SQLite cache the rescan cron / manual rescan endpoint already
 * populated, via getMonitorMatchesCache. __tests__/monitor-matches-route.test.ts
 * covers the query-plan source-text guards (for lib/monitor-match-resolver.ts,
 * still used by those other two callers) and this route's own shape; this
 * file mocks every dependency and drives the actual GET handler, since that's
 * the only way to observe the difference between "caught, degraded
 * gracefully" and "an otherwise-good response turns into a 500".
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn(),
}))

vi.mock('@/lib/domain-monitor', () => ({
  getMonitor: vi.fn(),
  getMonitorMatchesCache: vi.fn(),
  markMatchesNewSinceLastView: vi.fn(),
  recordMonitorViewed: vi.fn(),
}))

import { validateRequest } from '@/lib/auth'
import { getMonitor, getMonitorMatchesCache, markMatchesNewSinceLastView, recordMonitorViewed } from '@/lib/domain-monitor'
import { GET } from '@/app/api/monitoring/monitors/[id]/matches/route'

const mockValidateRequest = vi.mocked(validateRequest)
const mockGetMonitor = vi.mocked(getMonitor)
const mockGetMonitorMatchesCache = vi.mocked(getMonitorMatchesCache)
const mockMarkNew = vi.mocked(markMatchesNewSinceLastView)
const mockRecordViewed = vi.mocked(recordMonitorViewed)

const MONITOR = {
  id: 1,
  name: 'Test Monitor',
  domains: ['aave.com'],
  match_mode: 'both' as const,
  is_active: true,
  created_by: 1,
  last_triggered_at: null,
  total_alerts: 0,
  rescan_mode: 'dedup' as const,
  rescan_interval_hours: 24,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
}

const MATCH_ROW = { url: 'https://aave.com/login', email: 'a@b.com', password: 'p', domain: 'aave.com', is_new: true }

function req() {
  return new NextRequest('http://localhost/api/monitoring/monitors/1/matches')
}

function params(id = '1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateRequest.mockResolvedValue({ userId: '7', role: 'user' } as any)
  mockGetMonitor.mockResolvedValue(MONITOR as any)
  mockGetMonitorMatchesCache.mockResolvedValue({
    rows: [{ url: 'https://aave.com/login', email: 'a@b.com', password: 'p', domain: 'aave.com' }],
    status: 'ok', checkedAt: '2026-08-25 00:00:00', lastError: null,
  })
  mockMarkNew.mockResolvedValue([MATCH_ROW] as any)
  mockRecordViewed.mockResolvedValue(undefined)
})

describe('GET matches — recordMonitorViewed is best-effort', () => {
  test('a recordMonitorViewed failure does not turn a successful match query into a 500', async () => {
    mockRecordViewed.mockRejectedValue(new Error('SQLITE_READONLY'))

    const res = await GET(req(), params())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.results).toEqual([MATCH_ROW])
    expect(json.new_count).toBe(1)
  })

  test('still calls recordMonitorViewed after markMatchesNewSinceLastView on the success path', async () => {
    const order: string[] = []
    mockMarkNew.mockImplementation(async () => {
      order.push('mark')
      return [MATCH_ROW] as any
    })
    mockRecordViewed.mockImplementation(async () => {
      order.push('record')
    })

    await GET(req(), params())

    expect(order).toEqual(['mark', 'record'])
  })
})

describe('GET matches — getMonitor / getMonitorMatchesCache errors are caught', () => {
  test('a getMonitor failure returns a structured 500 instead of throwing out of the handler', async () => {
    mockGetMonitor.mockRejectedValue(new Error('database is locked'))

    const res = await GET(req(), params())
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBe(false)
  })

  test('a missing monitor still 404s (guards the getMonitor try/catch refactor)', async () => {
    mockGetMonitor.mockResolvedValue(null as any)

    const res = await GET(req(), params())
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json).toEqual({ success: false, error: 'Monitor not found' })
  })

  // Task 9's replacement for the coverage that used to live in
  // __tests__/monitor-matches-route.test.ts as a source-text guard on the
  // ClickHouse-timeout-408 branch: that branch no longer exists (a SQLite
  // cache read has no ClickHouse-shaped failure mode), so a thrown cache read
  // now falls through to this route's one remaining error path — the same
  // generic 500 a getMonitor failure produces above.
  test('a getMonitorMatchesCache failure returns a structured 500 instead of throwing out of the handler', async () => {
    mockGetMonitorMatchesCache.mockRejectedValue(new Error('database is locked'))

    const res = await GET(req(), params())
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBe(false)
  })
})

describe('GET matches — the cache read no longer branches on domains', () => {
  // The old live-query route short-circuited before ever calling ClickHouse
  // when a monitor had no domains configured (an empty IN-list would have
  // matched every domain-less row). The cache read has no such foot-gun —
  // getMonitorMatchesCache is keyed by monitor_id, not by the domain list —
  // so Task 9 dropped that branch entirely. This pins that the route now
  // just reads whatever the cache holds, regardless of monitor.domains, and
  // that an unscanned monitor reads as never_scanned rather than as an error
  // or a bare empty list with no explanation.
  test('a monitor with an empty domain list still reads the cache normally (no special-cased short-circuit)', async () => {
    mockGetMonitor.mockResolvedValue({ ...MONITOR, domains: [] } as any)
    mockGetMonitorMatchesCache.mockResolvedValue({ rows: [], status: 'never_scanned', checkedAt: null, lastError: null })
    mockMarkNew.mockResolvedValue([] as any)

    const res = await GET(req(), params())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      success: true,
      results: [],
      total_shown: 0,
      new_count: 0,
      limited: false,
      checked_at: null,
      never_scanned: true,
      last_error: null,
    })
    expect(mockGetMonitorMatchesCache).toHaveBeenCalledWith(1)
  })
})
