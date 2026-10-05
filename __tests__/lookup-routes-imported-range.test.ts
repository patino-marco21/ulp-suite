import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { id: 'test-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const READY = { defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }
let readiness: Array<Record<string, unknown>> = [READY]
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    if (/count\(\) AS total/i.test(sql)) return [{ total: '5' }]
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET as v1Search } from '@/app/api/v1/search/credentials/route'
import { GET as v1Domain } from '@/app/api/v1/search/domain/route'
import { GET as v1Lookup } from '@/app/api/v1/lookup/route'
import { POST as v1Batch } from '@/app/api/v1/lookup/batch/route'
import { POST as uiBatch } from '@/app/api/lookup/batch/route'
import { GET as legacySearch } from '@/app/api/search/route'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

const AFTER = '2026-08-28T23:30:00Z'
const BEFORE = '2026-08-29T00:30:00Z'
const AFTER_EPOCH = 1_787_959_800
const BEFORE_EPOCH = AFTER_EPOCH + 3600
const WINDOW_PARAMS = `imported_after=${encodeURIComponent(AFTER)}&imported_before=${encodeURIComponent(BEFORE)}`
const PLAIN_AFTER = 'imported_at > toDateTime({impAfter:Int64})'
const PLAIN_BEFORE = 'imported_at <= toDateTime({impBefore:Int64})'
const KEY_HI = `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`

const getUrl = (handler: (r: NextRequest) => Promise<Response>, url: string) => handler(new NextRequest(`http://localhost${url}`))
const postJson = (handler: (r: NextRequest) => Promise<Response>, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))
const metaCalls = () => calls.filter(c => /system\.projections/.test(c.sql))
const queryCalls = () => calls.filter(c => !/system\.projections/.test(c.sql))

beforeEach(() => {
  calls.length = 0
  readiness = [READY]
  resetNewestFirstReadyCache()
})

describe('GET /api/v1/search/credentials — imported_after / imported_before', () => {
  test('an invalid bound is a 400 that names the parameter, and nothing reaches ClickHouse (even with no query text)', async () => {
    for (const qs of ['q=binance.com&imported_after=yesterday', 'imported_before=nope']) {
      const res = await getUrl(v1Search, `/api/v1/search/credentials?${qs}`)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/^imported_(after|before) must be/)
    }
    expect(calls).toHaveLength(0)
  })

  test('a domain search: the rows (ORDER BY imported_at DESC) and the count both carry the bound; both may use the projection form', async () => {
    const res = await getUrl(v1Search, `/api/v1/search/credentials?q=binance.com&${WINDOW_PARAMS}`)
    const body = await res.json()
    const count = calls.find(c => /count\(\) as total/i.test(c.sql))!
    const rows = calls.find(c => /ORDER BY imported_at DESC/.test(c.sql))!
    for (const c of [count, rows]) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).toContain(PLAIN_BEFORE)
      expect(c.sql).toContain(KEY_HI)
      expect(c.params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH, impKeyHi: -AFTER_EPOCH })
    }
    expect(body.imported_after).toBe(AFTER)
    expect(body.imported_before).toBe(BEFORE)
  })

  test('a word search keeps the plain bound only (a projection has no text index)', async () => {
    await getUrl(v1Search, `/api/v1/search/credentials?q=ledger&imported_after=${encodeURIComponent(AFTER)}`)
    for (const c of queryCalls()) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).not.toContain(IMPORTED_KEY_EXPR)
      expect(c.sql).not.toContain('use_skip_indexes')
    }
    expect(metaCalls()).toHaveLength(0)
  })

  test('the old date_from works here too, as a whole UTC day', async () => {
    await getUrl(v1Search, '/api/v1/search/credentials?q=ledger&date_from=2026-08-28')
    expect(queryCalls()[0].params).toMatchObject({ impAfter: Date.UTC(2026, 7, 28) / 1000 - 1 })
  })

  test('no bound: nothing added to the SQL, no readiness query, and the response keeps its exact shape', async () => {
    const res = await getUrl(v1Search, '/api/v1/search/credentials?q=binance.com')
    const body = await res.json()
    for (const c of queryCalls()) expect(c.sql).not.toContain('impAfter')
    expect(metaCalls()).toHaveLength(0)
    expect(body).not.toHaveProperty('imported_after')
    expect(body).not.toHaveProperty('imported_before')
    expect(Object.keys(body).sort()).toEqual(['next_cursor', 'page', 'pages', 'query', 'results', 'success', 'total'])
  })

  test('a keyset cursor and a bound compose, and the count is still skipped on a cursor page', async () => {
    const cursor = Buffer.from(JSON.stringify({ sort: 'imported_desc', v: { imported_at: '2026-08-28 23:40:00', domain: 'a', email: 'b', url: 'u', password: 'p' } })).toString('base64')
    await getUrl(v1Search, `/api/v1/search/credentials?q=binance.com&imported_after=${encodeURIComponent(AFTER)}&cursor=${encodeURIComponent(cursor)}`)
    expect(calls.some(c => /count\(\) as total/i.test(c.sql))).toBe(false)
    const rows = calls.find(c => /ORDER BY imported_at DESC/.test(c.sql))!
    expect(rows.sql).toContain('imported_at < {c_ia:DateTime}')
    expect(rows.sql).toContain(PLAIN_AFTER)
    expect(rows.sql).not.toContain('OFFSET')
  })
})

