import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let totalsRow: Record<string, unknown> = { total: '7', raw_total: '9' }
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return /\) AS t\s/.test(sql) ? [] : [totalsRow]
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'

const isTotals = (sql: string) => /AS raw_total/.test(sql)
const isData = (sql: string) => /\) AS t\s/.test(sql)

async function call(qs: string) {
  calls.length = 0
  const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
  return { res, body: await res.json(), totals: calls.filter(c => isTotals(c.sql)), data: calls.filter(c => isData(c.sql)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  totalsRow = { total: '7', raw_total: '9' }
})

describe('credentials route — both totals come from ONE scan of the search predicate', () => {
  test('a filtered, deduped, decluttered search asks for uniqIf and count() in a single query', async () => {
    const { totals, data } = await call('q=binance.com&dedupe=1&exclude_noise=1')
    expect(totals).toHaveLength(1)
    expect(data).toHaveLength(1)
    const { sql } = totals[0]
    expect(sql).toContain('uniqIf(content_key_hash, is_noise = 0) AS total')
    expect(sql).toContain('count() AS raw_total')
  })

  test('the noise filter lives in the aggregate, not the WHERE (so raw_total can be the unrestricted count)', async () => {
    const { totals } = await call('q=binance.com&dedupe=1&exclude_noise=1')
    const where = totals[0].sql.slice(totals[0].sql.indexOf('WHERE'), totals[0].sql.indexOf('SETTINGS'))
    expect(where).not.toContain('is_noise')
  })

  test.each([
    // [querystring, expected total expression]
    ['q=x&dedupe=1&exclude_noise=1', 'uniqIf(content_key_hash, is_noise = 0) AS total'],
    ['dedupe=1&exclude_noise=1', 'countIf(is_noise = 0) AS total'],
    ['q=x&dedupe=1', 'uniq(content_key_hash) AS total'],
    ['q=x&exclude_noise=1', 'countIf(is_noise = 0) AS total'],
    ['q=x', 'count() AS total'],
    ['', 'count() AS total'],
  ])('%s -> %s', async (qs, expected) => {
    const { totals } = await call(qs)
    expect(totals[0].sql).toContain(expected)
  })

  test('the response carries both numbers as numbers', async () => {
    const { body } = await call('q=x&dedupe=1&exclude_noise=1')
    expect(body.total).toBe(7)
    expect(body.raw_total).toBe(9)
  })
})

describe('credentials route — projection choice for the totals', () => {
  // Measured cold on 1.39B rows: the planner takes proj_imported_desc as a thin covering copy for a
  // domain-token raw count and scans all of it (32.6 s) where the base table needs 11.0 s.
  test('turns projections off for a search with no date range', async () => {
    const { totals } = await call('q=binance.com&dedupe=1&exclude_noise=1')
    expect(totals[0].sql).toContain('optimize_use_projections = 0')
  })

  test.each(['date_from=2026-08-01', 'date_to=2026-08-31', 'date_from=2026-08-01&date_to=2026-08-31'])(
    'keeps the planner free to prune through the imported_at projection when %s',
    async qs => {
      const { totals } = await call(`q=x&${qs}`)
      expect(totals[0].sql).not.toContain('optimize_use_projections')
    },
  )

  test('keeps the break / no-result-cache settings the counts always had', async () => {
    const { totals } = await call('q=x')
    expect(totals[0].sql).toContain(`timeout_overflow_mode = 'break'`)
    expect(totals[0].sql).toContain('use_query_cache = 0')
    expect(totals[0].sql).toContain('max_execution_time = 300')
  })
})

describe('credentials route — skip_totals / totals_only (the page fetches totals separately)', () => {
  test('default: one totals query and one data query, as before', async () => {
    const { totals, data } = await call('q=x')
    expect(totals).toHaveLength(1)
    expect(data).toHaveLength(1)
  })

  test('skip_totals=1 runs only the data query and returns null totals', async () => {
    const { totals, data, body } = await call('q=x&skip_totals=1')
    expect(totals).toHaveLength(0)
    expect(data).toHaveLength(1)
    expect(body.success).toBe(true)
    expect(body.total).toBeNull()
    expect(body.raw_total).toBeNull()
    expect(Array.isArray(body.results)).toBe(true)
  })

  test('totals_only=1 runs only the totals query and returns no rows', async () => {
    const { totals, data, body } = await call('q=x&dedupe=1&exclude_noise=1&totals_only=1')
    expect(data).toHaveLength(0)
    expect(totals).toHaveLength(1)
    expect(body).toMatchObject({ success: true, total: 7, raw_total: 9 })
    expect(body.results).toBeUndefined()
    expect(typeof body.query_ms).toBe('number')
  })

  test('totals_only=1 ignores a cursor (the totals describe the whole result set)', async () => {
    const cursor = Buffer.from(JSON.stringify({ sort: 'domain_asc', v: { domain: 'a', email: 'b', imported_at: '2026-01-01 00:00:00', url: 'u', password: 'p' } })).toString('base64')
    const { totals } = await call(`q=x&totals_only=1&cursor=${cursor}`)
    expect(totals).toHaveLength(1)
  })

  test('a cursor page without totals_only still skips the totals (the client keeps the page-1 total)', async () => {
    const cursor = Buffer.from(JSON.stringify({ sort: 'domain_asc', v: { domain: 'a', email: 'b', imported_at: '2026-01-01 00:00:00', url: 'u', password: 'p' } })).toString('base64')
    const { totals, data, body } = await call(`q=x&cursor=${cursor}`)
    expect(totals).toHaveLength(0)
    expect(data).toHaveLength(1)
    expect(body.total).toBeNull()
  })

  test('totals_only and the data query use the same filters, so the two requests describe one search', async () => {
    const qs = 'q=binance.com&domain=binance.com&exclude_noise=1&dedupe=1&date_from=2026-08-01'
    const t = await call(`${qs}&totals_only=1`)
    const d = await call(`${qs}&skip_totals=1`)
    // The predicate between WHERE and the next clause, whitespace-normalized. The data query additionally
    // carries the noise filter in its WHERE (the totals put it inside the aggregate instead).
    const predicate = (sql: string) =>
      sql.slice(sql.indexOf('WHERE') + 'WHERE'.length).split(/\s(?:ORDER BY|SETTINGS|LIMIT)\b/)[0].replace(/\s+/g, ' ').trim()
    expect(predicate(d.data[0].sql).replace(' AND is_noise = 0', '')).toBe(predicate(t.totals[0].sql))
  })
})
