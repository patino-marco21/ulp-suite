import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let readiness: Array<Record<string, unknown>> = [{ defined: 1, parts: 1, with_projection: 1 }]
let anchors: Array<Record<string, unknown>> = [{ newest: 1_787_960_054, oldest: 1_782_000_000 }]
let windowAnswers: Array<Array<Record<string, unknown>> | Error> = []
let legacyRows: Array<Record<string, unknown>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    if (/toUnixTimestamp\(max\(imported_at\)\)/.test(sql)) return anchors
    if (/\bAS total\b|count\(\) AS (total|raw_total)/.test(sql)) return [{ total: '9', raw_total: '9' }]
    if (sql.includes('{nfwLimit:UInt32}')) {
      const next = windowAnswers.shift() ?? []
      if (next instanceof Error) throw next
      return next
    }
    return legacyRows
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { decodeCursor, encodeCursor } from '@/lib/cursor-pagination'
import { IMPORTED_KEY_EXPR, resetNewestFirstReadyCache } from '@/lib/newest-first'

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.com`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.com`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4, ...extra,
})

const windowCalls = () => calls.filter(c => c.sql.includes('{nfwLimit:UInt32}'))
const legacyDataCalls = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !c.sql.includes('{nfwLimit:UInt32}'))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))

beforeEach(() => {
  calls.length = 0
  resetNewestFirstReadyCache()
  readiness = [{ defined: 1, parts: 1, with_projection: 1 }]
  anchors = [{ newest: 1_787_960_054, oldest: 1_782_000_000 }]
  windowAnswers = []
  legacyRows = []
})

