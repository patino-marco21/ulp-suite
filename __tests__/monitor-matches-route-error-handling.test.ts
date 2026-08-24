/**
 * Behavioral coverage for app/api/monitoring/monitors/[id]/matches/route.ts's
 * error handling around its two SQLite calls (getMonitor, recordMonitorViewed).
 *
 * __tests__/monitor-matches-route.test.ts pins the ClickHouse query plan via
 * source-text assertions, which is the right tool for SQL shape but proves
 * nothing about what happens when a dependency throws. This file instead mocks
 * every dependency and drives the actual GET handler, since that's the only way
 * to observe the difference between "caught, degraded gracefully" and "an
 * otherwise-good response turns into a 500".
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn(),
}))

vi.mock('@/lib/domain-monitor', () => ({
  getMonitor: vi.fn(),
  markMatchesNewSinceLastView: vi.fn(),
  recordMonitorViewed: vi.fn(),
}))

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(),
}))

import { validateRequest } from '@/lib/auth'
import { getMonitor, markMatchesNewSinceLastView, recordMonitorViewed } from '@/lib/domain-monitor'
import { executeQuery } from '@/lib/clickhouse'
import { GET } from '@/app/api/monitoring/monitors/[id]/matches/route'

const mockValidateRequest = vi.mocked(validateRequest)
const mockGetMonitor = vi.mocked(getMonitor)
const mockMarkNew = vi.mocked(markMatchesNewSinceLastView)
const mockRecordViewed = vi.mocked(recordMonitorViewed)
const mockExecuteQuery = vi.mocked(executeQuery)

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

// Each request gets its own IP so the route's per-IP rate limiter (a
// module-level Map, shared across every test in this file) never trips.
let ipCounter = 0
function req() {
  ipCounter++
  return new NextRequest('http://localhost/api/monitoring/monitors/1/matches', {
    headers: { 'x-forwarded-for': `10.0.0.${ipCounter}` },
  })
}

function params(id = '1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateRequest.mockResolvedValue({ userId: '7', role: 'user' } as any)
  mockGetMonitor.mockResolvedValue(MONITOR as any)
  mockMarkNew.mockResolvedValue([MATCH_ROW] as any)
  mockRecordViewed.mockResolvedValue(undefined)
  // Phase 1/2 ClickHouse plan is exercised for real (only its dependencies are
  // mocked), but every branch resolves to an empty page — irrelevant here
  // since markMatchesNewSinceLastView is mocked and returns MATCH_ROW
  // regardless of what rows it's called with.
  mockExecuteQuery.mockResolvedValue([])
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

describe('GET matches — getMonitor errors are caught', () => {
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
})

describe('GET matches — empty domain set', () => {
  test('includes new_count alongside the other fields every other success path returns', async () => {
    mockGetMonitor.mockResolvedValue({ ...MONITOR, domains: [] } as any)

    const res = await GET(req(), params())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, results: [], total_shown: 0, new_count: 0, limited: false })
  })
})
