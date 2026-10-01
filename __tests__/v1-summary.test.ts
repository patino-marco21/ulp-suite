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

const sqls: string[] = []
let impl: (sql: string) => Promise<unknown[]>
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string) => {
    sqls.push(sql)
    return impl(sql)
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/summary/route'
import { resetSummaryCache, SUMMARY_TTL_MS, SUMMARY_RETRY_MS } from '@/lib/v1-summary'

const rowsFor = (n: number) => async (sql: string): Promise<unknown[]> => {
  if (sql.includes('FROM ulp.sources')) return [{ total_sources: '12', total_lines: '99' }]
  if (sql.includes('GROUP BY domain')) return [{ domain: 'gmail.com', count: String(n) }]
  return [{ total_credentials: String(n * 10), total_domains: String(n), unique_emails: String(n * 5) }]
}

const get = () => GET(new NextRequest('http://localhost/api/v1/summary'))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  sqls.length = 0
  impl = rowsFor(1)
  resetSummaryCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GET /api/v1/summary — bounded queries', () => {
  // Measured 2026-09-30 on 1.39B rows: exact countDistinct(domain/email) hit MEMORY_LIMIT_EXCEEDED after
  // 12.7 s (the endpoint returned 500 on every call); uniq() took 17.6 s with bounded memory.
  test('distinct counts are estimates (uniq), never an exact countDistinct / uniqExact', async () => {
    await get()
    const all = sqls.join('\n')
    expect(all).toContain('uniq(domain)')
    expect(all).toContain('uniq(email)')
    expect(all).not.toMatch(/countDistinct|uniqExact/)
  })

  test('the top-domains query aggregates in primary-key order, with a cap sized for a full-table read', async () => {
    await get()
    const top = sqls.find(s => s.includes('GROUP BY domain'))!
    expect(top).toContain('optimize_aggregation_in_order = 1')
    expect(top).toContain("timeout_overflow_mode = 'throw'")
    expect(top).toMatch(/max_execution_time = (\d+)/)
    expect(Number(top.match(/max_execution_time = (\d+)/)![1])).toBeGreaterThanOrEqual(60)
    const stats = sqls.find(s => s.includes('uniq(domain)'))!
    expect(Number(stats.match(/max_execution_time = (\d+)/)![1])).toBeGreaterThanOrEqual(60)
  })

  test('response keeps the documented fields and adds as_of / stale / approximate', async () => {
    impl = rowsFor(7)
    const json = await (await get()).json()
    expect(json).toMatchObject({
      success: true,
      stats: { credentials: 70, unique_domains: 7, unique_emails: 35, sources: 12 },
      top_domains: [{ domain: 'gmail.com', count: '7' }],
      as_of: '2026-10-01T00:00:00.000Z',
      stale: false,
      approximate: ['unique_domains', 'unique_emails'],
    })
  })
})

describe('GET /api/v1/summary — one scan serves many callers', () => {
  test('a second call inside the TTL does not touch ClickHouse', async () => {
    await get()
    const first = sqls.length
    expect(first).toBe(3)
    await get()
    expect(sqls).toHaveLength(first)
  })

  test('concurrent first calls share one computation', async () => {
    await Promise.all([get(), get(), get(), get()])
    expect(sqls).toHaveLength(3)
  })

  test('past the TTL the old value is returned at once, marked stale, and refreshed in the background', async () => {
    impl = rowsFor(1)
    await get()
    vi.setSystemTime(Date.now() + SUMMARY_TTL_MS + 1000)
    impl = rowsFor(2)
    const stale = await (await get()).json()
    expect(stale.stale).toBe(true)
    expect(stale.stats.unique_domains).toBe(1)
    await vi.waitFor(() => expect(sqls).toHaveLength(6))
    const fresh = await (await get()).json()
    expect(fresh.stale).toBe(false)
    expect(fresh.stats.unique_domains).toBe(2)
    expect(sqls).toHaveLength(6)
  })

  test('a failed refresh keeps serving the previous value and backs off before scanning again', async () => {
    await get()
    vi.setSystemTime(Date.now() + SUMMARY_TTL_MS + 1000)
    impl = async () => {
      throw new Error('MEMORY_LIMIT_EXCEEDED')
    }
    const during = await get()
    expect(during.status).toBe(200)
    await vi.waitFor(() => expect(sqls.length).toBeGreaterThan(3))
    const afterFailure = sqls.length
    const next = await get()
    expect(next.status).toBe(200)
    expect((await next.json()).stale).toBe(true)
    expect(sqls).toHaveLength(afterFailure)
    vi.setSystemTime(Date.now() + SUMMARY_RETRY_MS + 1000)
    impl = rowsFor(3)
    await get()
    await vi.waitFor(() => expect(sqls.length).toBeGreaterThan(afterFailure))
  })

  test('a failed first computation is a generic 500, and is not re-run by every request', async () => {
    impl = async () => {
      throw new Error('Code: 241 secret-host:9000')
    }
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret-host')
    const afterFirst = sqls.length
    expect((await get()).status).toBe(500)
    expect(sqls).toHaveLength(afterFirst)
    vi.setSystemTime(Date.now() + SUMMARY_RETRY_MS + 1000)
    impl = rowsFor(1)
    expect((await get()).status).toBe(200)
  })
})
