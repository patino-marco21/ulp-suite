import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let hostDomains: string[] = ['ledger.com', 'app.ledger.com']
let emailDomains: string[] = ['ledger.com']
let textHits = 1532
let planDataError: Error | null = null
let planTotalsError: Error | null = null
let plainDataError: Error | null = null
const fresh = (fp = 'fp-1') => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
let dictStatus: Record<string, unknown> = fresh()

// The word plan's branches end `LIMIT {limit:UInt32} SETTINGS optimize_use_projections = 0`; no other rows query of this route has that shape (an address
// search carries the setting in the OUTER settings, the substring plan too).
const isPlanRows = (sql: string) => /LIMIT \{(?:limit|windowLimit):UInt32\} SETTINGS optimize_use_projections = 0/.test(sql)
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/FROM ulp\.search_host_dict/.test(sql)) return hostDomains.map(domain => ({ domain }))
    if (/FROM ulp\.search_emaildomain_dict/.test(sql)) return emailDomains.map(email_domain => ({ email_domain }))
    if (/SELECT count\(\) AS hits FROM/.test(sql)) return [{ hits: String(textHits) }]
    if (/system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }] // Newest-first windows NOT ready
    if (/AS raw_total/.test(sql)) {
      if (planTotalsError && /part_total/.test(sql)) throw planTotalsError
      return [totalsRow]
    }
    if (/\) AS t\s/.test(sql)) {
      if (planDataError && isPlanRows(sql)) throw planDataError
      if (plainDataError && !isPlanRows(sql)) throw plainDataError
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
import { resetSearchPlanGateCache, wordRowsMaxDomains, wordRowsMaxEmailDomains, wordRowsMaxTextHits } from '@/lib/search-plan-gate'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const lookups = () => calls.filter(c => /FROM ulp\.search_(host|emaildomain)_dict/.test(c.sql))
const probes = () => calls.filter(c => /SELECT count\(\) AS hits FROM/.test(c.sql))
const planRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && isPlanRows(c.sql))
const plainRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !isPlanRows(c.sql))
const planTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && /part_total/.test(c.sql))
const plainTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && !/part_total/.test(c.sql))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const names = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example`)
const TIMEOUT = () => new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 4.2 seconds, maximum: 4. (TIMEOUT_EXCEEDED)')

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  totalsRow = { total: '11', raw_total: '12' }
  hostDomains = ['ledger.com', 'app.ledger.com']
  emailDomains = ['ledger.com']
  textHits = 1532
  planDataError = planTotalsError = plainDataError = null
  dictStatus = fresh()
  resetDictionaryPlanCache()
  resetSearchPlanGateCache()
  resetNewestFirstReadyCache()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
// Not restoreAllMocks: it would also strip the implementations of the mocked auth, ClickHouse and dictionary modules.
afterEach(() => { vi.unstubAllEnvs(); warnSpy.mockRestore() })

describe('GET /api/credentials — a single word, answered through the text indexes and the dictionaries', () => {
  test('the page\'s rows request and totals request are both answered by the plan, share ONE set of lookups and ONE probe', async () => {
    const [rowsRes, totalsRes] = await Promise.all([
      get('q=ledger&skip_totals=1&exclude_noise=1&dedupe=1'),
      get('q=ledger&totals_only=1&exclude_noise=1&dedupe=1'),
    ])
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'words' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'words' })
    expect(lookups()).toHaveLength(2) // hosts and e-mail domains, once for both requests
    expect(probes()).toHaveLength(1)
    expect(planRows()).toHaveLength(1)
    expect(planTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('the rows SQL: H and E keep the legacy predicate and exclude the leaves, T has the leaves alone; the budget is 4 s', async () => {
    await get('q=ledger&skip_totals=1&dedupe=1&exclude_noise=1&limit=50')
    const { sql, params } = planRows()[0]
    expect(sql).toContain('url_host LIKE {tlk0:String}') // the legacy predicate is still there (H and E)
    expect(sql).toContain("AND domain IN ['app.ledger.com','ledger.com'] AND NOT (hasToken(url, {tok0:String}) OR hasToken(email, {tok0:String}) OR hasToken(password, {tok0:String}))")
    expect(sql).toContain("AND domain NOT IN ['app.ledger.com','ledger.com'] AND NOT (hasToken(url, {tok0:String})")
    expect(sql).toContain('AND (hasToken(url, {tok0:String}) OR hasToken(email, {tok0:String}) OR hasToken(password, {tok0:String})) AND is_noise = 0')
    expect(sql).toContain('ORDER BY domain ASC')
    expect(sql).toMatch(/\) AS t\s+SETTINGS max_execution_time = 4,/)
    expect(params).toMatchObject({ tok0: 'ledger', tlk0: '%ledger%', limit: 50 })
    expect(params).not.toHaveProperty('windowLimit')
  })

  test('the totals SQL: three aggregates merged as states, a 12 s budget that throws', async () => {
    await get('q=ledger&totals_only=1&exclude_noise=1&dedupe=1')
    const { sql, params } = planTotals()[0]
    expect(sql).toContain('uniqIfMerge(part_total) AS total')
    expect((sql.match(/uniqIfState/g) ?? []).length).toBe(3)
    expect(sql).toMatch(/max_execution_time = 12,\s+timeout_overflow_mode = 'throw'/)
    expect(sql).not.toContain('{c_d')
    expect(params).toMatchObject({ tok0: 'ledger', tlk0: '%ledger%' })
  })

  test('a cursor page puts the keyset clause in all three branches and neither looks up nor probes again', async () => {
    await get('q=ledger&sort=domain_asc&skip_totals=1&limit=2')
    const cursor = encodeCursor('domain_asc', row(2))
    calls.length = 0
    await get(`q=ledger&sort=domain_asc&limit=2&cursor=${encodeURIComponent(cursor)}`)
    const { sql, params } = planRows()[0]
    expect(sql.split('(domain, email, imported_at, url, password) > ({c_d:String}').length - 1).toBe(3)
    expect(params).toMatchObject({ c_d: 's2.example', c_e: 'u2@mail.test' })
    expect(lookups()).toHaveLength(0)
    expect(probes()).toHaveLength(0)
    expect(planTotals()).toHaveLength(0)
  })

  test('Unique with a sort not led by domain binds windowLimit like the plain query', async () => {
    await get('q=ledger&skip_totals=1&dedupe=1&sort=email_asc&limit=50')
    const { sql, params } = planRows()[0]
    expect(sql).toContain('LIMIT {windowLimit:UInt32}')
    expect(params).toMatchObject({ limit: 50, windowLimit: 150 })
  })

  test('no candidate at all: a single branch, the text indexes alone, still through the plan', async () => {
    hostDomains = []
    emailDomains = []
    textHits = 0
    const body = await (await get('q=ledger&skip_totals=1')).json()
    expect(body.plan).toBe('words')
    const { sql } = planRows()[0]
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toContain('url_host LIKE')
    const totals = await (await get('q=ledger&totals_only=1')).json()
    expect(totals.plan).toBe('words')
    expect(planTotals()[0].sql).not.toContain('UNION ALL')
  })

  test('"Newest first" without the projection windows falls to the plan instead of the full scan', async () => {
    const body = await (await get('q=ledger&skip_totals=1&sort=imported_desc&limit=2')).json()
    expect(body.plan).toBe('words')
    expect(plainRows()).toHaveLength(0)
  })
})

describe('GET /api/credentials — the rows gate: totals still use the plan, rows keep today\'s query', () => {
  test.each([
    ['more candidate domains than the gate', () => { hostDomains = names(wordRowsMaxDomains() + 1, 'd') }, 0],
    ['more candidate e-mail domains than the gate', () => { emailDomains = names(wordRowsMaxEmailDomains() + 1, 'e') }, 0],
    ['more text-index hits than the gate', () => { textHits = wordRowsMaxTextHits() + 1 }, 1],
  ])('%s', async (_name, arrange, probed) => {
    arrange()
    const rowsBody = await (await get('q=ledger&skip_totals=1')).json()
    const totalsBody = await (await get('q=ledger&totals_only=1')).json()
    expect(rowsBody.plan).toBe('plain')
    expect(totalsBody).toMatchObject({ plan: 'words', total: 11, raw_total: 12 })
    expect(plainRows()).toHaveLength(1)
    expect(planRows()).toHaveLength(0)
    expect(probes()).toHaveLength(probed) // a word whose candidates already miss the gate costs no probe of the text indexes
  })

  test('exactly at the three limits the rows plan still runs', async () => {
    hostDomains = names(wordRowsMaxDomains(), 'd')
    emailDomains = names(wordRowsMaxEmailDomains(), 'e')
    textHits = wordRowsMaxTextHits()
    expect((await (await get('q=ledger&skip_totals=1')).json()).plan).toBe('words')
  })

  test('a probe that fails closes the rows gate and nothing else', async () => {
    textHits = Number.NaN // the mock answers hits: 'NaN', which the probe rejects as "not a count"
    const rowsBody = await (await get('q=ledger&skip_totals=1')).json()
    expect(rowsBody.plan).toBe('plain')
    expect((await (await get('q=ledger&totals_only=1')).json()).plan).toBe('words')
  })
})

describe('GET /api/credentials — everything else is today\'s query, untouched', () => {
  test('dictionary=0 and token_plans=0 force the plain query; nothing is looked up or probed', async () => {
    for (const off of ['dictionary=0', 'token_plans=0']) {
      calls.length = 0
      resetDictionaryPlanCache()
      const [rowsBody, totalsBody] = await Promise.all([
        get(`q=ledger&skip_totals=1&${off}`).then(r => r.json()),
        get(`q=ledger&totals_only=1&${off}`).then(r => r.json()),
      ])
      expect(rowsBody.plan, off).toBe('plain')
      expect(totalsBody, off).toMatchObject({ total: 11, raw_total: 12, plan: 'plain' })
      expect(lookups(), off).toHaveLength(0)
      expect(probes(), off).toHaveLength(0)
      expect(plainRows(), off).toHaveLength(1)
      expect(plainTotals(), off).toHaveLength(1)
    }
  })

  test('SEARCH_TOKEN_PLANS=off and SEARCH_DICTIONARY=0 in the environment do the same', async () => {
    for (const name of ['SEARCH_TOKEN_PLANS', 'SEARCH_DICTIONARY']) {
      vi.stubEnv(name, name === 'SEARCH_TOKEN_PLANS' ? 'off' : '0')
      calls.length = 0
      resetDictionaryPlanCache()
      expect((await (await get('q=ledger&skip_totals=1')).json()).plan, name).toBe('plain')
      expect(lookups(), name).toHaveLength(0)
      vi.unstubAllEnvs()
    }
  })

  test.each([
    ['regex mode', 'q=ledger&regex=1'],
    ['an address', 'q=john@example.test'],
    ['an @domain', 'q=@example.test'],
    ['two terms', 'q=ledger,trezor'],
    ['a negated term', 'q=-ledger'],
    ['a login: prefix', 'q=login:ledger'],
    ['the Login scope', 'q=ledger&scope=login'],
    ['the Login (contains) scope', 'q=ledger&scope=login_contains'],
    ['a word with a hyphen', 'q=my-ledger'],
    ['no search', 'exclude_noise=1'],
  ])('%s never asks the dictionary for a word', async (_name, qs) => {
    const body = await (await get(`${qs}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(probes()).toHaveLength(0)
    expect(calls.filter(c => /search_host_dict/.test(c.sql) && c.params.like === '%ledger%')).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'])('a dictionary that is %s: the plain query answers and no lookup runs', async state => {
    dictStatus = { ...fresh(), state, fingerprint: null }
    const body = await (await get('q=ledger&skip_totals=1')).json()
    expect(body.plan).toBe('plain')
    expect(lookups()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('candidates over the dictionary caps: today\'s query for rows and totals', async () => {
    hostDomains = names(3001, 'd')
    expect((await (await get('q=ledger&skip_totals=1')).json()).plan).toBe('plain')
    expect((await (await get('q=ledger&totals_only=1')).json()).plan).toBe('plain')
  })

  test('a plan query that fails falls back to today\'s query, rows and totals alike', async () => {
    planDataError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    planTotalsError = new Error('Code: 47. DB::Exception: Not found column _part_offset in block')
    const rowsBody = await (await get('q=ledger&skip_totals=1')).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(rowsBody.results).toHaveLength(2)
    expect(plainRows()).toHaveLength(1)
    const totalsBody = await (await get('q=ledger&totals_only=1')).json()
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('a plan that runs over its budget hands over to today\'s query: no 408, rows and totals alike', async () => {
    planDataError = TIMEOUT()
    planTotalsError = TIMEOUT()
    const rowsRes = await get('q=ledger&skip_totals=1')
    expect(rowsRes.status).toBe(200)
    expect(await rowsRes.json()).toMatchObject({ success: true, plan: 'plain' })
    const totalsRes = await get('q=ledger&totals_only=1')
    expect(totalsRes.status).toBe(200)
    expect(await totalsRes.json()).toMatchObject({ success: true, total: 11, plan: 'plain' })
  })

  test('if today\'s query then also times out, that is the same 408 as without the plan', async () => {
    planDataError = TIMEOUT()
    plainDataError = new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')
    const res = await get('q=ledger&skip_totals=1')
    expect(res.status).toBe(408)
    expect((await res.json()).timed_out).toBe(true)
  })
})