describe('GET /api/v1/search/domain — imported_after / imported_before', () => {
  test('an invalid bound is a 400 and no query runs', async () => {
    const res = await getUrl(v1Domain, '/api/v1/search/domain?domain=binance.com&imported_before=2026-13-45')
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('the count and the rows carry the plain bound (the primary key narrows the read), and the response echoes the window', async () => {
    const body = await (await getUrl(v1Domain, `/api/v1/search/domain?domain=binance.com&${WINDOW_PARAMS}`)).json()
    expect(queryCalls()).toHaveLength(2)
    for (const c of queryCalls()) {
      expect(c.sql).toContain(`WHERE domain = {domain:String} AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}`)
      expect(c.sql).not.toContain(IMPORTED_KEY_EXPR)
      expect(c.params).toMatchObject({ domain: 'binance.com', impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
    }
    expect(metaCalls()).toHaveLength(0)
    expect(body).toMatchObject({ imported_after: AFTER, imported_before: BEFORE })
  })

  test('no bound: unchanged SQL and response shape', async () => {
    const body = await (await getUrl(v1Domain, '/api/v1/search/domain?domain=binance.com')).json()
    for (const c of queryCalls()) expect(c.sql).toContain('WHERE domain = {domain:String}\n')
    expect(body).not.toHaveProperty('imported_after')
  })
})

describe('GET /api/v1/lookup — imported_after / imported_before', () => {
  test('an invalid bound is a 400', async () => {
    expect((await getUrl(v1Lookup, '/api/v1/lookup?email=a@b.co&imported_after=bad')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('by email and by domain', async () => {
    const byEmail = await (await getUrl(v1Lookup, `/api/v1/lookup?email=a@b.co&imported_after=${encodeURIComponent(AFTER)}`)).json()
    expect(calls[0].sql).toContain(`WHERE email = {email:String} AND ${PLAIN_AFTER}`)
    expect(calls[0].params).toMatchObject({ email: 'a@b.co', impAfter: AFTER_EPOCH })
    expect(byEmail.imported_after).toBe(AFTER)
    calls.length = 0
    await getUrl(v1Lookup, `/api/v1/lookup?domain=b.co&imported_before=${encodeURIComponent(BEFORE)}`)
    expect(calls[0].sql).toContain(`WHERE domain = {domain:String} AND ${PLAIN_BEFORE}`)
    expect(calls[0].params).toMatchObject({ domain: 'b.co', impBefore: BEFORE_EPOCH })
  })

  test('no bound: unchanged', async () => {
    await getUrl(v1Lookup, '/api/v1/lookup?email=a@b.co')
    expect(calls[0].sql).toContain('WHERE email = {email:String}\n')
    expect(calls[0].sql).not.toContain('impAfter')
  })
})

describe.each([
  ['POST /api/v1/lookup/batch', v1Batch, '/api/v1/lookup/batch'],
  ['POST /api/lookup/batch', uiBatch, '/api/lookup/batch'],
] as const)('%s — imported_after / imported_before', (_name, handler, url) => {
  test('an invalid bound is a 400 and no query runs', async () => {
    const res = await postJson(handler, url, { emails: ['a@b.co'], imported_after: 'whenever' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/^imported_after must be/)
    expect(calls).toHaveLength(0)
  })

  test('both the email lookup and the domain lookup carry the bound beside the key, and the result echoes it', async () => {
    const body = await (await postJson(handler, url, { emails: ['A@b.co'], domains: ['b.co'], imported_after: AFTER, imported_before: BEFORE })).json()
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain(`WHERE email IN ({email0:String}) AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}`)
    expect(calls[1].sql).toContain(`WHERE domain IN ({domain0:String}) AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}`)
    for (const c of calls) expect(c.params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH, cap: 50 })
    expect(calls[0].params).toMatchObject({ email0: 'a@b.co' })
    expect(body).toMatchObject({ imported_after: AFTER, imported_before: BEFORE })
  })

  test('no bound: the SQL and the response shape are what they were', async () => {
    const body = await (await postJson(handler, url, { emails: ['a@b.co'] })).json()
    expect(calls[0].sql).toContain('WHERE email IN ({email0:String})\n')
    expect(calls[0].sql).not.toContain('impAfter')
    expect(body).not.toHaveProperty('imported_after')
  })

  test('the date_from / date_to names are not part of this body (only the two new keys)', async () => {
    await postJson(handler, url, { emails: ['a@b.co'], date_from: '2026-08-28' })
    expect(calls[0].sql).not.toContain('impAfter')
  })
})

describe('GET /api/search (legacy, no UI caller) — imported_after / imported_before', () => {
  test('a bound alone counts as a filter, and carries the plain bound into the count and the rows', async () => {
    const res = await getUrl(legacySearch, `/api/search?${WINDOW_PARAMS}`)
    expect(res.status).toBe(200)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).toContain(PLAIN_BEFORE)
      expect(c.sql).not.toContain(IMPORTED_KEY_EXPR)
    }
    expect(metaCalls()).toHaveLength(0)
  })

  test('the old date_from alone is still a filter', async () => {
    const res = await getUrl(legacySearch, '/api/search?date_from=2026-08-28')
    expect(res.status).toBe(200)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('an invalid bound is a 400', async () => {
    expect((await getUrl(legacySearch, '/api/search?q=x&imported_after=2026-02-30')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('no filter at all is still the empty answer with no query', async () => {
    const body = await (await getUrl(legacySearch, '/api/search')).json()
    expect(body.results).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
