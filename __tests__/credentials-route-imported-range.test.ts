import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const READY = { defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }
let readiness: Array<Record<string, unknown>> = [READY]
let windowAnswers: Array<Array<Record<string, unknown>>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    if (/toUnixTimestamp\(max\(imported_at\)\)/.test(sql)) return [{ newest: 1_787_960_054, oldest: 1_782_000_000 }]
    if (/AS raw_total/.test(sql)) return [{ total: '9', raw_total: '9' }]
    if (sql.includes('{nfwLimit:UInt32}')) return windowAnswers.shift() ?? []
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

// The data runs 1_782_000_000 .. 1_787_960_054 (2026-08-28T23:34:14Z); the projection covers it from 1_786_000_000.
const AFTER = '2026-08-28T23:30:00Z'
const AFTER_EPOCH = 1_787_959_800
const BEFORE = '2026-08-28T23:33:00Z'
const BEFORE_EPOCH = 1_787_959_980
const PLAIN_AFTER = 'imported_at > toDateTime({impAfter:Int64})'
const PLAIN_BEFORE = 'imported_at <= toDateTime({impBefore:Int64})'
const KEY_HI = `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.com`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.com`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const windowCalls = () => calls.filter(c => c.sql.includes('{nfwLimit:UInt32}'))
const plainRowCalls = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !c.sql.includes('{nfwLimit:UInt32}'))
const totalsCalls = () => calls.filter(c => /AS raw_total/.test(c.sql))
const metaCalls = () => calls.filter(c => /system\.projections/.test(c.sql))

beforeEach(() => {
  calls.length = 0
  readiness = [READY]
  windowAnswers = []
  resetNewestFirstReadyCache()
})

describe('GET /api/credentials — imported_after / imported_before', () => {
  test('an invalid bound is a 400 that names the parameter, and nothing reaches ClickHouse', async () => {
    for (const qs of ['imported_after=yesterday', 'imported_before=2026-02-30', 'date_from=nope']) {
      const res = await get(qs)
      expect(res.status, qs).toBe(400)
      expect((await res.json()).error).toMatch(/^(imported_after|imported_before|date_from) must be/)
    }
    expect(calls).toHaveLength(0)
  })

  test('Newest first, a domain search, a lower bound: both forms of the bound in every window, and the windows stop at the floor', async () => {
    windowAnswers = [[], [row(1)]]
    const body = await (await get(`sort=imported_desc&limit=1&skip_totals=1&q=binance.com&imported_after=${AFTER}`)).json()
    expect(body.success).toBe(true)
    expect(body.plan).toBe('windows')
    const [first, second] = windowCalls()
    for (const w of [first, second]) {
      expect(w.sql).toContain(PLAIN_AFTER)
      expect(w.sql).toContain(KEY_HI)
      expect(w.params).toMatchObject({ impAfter: AFTER_EPOCH, impKeyHi: -AFTER_EPOCH })
    }
    // the last window closes at the bound (exclusive), so nothing older is ever read
    expect(second.params.nfwKeyHi).toBe(-AFTER_EPOCH)
  })

  test('a closed window: the ceiling is the top of the first window, and the upper bound is in the SQL', async () => {
    windowAnswers = [[row(1)]]
    await get(`sort=imported_desc&limit=1&skip_totals=1&q=binance.com&imported_after=${AFTER}&imported_before=${BEFORE}`)
    const w = windowCalls()[0]
    expect(w.sql).toContain(PLAIN_BEFORE)
    expect(w.sql).toContain(`${IMPORTED_KEY_EXPR} >= {impKeyLo:Int64}`)
    expect(w.params).toMatchObject({ impBefore: BEFORE_EPOCH, impKeyLo: -BEFORE_EPOCH })
    expect(w.params.nfwKeyLo).toBe(-BEFORE_EPOCH)
  })

  test('a word search: the rows keep the plain bound only; the window still reads the projection, with the word tokens over lower(col)', async () => {
    windowAnswers = [[row(1)]]
    await get(`sort=imported_desc&limit=1&skip_totals=1&q=hunter2&imported_after=${AFTER}`)
    const w = windowCalls()[0]
    expect(w.sql).toContain(PLAIN_AFTER)
    expect(w.sql).not.toContain('{impKeyHi:Int64}')
    expect(w.sql).toContain('hasToken(lower(url), {tok0:String})')
    expect(w.sql).toContain('use_skip_indexes = 0')
    expect(w.sql).not.toContain('use_skip_indexes = 0, use_skip_indexes') // set once
  })

  test('a sort that is not by time gets the plain bound, and asks nothing about the projection', async () => {
    await get(`sort=domain_asc&limit=5&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].sql).toContain(PLAIN_AFTER)
    expect(plainRowCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
    expect(metaCalls()).toHaveLength(0)
  })

  test('imported_asc is time-ordered: a domain search gets the projection form on the plain query', async () => {
    await get(`sort=imported_asc&limit=5&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].sql).toContain(KEY_HI)
  })

  test('the projection is not ready: plain bound only, and the plain query answers', async () => {
    readiness = [{ defined: 0, parts: 1, with_projection: 0 }]
    await get(`sort=imported_asc&limit=5&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].sql).toContain(PLAIN_AFTER)
    expect(plainRowCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
  })
})

