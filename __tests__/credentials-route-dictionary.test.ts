import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let dictDataError: Error | null = null
let legacyDataError: Error | null = null
let dictTotalsError: Error | null = null
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let hostDomains: string[] = ['ledger.com', 'app.ledger.com']
let emailDomains: string[] = ['ledger.com']
let windowsReadiness: Array<Record<string, unknown>> = [{ defined: 0, parts: 1, with_projection: 0 }] // newest-first windows NOT ready: the plain/dictionary path answers
const fresh = (fp = 'fp-1') => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
let dictStatus: Record<string, unknown> = fresh()

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/FROM ulp\.search_host_dict/.test(sql)) return hostDomains.map(domain => ({ domain }))
    if (/FROM ulp\.search_emaildomain_dict/.test(sql)) return emailDomains.map(email_domain => ({ email_domain }))
    if (/system\.projections/.test(sql)) return windowsReadiness
    if (/AS raw_total/.test(sql)) {
      if (/part_total/.test(sql) && dictTotalsError) throw dictTotalsError
      return [totalsRow]
    }
    if (/\) AS t\s/.test(sql)) {
      const err = /domain IN \[/.test(sql) ? dictDataError : legacyDataError
      if (err) throw err
      return dataRows
    }
    return []
  }),
}))
vi.mock('@/lib/search-dictionary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/search-dictionary')>('@/lib/search-dictionary')
  return { ...actual, getSearchDictionaryStatus: vi.fn(async () => dictStatus) }
})
vi.mock('@/lib/credentials-projections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/credentials-projections')>('@/lib/credentials-projections')
  return { ...actual, isEmailDomainRevProjectionReady: vi.fn(async () => true) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { encodeCursor } from '@/lib/cursor-pagination'
import { resetDictionaryPlanCache } from '@/lib/search-dictionary-plan'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'
import { getSearchDictionaryStatus } from '@/lib/search-dictionary'

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const isLookup = (c: Call) => /FROM ulp\.search_(host|emaildomain)_dict/.test(c.sql)
const dictRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && /domain IN \[/.test(c.sql))
const plainRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !/domain IN \[/.test(c.sql))
const dictTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && /part_total/.test(c.sql))
const plainTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && !/part_total/.test(c.sql))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))

beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  dictDataError = legacyDataError = dictTotalsError = null
  totalsRow = { total: '11', raw_total: '12' }
  hostDomains = ['ledger.com', 'app.ledger.com']
  emailDomains = ['ledger.com']
  windowsReadiness = [{ defined: 0, parts: 1, with_projection: 0 }]
  dictStatus = fresh()
  resetDictionaryPlanCache()
  resetNewestFirstReadyCache()
  vi.mocked(getSearchDictionaryStatus).mockClear()
})