describe('GET /api/credentials — "Newest first" runs as time windows over proj_imported_desc', () => {
  test('sort=imported_desc with the projection ready: the page comes from windows and the plain query never runs', async () => {
    windowAnswers = [[row(1), row(2)]]
    const body = await (await get('sort=imported_desc&limit=2&skip_totals=1')).json()
    expect(body.success).toBe(true)
    expect(body.results).toHaveLength(2)
    expect(windowCalls()).toHaveLength(1)
    expect(legacyDataCalls()).toHaveLength(0)
  })

  test('each window is the route\'s own query plus a predicate on the projection\'s key expression and a LIMIT parameter', async () => {
    windowAnswers = [[row(1), row(2)]]
    await get('sort=imported_desc&limit=2&exclude_noise=1&skip_totals=1&q=binance.com')
    const { sql, params } = windowCalls()[0]
    // the inner query reads raw columns, filters (search + Declutter) and sorts; NORM_COLS stays on the outer select
    expect(sql).toContain('is_noise = 0')
    expect(sql).toContain('domain = {dom0:String}')
    expect(sql).toContain(`AND ${IMPORTED_KEY_EXPR} < {nfwKeyHi:Int64}`)
    expect(sql).toContain('ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC')
    expect(sql).toContain('LIMIT {nfwLimit:UInt32}')
    expect(sql).toContain('prefer_column_name_to_alias = 1')
    expect(sql).toContain("timeout_overflow_mode = 'throw'")
    expect(sql).toMatch(/max_execution_time = \d+/)
    expect(sql.slice(sql.indexOf('FROM ('))).not.toMatch(/\bAS (url|email|password|domain)\b/i)
    expect(params).toMatchObject({ dom0: 'binance.com', nfwLimit: 2, nfwKeyHi: -(1_787_960_054 - 60) })
  })

  test('the outer select still hands back the stored columns under _c_ aliases, so the cursor is built from stored values', async () => {
    windowAnswers = [[row(1), row(2)]]
    const body = await (await get('sort=imported_desc&limit=2&skip_totals=1')).json()
    const outer = windowCalls()[0].sql.slice(0, windowCalls()[0].sql.indexOf('FROM ('))
    for (const col of ['url', 'email', 'password', 'domain']) expect(outer).toContain(`${col} AS _c_${col}`)
    const cursor = decodeCursor(body.next_cursor)!
    expect(cursor.sort).toBe('imported_desc')
    expect(cursor.v).toMatchObject({ domain: 's2.example', email: 'u2@mail.com' })
    for (const r of body.results) expect(Object.keys(r).filter(k => k.startsWith('_c_'))).toEqual([])
  })

  test('Unique: asks for 3 pages of rows, de-duplicates by content_key_hash in order, and does not leak the helper column', async () => {
    windowAnswers = [[
      row(1, { _c_hash: '10' }), row(2, { _c_hash: '10' }), row(3, { _c_hash: '11' }), row(4, { _c_hash: '12' }), row(5, { _c_hash: '11' }),
    ]]
    const body = await (await get('sort=imported_desc&limit=2&dedupe=1&exclude_noise=1&skip_totals=1')).json()
    const { sql, params } = windowCalls()[0]
    expect(params.nfwLimit).toBe(6)
    expect(sql).toContain('content_key_hash AS _c_hash')
    expect(sql.slice(sql.indexOf('FROM ('))).toContain('content_key_hash')
    expect(sql).not.toContain('LIMIT 1 BY')
    expect(body.results.map((r: { url: string }) => r.url)).toEqual(['https://s1.example/login', 'https://s3.example/login'])
    for (const r of body.results) expect(r).not.toHaveProperty('_c_hash')
    expect(decodeCursor(body.next_cursor)!.v).toMatchObject({ domain: 's3.example' })
  })

  test('without Unique there is no hash column and the page is asked for exactly `limit` rows', async () => {
    windowAnswers = [[row(1)]]
    await get('sort=imported_desc&limit=5&skip_totals=1')
    expect(windowCalls()[0].params.nfwLimit).toBe(5)
    expect(windowCalls()[0].sql).not.toContain('_c_hash')
  })

  test('a short first window moves on to the next one for what is still missing', async () => {
    windowAnswers = [[row(1)], [row(2), row(3)]]
    const body = await (await get('sort=imported_desc&limit=3&skip_totals=1')).json()
    expect(windowCalls().map(c => c.params.nfwLimit)).toEqual([3, 2])
    expect(body.results).toHaveLength(3)
  })

  test('paging: the cursor\'s imported_at anchors the first window and the keyset clause stays in the WHERE', async () => {
    anchors = [{ newest: 1_787_960_054, oldest: 1_782_000_000, cursor_ts: 1_787_000_000 }]
    windowAnswers = [[row(1)]]
    const cursor = encodeCursor('imported_desc', row(9, { imported_at: '2026-08-16 20:40:54' }))
    await get(`sort=imported_desc&limit=2&skip_totals=1&cursor=${encodeURIComponent(cursor)}`)
    const anchorCall = calls.find(c => /toUnixTimestamp\(max\(imported_at\)\)/.test(c.sql))!
    expect(anchorCall.params).toEqual({ nfwCursor: '2026-08-16 20:40:54' })
    const { sql, params } = windowCalls()[0]
    expect(sql).toContain('imported_at < {c_ia:DateTime}')
    expect(sql).toContain(`${IMPORTED_KEY_EXPR} >= {nfwKeyLo:Int64}`)
    expect(params).toMatchObject({ c_ia: '2026-08-16 20:40:54', nfwKeyLo: -1_787_000_000 })
  })

  test('other sorts never touch the machinery: not even the readiness check runs', async () => {
    legacyRows = [row(1)]
    await get('sort=domain_asc&limit=2&skip_totals=1')
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
    expect(windowCalls()).toHaveLength(0)
    expect(legacyDataCalls()).toHaveLength(1)
  })

  test('the projection not rebuilt yet: the plain query answers, exactly as before', async () => {
    readiness = [{ defined: 0, parts: 1, with_projection: 0 }]
    legacyRows = [row(1), row(2)]
    const body = await (await get('sort=imported_desc&limit=2&skip_totals=1')).json()
    expect(windowCalls()).toHaveLength(0)
    expect(legacyDataCalls()).toHaveLength(1)
    expect(body.results).toHaveLength(2)
  })

  test('a window that fails for a reason other than a timeout falls back to the plain query', async () => {
    windowAnswers = [new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')]
    legacyRows = [row(1), row(2)]
    const body = await (await get('sort=imported_desc&limit=2&skip_totals=1')).json()
    expect(body.success).toBe(true)
    expect(legacyDataCalls()).toHaveLength(1)
    expect(body.results).toHaveLength(2)
  })

  test('a timeout in a window is a 408, not a second full-length attempt', async () => {
    windowAnswers = [new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')]
    const res = await get('sort=imported_desc&limit=2&skip_totals=1')
    expect(res.status).toBe(408)
    expect(legacyDataCalls()).toHaveLength(0)
  })

  test('totals_only runs no data query at all, windowed or plain', async () => {
    const body = await (await get('sort=imported_desc&totals_only=1')).json()
    expect(body.total).toBe(9)
    expect(windowCalls()).toHaveLength(0)
    expect(legacyDataCalls()).toHaveLength(0)
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
  })

  test('the totals query is unchanged: whole predicate, no window', async () => {
    windowAnswers = [[row(1)]]
    await get('sort=imported_desc&limit=1&q=binance.com&exclude_noise=1&dedupe=1')
    const totals = calls.find(c => /\bAS total\b/.test(c.sql))!
    expect(totals.sql).not.toContain('nfwKey')
    expect(totals.sql).not.toContain(IMPORTED_KEY_EXPR)
  })
})