describe('GET /api/credentials — the totals', () => {
  test('a domain search: the aggregate gets the projection form', async () => {
    await get(`totals_only=1&q=binance.com&imported_after=${AFTER}`)
    const sql = totalsCalls()[0].sql
    expect(sql).toContain(PLAIN_AFTER)
    expect(sql).toContain(KEY_HI)
    // projections stay available to the planner exactly when the bound can prune them
    expect(sql).not.toContain('optimize_use_projections')
  })

  test('a word search or a regex: plain bound only', async () => {
    await get(`totals_only=1&q=hunter2&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).toContain(PLAIN_AFTER)
    expect(totalsCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
    calls.length = 0
    await get(`totals_only=1&q=${encodeURIComponent('^admin@')}&regex=1&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('no query at all: the projection form too', async () => {
    await get(`totals_only=1&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).toContain(KEY_HI)
  })

  test('with no bound the totals are what they were: no bound SQL, projections off, and no readiness query', async () => {
    await get('totals_only=1&q=binance.com')
    expect(totalsCalls()[0].sql).not.toContain('impAfter')
    expect(totalsCalls()[0].sql).toContain('optimize_use_projections = 0')
    expect(metaCalls()).toHaveLength(0)
  })

  test('hasUserFilter: a bound alone counts as a filter (the Unique tally is uniq(), not the unfiltered count())', async () => {
    await get(`totals_only=1&dedupe=1&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).toContain('uniq(content_key_hash)')
  })

  test('only the queries a request runs are planned: skip_totals asks nothing for the totals, totals_only nothing for the rows', async () => {
    await get(`sort=domain_asc&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(metaCalls()).toHaveLength(0)
    calls.length = 0
    await get(`sort=imported_asc&totals_only=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()).toHaveLength(0)
    expect(metaCalls()).toHaveLength(1)
  })
})

describe('GET /api/credentials — the old date_from / date_to', () => {
  test('still work, as whole UTC days, on the rows and on the totals', async () => {
    await get('sort=domain_asc&limit=5&q=binance.com&date_from=2026-08-28&date_to=2026-08-28')
    const dayStart = Date.UTC(2026, 7, 28) / 1000
    for (const c of [plainRowCalls()[0], totalsCalls()[0]]) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).toContain(PLAIN_BEFORE)
      expect(c.params).toMatchObject({ impAfter: dayStart - 1, impBefore: dayStart + 86_399 })
    }
    expect(calls.some(c => c.sql.includes('{dateFrom:DateTime}'))).toBe(false)
  })

  test('with both spellings the stricter bound wins', async () => {
    await get(`sort=domain_asc&limit=5&skip_totals=1&date_from=2026-08-01&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].params.impAfter).toBe(AFTER_EPOCH)
  })

  test('a Newest-first request with date_from still bounds its windows at the day start', async () => {
    // the data's last 4 windows (60 s, 16 min, 4 h, then the rest) reach the day start; the last one closes there
    windowAnswers = [[], [], [], [row(1)]]
    await get('sort=imported_desc&limit=1&skip_totals=1&date_from=2026-08-28')
    const dayStart = Date.UTC(2026, 7, 28) / 1000
    expect(windowCalls()).toHaveLength(4)
    expect(windowCalls().at(-1)!.params.nfwKeyHi).toBe(-(dayStart - 1))
  })
})

describe('GET /api/credentials — no bound is a no-op', () => {
  test('no bound SQL, no bound parameters, and the same windows as before', async () => {
    windowAnswers = [[row(1)]]
    await get('sort=imported_desc&limit=1&skip_totals=1&q=binance.com')
    const sql = windowCalls()[0].sql
    expect(sql).not.toContain('impAfter')
    expect(sql).not.toContain('{impKeyHi:Int64}')
    expect(windowCalls()[0].params).not.toHaveProperty('impAfter')
  })
})