describe('GET /api/credentials — a domain search answered from the dictionary', () => {
  test('the page\'s rows request and totals request are both answered by the plan and share ONE lookup', async () => {
    const [rowsRes, totalsRes] = await Promise.all([
      get('q=ledger.com&skip_totals=1&exclude_noise=1&dedupe=1'),
      get('q=ledger.com&totals_only=1&exclude_noise=1&dedupe=1'),
    ])
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'dictionary' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'dictionary' })
    expect(calls.filter(isLookup)).toHaveLength(4)
    expect(dictRows()).toHaveLength(1)
    expect(dictTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('the rows SQL keeps the legacy predicate, filters and parameters and adds the candidates', async () => {
    await get('q=ledger.com&skip_totals=1&dedupe=1&exclude_noise=1&limit=50')
    const { sql, params } = dictRows()[0]
    expect(sql).toContain('domain = {dom0:String}') // the legacy predicate is still there
    expect(sql).toContain('url_host LIKE {domlk0:String}')
    expect(sql).toContain("AND domain IN ['app.ledger.com','ledger.com']")
    expect(sql).toContain("AND domain NOT IN ['app.ledger.com','ledger.com']")
    expect(sql).toContain('is_noise = 0')
    expect(sql).toContain('ORDER BY domain ASC')
    expect(params).toMatchObject({ dom0: 'ledger.com', limit: 50 })
    expect(params).not.toHaveProperty('windowLimit')
  })

  test('Unique with a sort not led by domain uses the window form and binds windowLimit like the legacy query', async () => {
    await get('q=ledger.com&skip_totals=1&dedupe=1&sort=email_asc&limit=50')
    const { sql, params } = dictRows()[0]
    expect(sql).toContain('LIMIT {windowLimit:UInt32}')
    expect(params).toMatchObject({ limit: 50, windowLimit: 150 })
  })

  test('a cursor page puts the keyset clause in both branches and does not look the term up again', async () => {
    await get('q=ledger.com&sort=domain_asc&skip_totals=1&limit=2')
    const cursor = encodeCursor('domain_asc', row(2))
    calls.length = 0
    await get(`q=ledger.com&sort=domain_asc&limit=2&cursor=${encodeURIComponent(cursor)}`)
    const { sql, params } = dictRows()[0]
    expect(sql.split('(domain, email, imported_at, url, password) > ({c_d:String}').length - 1).toBe(2)
    expect(params).toMatchObject({ c_d: 's2.example', c_e: 'u2@mail.test' })
    expect(calls.filter(isLookup)).toHaveLength(0) // the verdict for this term is remembered
    expect(dictTotals()).toHaveLength(0) // a cursor page has no totals
  })

  test('the totals merge aggregate states for Unique and sum counts otherwise; they ignore the cursor and carry no noise filter in the WHERE', async () => {
    await get('q=ledger.com&totals_only=1&exclude_noise=1&dedupe=1')
    expect(dictTotals()[0].sql).toContain('uniqIfMerge(part_total) AS total')
    calls.length = 0
    await get('q=ledger.com&totals_only=1')
    expect(dictTotals()[0].sql).toContain('sum(part_total) AS total')
    expect(dictTotals()[0].sql).toContain('count() AS part_total')
  })

  test('both lists empty: an empty page and zero totals without touching the table', async () => {
    hostDomains = []
    emailDomains = []
    const rowsBody = await (await get('q=ledger.com&skip_totals=1')).json()
    const totalsBody = await (await get('q=ledger.com&totals_only=1')).json()
    expect(rowsBody).toMatchObject({ success: true, results: [], plan: 'dictionary', next_cursor: null })
    expect(totalsBody).toMatchObject({ success: true, total: 0, raw_total: 0, plan: 'dictionary' })
    expect(dictRows()).toHaveLength(0)
    expect(plainRows()).toHaveLength(0)
    expect(dictTotals()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('"Newest first" without the projection windows falls to the plan instead of the full scan', async () => {
    const body = await (await get('q=ledger.com&skip_totals=1&sort=imported_desc&limit=2')).json()
    expect(body.plan).toBe('dictionary')
    expect(plainRows()).toHaveLength(0)
  })
})

describe('GET /api/credentials — everything else is today\'s query, untouched', () => {
  test('dictionary=0 forces the plain query for one request; the dictionary is not even consulted', async () => {
    const [rowsBody, totalsBody] = await Promise.all([
      get('q=ledger.com&skip_totals=1&dictionary=0').then(r => r.json()),
      get('q=ledger.com&totals_only=1&dictionary=0').then(r => r.json()),
    ])
    expect(rowsBody.plan).toBe('plain')
    expect(totalsBody).toMatchObject({ total: 11, raw_total: 12, plan: 'plain' })
    expect(getSearchDictionaryStatus).not.toHaveBeenCalled()
    expect(calls.filter(isLookup)).toHaveLength(0)
    expect(dictRows()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test.each([
    ['regex mode', 'q=ledger.com&regex=1'],
    ['a single word', 'q=ledger'],
    ['two terms', 'q=ledger.com,trezor.io'],
    ['an @domain', 'q=@ledger.com'],
    ['a negated term', 'q=-ledger.com'],
    ['no search', 'exclude_noise=1'],
  ])('%s never touches the dictionary', async (_name, qs) => {
    await get(`${qs}&skip_totals=1`)
    expect(getSearchDictionaryStatus).not.toHaveBeenCalled()
    expect(calls.filter(isLookup)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'])('a dictionary that is %s: the plain query answers and no lookup runs', async state => {
    dictStatus = { ...fresh(), state, fingerprint: null }
    const body = await (await get('q=ledger.com&skip_totals=1')).json()
    expect(body.plan).toBe('plain')
    expect(calls.filter(isLookup)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('a plan query that fails for any reason but a timeout falls back to the plain query, rows and totals alike', async () => {
    dictDataError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    dictTotalsError = new Error('Code: 47. DB::Exception: Not found column _part_offset in block')
    const rowsBody = await (await get('q=ledger.com&skip_totals=1')).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(rowsBody.results).toHaveLength(2)
    expect(plainRows()).toHaveLength(1)
    const totalsBody = await (await get('q=ledger.com&totals_only=1')).json()
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
  })

  test('a timeout inside the plan is the same 408 the plain query gives, and is not retried as a second full-length query', async () => {
    dictDataError = new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')
    const res = await get('q=ledger.com&skip_totals=1')
    expect(res.status).toBe(408)
    expect((await res.json()).timed_out).toBe(true)
    expect(plainRows()).toHaveLength(0)
  })
})
