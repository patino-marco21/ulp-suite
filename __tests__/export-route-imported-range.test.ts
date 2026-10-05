import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const streamCalls: Array<{ query: string; query_params: Record<string, unknown> }> = []
const READY = { defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }
let readiness: Array<Record<string, unknown>> = [READY]
let tableRows: Array<Record<string, string>> = []
let streamRows: Array<Record<string, string>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    return tableRows
  }),
  getClient: () => ({
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      streamCalls.push({ query: opts.query, query_params: opts.query_params ?? {} })
      return { stream: () => (async function* () { yield streamRows.map(r => ({ json: () => r })) })() }
    },
  }),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/export/route'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

// 2026-08-28T23:30:00Z .. 2026-08-29T00:30:00Z
const AFTER = '2026-08-28T23:30:00Z'
const BEFORE = '2026-08-29T00:30:00Z'
const AFTER_EPOCH = 1_787_959_800
const BEFORE_EPOCH = AFTER_EPOCH + 3600
const KEY_HI = `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/export', { method: 'POST', body: JSON.stringify(body) }))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/export?${qs}`))
const dataCall = () => calls.find(c => /\) AS t\s/.test(c.sql))
const tableRow = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.com`, password: `pw${n}`, domain: `s${n}.example`,
  source_file: 'f.txt', breach_name: '', country_tier: '', login_type: 'email', password_length: '4', password_mask: 'alphanumeric',
  url_scheme: 'https', is_corporate_email: '0', email_domain: 'mail.com', url_host: `s${n}.example`, password_entropy_band: 'weak',
  imported_at: '2026-08-28 23:40:00',
})

beforeEach(() => {
  calls.length = 0
  streamCalls.length = 0
  readiness = [READY]
  tableRows = [tableRow(1)]
  streamRows = [{ email: 'a@b.co', domain: 'b.co', username: 'a', password: 'pw' }]
  resetNewestFirstReadyCache()
})

describe('POST /api/export — the imported-range bound', () => {
  test('an invalid bound is a 400 that names the parameter, and nothing reaches ClickHouse', async () => {
    const res = await post({ format: 'csv', imported_after: 'yesterday' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/^imported_after must be/)
    expect(calls).toHaveLength(0)
    expect(streamCalls).toHaveLength(0)
  })

  test('the bound is rejected before ANY format runs, spray and wordlist included', async () => {
    for (const format of ['spray', 'wordlist', 'hcmask', 'emails', 'domains', 'json']) {
      expect((await post({ format, imported_before: 'nope' })).status, format).toBe(400)
    }
    expect(calls).toHaveLength(0)
    expect(streamCalls).toHaveLength(0)
  })

  test('csv: the SQL carries both bounds as Int64 parameters', async () => {
    await post({ format: 'csv', imported_after: AFTER, imported_before: BEFORE })
    const { sql, params } = dataCall()!
    expect(sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(sql).toContain('imported_at <= toDateTime({impBefore:Int64})')
    expect(params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
  })

  test('the old date_from / date_to still work and mean whole UTC days', async () => {
    await post({ format: 'csv', date_from: '2026-08-28', date_to: '2026-08-28' })
    const { sql, params } = dataCall()!
    expect(sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(params).toMatchObject({ impAfter: Date.UTC(2026, 7, 28) / 1000 - 1, impBefore: Date.UTC(2026, 7, 28, 23, 59, 59) / 1000 })
    expect(sql).not.toContain('{dateFrom:DateTime}')
  })

  test('no bound at all: no bound SQL, no readiness query, and a plain file name and headers', async () => {
    const res = await post({ format: 'csv', query: 'binance.com' })
    expect(dataCall()!.sql).not.toContain('impAfter')
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export.csv"')
    expect(res.headers.get('X-Export-Imported-After')).toBeNull()
    expect(res.headers.get('X-Export-Imported-Before')).toBeNull()
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('1')
  })

  test('the file name and headers record the window', async () => {
    const res = await post({ format: 'csv', imported_after: AFTER, imported_before: BEFORE })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export_after-20260828T233000Z_before-20260829T003000Z.csv"')
    expect(res.headers.get('X-Export-Imported-After')).toBe(AFTER)
    expect(res.headers.get('X-Export-Imported-Before')).toBe(BEFORE)
  })
})

describe('POST /api/export — which searches get the projection form', () => {
  test('a domain search, newest first, projection ready: plain bound plus the key predicate', async () => {
    await post({ format: 'csv', query: 'binance.com', imported_after: AFTER })
    const { sql, params } = dataCall()!
    expect(sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(sql).toContain(KEY_HI)
    expect(params).toMatchObject({ impKeyHi: -AFTER_EPOCH })
  })

  test('no query at all, newest first: the key predicate too', async () => {
    await post({ format: 'json', imported_after: AFTER })
    expect(dataCall()!.sql).toContain(KEY_HI)
  })

  test('a word search: plain bound only (a projection part has no text index, so hasToken would turn case-sensitive)', async () => {
    await post({ format: 'csv', query: 'ledger', imported_after: AFTER })
    expect(dataCall()!.sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
    expect(dataCall()!.sql).not.toContain('use_skip_indexes')
  })

  test('a regex search: plain bound only', async () => {
    await post({ format: 'csv', query: '^admin@', regex_mode: true, imported_after: AFTER })
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('a sort that is not by time: plain bound only', async () => {
    await post({ format: 'csv', query: 'binance.com', sort: 'domain_asc', imported_after: AFTER })
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
  })

  test('the projection is not ready: plain bound only, never wrong', async () => {
    readiness = [{ defined: 0, parts: 1, with_projection: 0 }]
    await post({ format: 'csv', query: 'binance.com', imported_after: AFTER })
    expect(dataCall()!.sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('only an upper bound: plain', async () => {
    await post({ format: 'csv', query: 'binance.com', imported_before: BEFORE })
    expect(dataCall()!.sql).toContain('imported_at <= toDateTime({impBefore:Int64})')
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('hcmask is an aggregate: it gets the key predicate for a domain search', async () => {
    await post({ format: 'hcmask', query: 'binance.com', imported_after: AFTER })
    const hc = calls.find(c => /GROUP BY password/.test(c.sql))!
    expect(hc.sql).toContain(KEY_HI)
  })
})

describe('POST /api/export — the 10,000-row cap says so', () => {
  test('the main query asks for one row more than the cap', async () => {
    await post({ format: 'csv' })
    expect(dataCall()!.sql).toContain('LIMIT 10001')
  })

  test('fewer rows than the cap: complete', async () => {
    tableRows = Array.from({ length: 3 }, (_, i) => tableRow(i))
    const res = await post({ format: 'ulp' })
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('3')
    expect((await res.text()).split('\n')).toHaveLength(3)
  })

  test('exactly the cap: still complete (the extra row never arrived)', async () => {
    tableRows = Array.from({ length: 10_000 }, (_, i) => tableRow(i))
    const res = await post({ format: 'userpass' })
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('10000')
  })

  test('one row over the cap: trimmed to the cap and flagged', async () => {
    tableRows = Array.from({ length: 10_001 }, (_, i) => tableRow(i))
    const res = await post({ format: 'userpass' })
    expect(res.headers.get('X-Export-Truncated')).toBe('1')
    expect(res.headers.get('X-Export-Rows')).toBe('10000')
    expect((await res.text()).split('\n')).toHaveLength(10_000)
  })

  test('csv: the header line plus the capped rows', async () => {
    tableRows = Array.from({ length: 10_001 }, (_, i) => tableRow(i))
    const text = await (await post({ format: 'csv' })).text()
    expect(text.split('\n')).toHaveLength(10_001) // header + 10,000
  })
})

describe('the streaming formats honor the bound too', () => {
  // The list formats start their query inside the stream (after the planner's await), so read the body before looking at what ran.
  test('emails: the DISTINCT query carries the bound and the window is in the file name and headers', async () => {
    const res = await post({ format: 'emails', query: 'binance.com', imported_after: AFTER, imported_before: BEFORE })
    const body = await res.text()
    const q = streamCalls[0]
    expect(q.query).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(q.query).toContain(KEY_HI) // an aggregate over an index-neutral search
    expect(q.query_params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export-emails_after-20260828T233000Z_before-20260829T003000Z.txt"')
    expect(res.headers.get('X-Export-Imported-After')).toBe(AFTER)
    expect(body).toBe('a@b.co\n')
  })

  test('domains with no bound: untouched file name, no window headers, no readiness query', async () => {
    const res = await post({ format: 'domains', query: 'binance.com' })
    await res.text()
    expect(streamCalls[0].query).not.toContain('impAfter')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export-domains.txt"')
    expect(res.headers.get('X-Export-Imported-After')).toBeNull()
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
  })

  test('spray (it used to ignore every extra filter, this one included) now applies the bound', async () => {
    const res = await post({ format: 'spray', query: 'binance.com', imported_after: AFTER, imported_before: BEFORE })
    const body = await res.text()
    const q = streamCalls[0]
    expect(q.query).toContain('SELECT DISTINCT arrayElement(splitByChar')
    expect(q.query).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(q.query).toContain('imported_at <= toDateTime({impBefore:Int64})')
    expect(q.query_params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="spray-list_after-20260828T233000Z_before-20260829T003000Z.txt"')
    expect(body).toBe('a\n')
  })

  test('spray with a word search keeps the plain bound', async () => {
    await (await post({ format: 'spray', query: 'ledger', imported_after: AFTER })).text()
    expect(streamCalls[0].query).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(streamCalls[0].query).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('wordlist (it ignored the query and every filter) now applies the bound, on GET and on POST', async () => {
    streamRows = [{ password: 'hunter2' }]
    const viaGet = await get(`format=wordlist&imported_after=${encodeURIComponent(AFTER)}`)
    const text = await viaGet.text()
    expect(streamCalls[0].query).toContain('FROM ulp.credentials WHERE 1=1 AND imported_at > toDateTime({impAfter:Int64})')
    expect(streamCalls[0].query_params).toMatchObject({ impAfter: AFTER_EPOCH })
    expect(viaGet.headers.get('Content-Disposition')).toBe('attachment; filename="wordlist_after-20260828T233000Z.txt"')
    expect(text).toBe('hunter2\n')
    await (await post({ format: 'wordlist', imported_before: BEFORE })).text()
    expect(streamCalls[1].query).toContain('imported_at <= toDateTime({impBefore:Int64})')
  })

  test('wordlist with no bound and no filter has no WHERE at all, as before', async () => {
    await (await get('format=wordlist')).text()
    expect(streamCalls[0].query).toMatch(/FROM ulp\.credentials\s+GROUP BY password/)
  })

  test('GET: an invalid bound is a 400 and no query runs', async () => {
    const res = await get('format=spray&imported_after=garbage')
    expect(res.status).toBe(400)
    expect(streamCalls).toHaveLength(0)
  })

  test('GET without a bound: spray and wordlist are unchanged', async () => {
    await (await get('format=spray&domain=binance.com')).text()
    expect(streamCalls[0].query).not.toContain('impAfter')
    expect(streamCalls[0].query_params).toMatchObject({ sprayDomain: 'binance.com' })
  })
})
