import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { id: 'test-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))

const calls: Array<{ sql: string; params: Record<string, unknown> | undefined }> = []
let impl: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]>
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params?: Record<string, unknown>) => {
    calls.push({ sql, params })
    return impl(sql, params)
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/summary/route'
import { resetSummaryCache, WINDOW_TTL_OPEN_MS, WINDOW_TTL_CLOSED_MS, WINDOW_CACHE_MAX } from '@/lib/v1-summary'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

const AFTER = '2026-10-18T10:00:00Z'
const AFTER_EPOCH = Date.UTC(2026, 9, 18, 10) / 1000
const NOW = new Date('2026-10-18T16:00:00Z')

let projectionReady = false
const answer = (n: number) => async (sql: string): Promise<unknown[]> => {
  if (sql.includes('system.projections')) {
    return projectionReady ? [{ defined: 1, parts: 2, with_projection: 2, covered_from: 1_700_000_000 }] : [{ defined: 0, parts: 2, with_projection: 0, covered_from: 0 }]
  }
  if (sql.includes('FROM ulp.sources')) return [{ total_sources: String(n) }]
  if (sql.includes('GROUP BY domain')) return [{ domain: 'gmail.com', count: String(n * 3) }]
  return [{ total_credentials: String(n * 10), total_domains: String(n * 2), unique_emails: String(n * 5) }]
}

const get = (qs = '') => GET(new NextRequest(`http://localhost/api/v1/summary${qs}`))
const windowCalls = () => calls.filter(c => !c.sql.includes('system.projections'))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  calls.length = 0
  projectionReady = false
  impl = answer(1)
  resetSummaryCache()
  resetNewestFirstReadyCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GET /api/v1/summary?imported_after=..&imported_before=..', () => {
  test.each([
    ['imported_after=yesterday', 'imported_after must be'],
    ['imported_after=2026-10-18&imported_before=2026-02-30', 'imported_before must be'],
  ])('%s is a 400 that names the parameter, and nothing is queried', async (qs, text) => {
    const res = await get(`?${qs}`)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain(text)
    expect(calls).toHaveLength(0)
  })

  test('an upper bound alone is refused: it is the whole table up to a date, the scan the cache exists to avoid', async () => {
    const res = await get('?imported_before=2026-10-18T10:00:00Z')
    expect(res.status).toBe(400)
    const error = (await res.json()).error as string
    expect(error).toContain('imported_before')
    expect(error).toContain('imported_after')
    expect(calls).toHaveLength(0)
  })

  test('no window is the table-wide summary, exactly as before (no predicate on imported_at)', async () => {
    await get('?something=else')
    expect(calls.length).toBe(3)
    expect(calls.every(c => !c.sql.includes('imported_at'))).toBe(true)
  })

  test('the answer has the table-wide shape for the rows added in the window, and repeats the effective window', async () => {
    impl = answer(7)
    const res = await get(`?imported_after=${AFTER}&imported_before=2026-10-18T12:00:00Z`)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({
      success: true,
      stats: { credentials: 70, unique_domains: 14, unique_emails: 35, sources: 7 },
      top_domains: [{ domain: 'gmail.com', count: '21' }],
      as_of: NOW.toISOString(),
      stale: false,
      approximate: ['unique_domains', 'unique_emails'],
      imported_after: AFTER,
      imported_before: '2026-10-18T12:00:00Z',
    })
  })

  test('an open top is echoed as null; the legacy date_from spelling is the same bound', async () => {
    const a = await (await get(`?imported_after=${AFTER}`)).json()
    expect(a.imported_before).toBeNull()
    calls.length = 0
    resetSummaryCache()
    const b = await (await get('?date_from=2026-10-18')).json()
    expect(b.imported_after).toBe('2026-10-17T23:59:59Z')
  })

  test('three bounded queries: estimates (uniq), never an exact count; the window is a parameter, not text', async () => {
    await get(`?imported_after=${AFTER}&imported_before=2026-10-18T12:00:00Z`)
    const qs = windowCalls()
    expect(qs).toHaveLength(3)
    const all = qs.map(q => q.sql).join('\n')
    expect(all).toContain('uniq(domain)')
    expect(all).toContain('uniq(email)')
    expect(all).not.toMatch(/countDistinct|uniqExact/)
    for (const q of qs) {
      expect(q.sql).toContain('imported_at > toDateTime({impAfter:Int64})')
      expect(q.sql).toContain('imported_at <= toDateTime({impBefore:Int64})')
      expect(q.params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: AFTER_EPOCH + 7200 })
    }
    for (const q of qs.filter(x => x.sql.includes('FROM ulp.credentials'))) {
      expect(q.sql).toContain("timeout_overflow_mode = 'throw'")
      expect(Number(q.sql.match(/max_execution_time = (\d+)/)![1])).toBeLessThanOrEqual(120)
    }
    expect(qs.find(q => q.sql.includes('GROUP BY domain'))!.sql).toContain('LIMIT 20')
  })

  test('the projection form (the same bound on proj_imported_desc\'s key) only when the projection is ready; the plain form otherwise', async () => {
    await get(`?imported_after=${AFTER}`)
    expect(windowCalls().every(c => !c.sql.includes(IMPORTED_KEY_EXPR))).toBe(true) // not ready: plain

    calls.length = 0
    resetSummaryCache()
    resetNewestFirstReadyCache()
    projectionReady = true
    await get(`?imported_after=${AFTER}`)
    const credentials = windowCalls().filter(c => c.sql.includes('FROM ulp.credentials'))
    expect(credentials).toHaveLength(2)
    for (const c of credentials) {
      expect(c.sql).toContain(`${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`)
      expect(c.sql).toContain('imported_at > toDateTime({impAfter:Int64})') // the plain bound is still there: the projection form only ADDS
    }
    // the sources table has no projection: it gets the plain bound only
    expect(windowCalls().find(c => c.sql.includes('FROM ulp.sources'))!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('a timeout is a 408 that says how to narrow the window; any other failure is a plain 500', async () => {
    impl = async () => { throw new Error('Code: 159. DB::Exception: Timeout exceeded') }
    const slow = await get(`?imported_after=${AFTER}`)
    expect(slow.status).toBe(408)
    const body = await slow.json()
    expect(body).toMatchObject({ success: false, timed_out: true })
    expect(body.error).toContain('narrow')

    resetSummaryCache()
    impl = async () => { throw new Error('boom') }
    expect((await get(`?imported_after=${AFTER}`)).status).toBe(500)
  })
})

describe('GET /api/v1/summary?imported_after=.. — one computation serves many callers', () => {
  test('the same window again inside the TTL does not touch ClickHouse; another window does', async () => {
    await get(`?imported_after=${AFTER}`)
    const first = windowCalls().length
    await get(`?imported_after=${AFTER}`)
    expect(windowCalls()).toHaveLength(first)
    await get('?imported_after=2026-10-18T11:00:00Z')
    expect(windowCalls().length).toBe(first * 2)
  })

  test('concurrent identical requests share one computation', async () => {
    await Promise.all([get(`?imported_after=${AFTER}`), get(`?imported_after=${AFTER}`), get(`?imported_after=${AFTER}`)])
    expect(windowCalls()).toHaveLength(3)
  })

  test('a window that is still open at the top is kept for two minutes (rows keep arriving), one that closed long ago for ten', async () => {
    await get(`?imported_after=${AFTER}`)
    await get('?imported_after=2026-10-17T00:00:00Z&imported_before=2026-10-17T12:00:00Z')
    const first = windowCalls().length
    expect(first).toBe(6)

    vi.setSystemTime(NOW.getTime() + WINDOW_TTL_OPEN_MS - 1000)
    await get(`?imported_after=${AFTER}`)
    expect(windowCalls()).toHaveLength(first) // still fresh

    vi.setSystemTime(NOW.getTime() + WINDOW_TTL_OPEN_MS + 1000)
    await get(`?imported_after=${AFTER}`)
    expect(windowCalls()).toHaveLength(first + 3) // the open window was recomputed
    await get('?imported_after=2026-10-17T00:00:00Z&imported_before=2026-10-17T12:00:00Z')
    expect(windowCalls()).toHaveLength(first + 3) // the closed one was not

    vi.setSystemTime(NOW.getTime() + WINDOW_TTL_CLOSED_MS + 1000)
    await get('?imported_after=2026-10-17T00:00:00Z&imported_before=2026-10-17T12:00:00Z')
    expect(windowCalls().length).toBe(first + 6)
  })

  test('a failure is not remembered: the next request tries again', async () => {
    impl = async () => { throw new Error('boom') }
    expect((await get(`?imported_after=${AFTER}`)).status).toBe(500)
    impl = answer(2)
    const ok = await get(`?imported_after=${AFTER}`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).stats.credentials).toBe(20)
  })

  test(`at most ${WINDOW_CACHE_MAX} windows are kept: the oldest is forgotten first`, async () => {
    for (let i = 0; i < WINDOW_CACHE_MAX + 1; i++) await get(`?imported_after=2026-10-18T10:00:${String(i).padStart(2, '0')}Z`)
    const before = windowCalls().length
    await get('?imported_after=2026-10-18T10:00:00Z') // the first one was evicted
    expect(windowCalls().length).toBeGreaterThan(before)
    const mid = windowCalls().length
    await get(`?imported_after=2026-10-18T10:00:${String(WINDOW_CACHE_MAX).padStart(2, '0')}Z`) // the newest is still there
    expect(windowCalls()).toHaveLength(mid)
  })
})
