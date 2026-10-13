import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let probeHits: Record<string, number | Error> = {}
let planDataError: Error | null = null
let planTotalsError: Error | null = null
let plainDataError: Error | null = null

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/SELECT count\(\) AS hits FROM/.test(sql)) {
      const v = probeHits[String(params.tok)]
      if (v instanceof Error) throw v
      return [{ hits: String(v ?? 50_001) }]
    }
    if (/system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }] // Newest-first windows NOT ready
    if (/AS raw_total/.test(sql)) {
      if (planTotalsError && sql.includes('{sbt:String}')) throw planTotalsError
      return [totalsRow]
    }
    if (/\) AS t\s/.test(sql)) {
      if (planDataError && sql.includes('{sbt:String}')) throw planDataError
      if (plainDataError && !sql.includes('{sbt:String}')) throw plainDataError
      return dataRows
    }
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { encodeCursor } from '@/lib/cursor-pagination'
import { resetSearchPlanGateCache } from '@/lib/search-plan-gate'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const isProbe = (c: Call) => /SELECT count\(\) AS hits FROM/.test(c.sql)
const planRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && c.sql.includes('{sbt:String}'))
const plainRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !c.sql.includes('{sbt:String}'))
const planTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && c.sql.includes('{sbt:String}'))
const plainTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && !c.sql.includes('{sbt:String}'))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const NEEDLE = encodeURIComponent('/ledger/login.php')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const TIMEOUT = () => new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 15.2 seconds, maximum: 15. (TIMEOUT_EXCEEDED)')

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  totalsRow = { total: '11', raw_total: '12' }
  probeHits = { ledger: 120, login: 40_000 }
  planDataError = planTotalsError = plainDataError = null
  resetSearchPlanGateCache()
  resetNewestFirstReadyCache()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
// Not restoreAllMocks: it would also strip the implementations of the mocked auth and ClickHouse modules.
afterEach(() => { vi.unstubAllEnvs(); warnSpy.mockRestore() })

describe('GET /api/credentials — a text with a special character, answered through its rarest whole word', () => {
  test('the page\'s rows request and totals request are both answered by the plan and share ONE set of probes', async () => {
    const [rowsRes, totalsRes] = await Promise.all([
      get(`q=${NEEDLE}&skip_totals=1&exclude_noise=1&dedupe=1`),
      get(`q=${NEEDLE}&totals_only=1&exclude_noise=1&dedupe=1`),
    ])
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'substring' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'substring' })
    expect(calls.filter(isProbe)).toHaveLength(2) // ledger and login, once each, although two requests asked
    expect(planRows()).toHaveLength(1)
    expect(planTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('the rows SQL is today\'s rows SQL plus the conjunct, a 15 s limit and the projection setting; nothing else differs', async () => {
    await get(`q=${NEEDLE}&skip_totals=1&exclude_noise=1&dedupe=1&limit=50`)
    const plan = planRows()[0]
    calls.length = 0
    await get(`q=${NEEDLE}&skip_totals=1&exclude_noise=1&dedupe=1&limit=50&token_plans=0`)
    const plain = plainRows()[0]
    const undone = norm(plan.sql)
      .replace(' AND (hasToken(url, {sbt:String}) OR hasToken(email, {sbt:String}) OR hasToken(password, {sbt:String}))', '')
      .replace('max_execution_time = 15,', 'max_execution_time = 300,')
      .replace('optimize_use_projections = 0, ', '')
    expect(undone).toBe(norm(plain.sql))
    expect(plan.sql).toContain('url LIKE {lk0:String}') // the legacy predicate is still there
    expect(plan.params).toMatchObject({ lk0: '%/ledger/login.php%', sbt: 'ledger', limit: 50 })
    expect(plan.sql).toContain("timeout_overflow_mode = 'throw'")
    expect(plan.sql).toContain('http_wait_end_of_query = 1')
  })

  test('the totals SQL is today\'s totals SQL plus the conjunct, a 15 s limit that THROWS, and the projection setting', async () => {
    await get(`q=${NEEDLE}&totals_only=1&exclude_noise=1&dedupe=1`)
    const plan = planTotals()[0]
    calls.length = 0
    await get(`q=${NEEDLE}&totals_only=1&exclude_noise=1&dedupe=1&token_plans=0`)
    const plain = plainTotals()[0]
    expect(plain.sql).toContain("timeout_overflow_mode = 'break'")
    expect(plain.sql).toContain('max_execution_time = 300')
    expect(plan.sql).toContain("timeout_overflow_mode = 'throw'")
    expect(plan.sql).toContain('max_execution_time = 15')
    expect(plan.sql).toContain('optimize_use_projections = 0')
    const undone = norm(plan.sql)
      .replace(' AND (hasToken(url, {sbt:String}) OR hasToken(email, {sbt:String}) OR hasToken(password, {sbt:String}))', '')
      .replace('max_execution_time = 15,', 'max_execution_time = 300,')
      .replace("timeout_overflow_mode = 'throw'", "timeout_overflow_mode = 'break'")
      .replace(/, optimize_use_projections = 0$/, '')
    expect(undone).toBe(norm(plain.sql).replace(/, optimize_use_projections = 0$/, ''))
  })

  test('the plan\'s query parameters reach the totals too', async () => {
    await get(`q=${NEEDLE}&totals_only=1`)
    expect(planTotals()[0].params).toMatchObject({ lk0: '%/ledger/login.php%', sbt: 'ledger' })
  })

  test('a cursor page puts the keyset clause next to the conjunct and does not probe again', async () => {
    await get(`q=${NEEDLE}&sort=domain_asc&skip_totals=1&limit=2`)
    const cursor = encodeCursor('domain_asc', row(2))
    calls.length = 0
    await get(`q=${NEEDLE}&sort=domain_asc&limit=2&cursor=${encodeURIComponent(cursor)}`)
    const { sql, params } = planRows()[0]
    expect(sql).toContain('(domain, email, imported_at, url, password) > ({c_d:String}')
    expect(sql).toContain('hasToken(url, {sbt:String})')
    expect(params).toMatchObject({ c_d: 's2.example', c_e: 'u2@mail.test', sbt: 'ledger' })
    expect(calls.filter(isProbe)).toHaveLength(0) // the verdict for these words is remembered
    expect(planTotals()).toHaveLength(0) // a cursor page has no totals
  })

  test('Unique with a sort not led by domain keeps the bounded window and binds windowLimit like the plain query', async () => {
    await get(`q=${NEEDLE}&skip_totals=1&dedupe=1&sort=email_asc&limit=50`)
    const { sql, params } = planRows()[0]
    expect(sql).toContain('LIMIT {windowLimit:UInt32}')
    expect(sql).toContain('hasToken(url, {sbt:String})')
    expect(params).toMatchObject({ limit: 50, windowLimit: 150, sbt: 'ledger' })
  })

  test('"Newest first" without the projection windows falls to the plan instead of the full scan', async () => {
    const body = await (await get(`q=${NEEDLE}&skip_totals=1&sort=imported_desc&limit=2`)).json()
    expect(body.plan).toBe('substring')
    expect(plainRows()).toHaveLength(0)
  })
})

describe('GET /api/credentials — everything else is today\'s query, untouched', () => {
  test('every whole word over the gate: today\'s query, rows and totals, and the response says plain', async () => {
    probeHits = { ledger: 50_001, login: 90_000_000 }
    const rowsBody = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    const totalsBody = await (await get(`q=${NEEDLE}&totals_only=1`)).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(totalsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(planRows()).toHaveLength(0)
    expect(planTotals()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test('a text with no whole word (a space-separated pair) is not even probed', async () => {
    await get('q=a%20b&skip_totals=1')
    expect(calls.filter(isProbe)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('token_plans=0 forces the plain query for one request; nothing is probed', async () => {
    const [rowsBody, totalsBody] = await Promise.all([
      get(`q=${NEEDLE}&skip_totals=1&token_plans=0`).then(r => r.json()),
      get(`q=${NEEDLE}&totals_only=1&token_plans=0`).then(r => r.json()),
    ])
    expect(rowsBody.plan).toBe('plain')
    expect(totalsBody).toMatchObject({ total: 11, raw_total: 12, plan: 'plain' })
    expect(calls.filter(isProbe)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test('SEARCH_TOKEN_PLANS=off in the environment does the same', async () => {
    vi.stubEnv('SEARCH_TOKEN_PLANS', 'off')
    const body = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(calls.filter(isProbe)).toHaveLength(0)
  })

  test.each([
    ['regex mode', `q=${NEEDLE}&regex=1`],
    ['a single word', 'q=ledger'],
    ['a domain', 'q=ledger.com'],
    ['an address', 'q=john@example.test'],
    ['two terms', `q=${NEEDLE},${encodeURIComponent('/other/path.php')}`],
    ['a negated term', `q=-${NEEDLE}`],
    ['a login: prefix', `q=login:${NEEDLE}`],
    ['the Login scope', `q=${NEEDLE}&scope=login`],
    ['the Login (contains) scope', `q=${NEEDLE}&scope=login_contains`],
    ['no search', 'exclude_noise=1'],
  ])('%s never probes and never uses the plan', async (_name, qs) => {
    const body = await (await get(`${qs}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(calls.filter(isProbe)).toHaveLength(0)
    expect(planRows()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('a probe that fails: today\'s query', async () => {
    probeHits = { ledger: new Error('boom'), login: new Error('boom') }
    const body = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(plainRows()).toHaveLength(1)
  })

  test('a plan query that fails falls back to today\'s query, rows and totals alike', async () => {
    planDataError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    planTotalsError = new Error('Code: 47. DB::Exception: Not found column')
    const rowsBody = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(rowsBody.results).toHaveLength(2)
    expect(plainRows()).toHaveLength(1)
    const totalsBody = await (await get(`q=${NEEDLE}&totals_only=1`)).json()
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('a plan that runs over its budget hands over to today\'s query: no 408, rows and totals alike', async () => {
    planDataError = TIMEOUT()
    planTotalsError = TIMEOUT()
    const rowsRes = await get(`q=${NEEDLE}&skip_totals=1`)
    expect(rowsRes.status).toBe(200)
    expect(await rowsRes.json()).toMatchObject({ success: true, plan: 'plain' })
    expect(plainRows()).toHaveLength(1)
    const totalsRes = await get(`q=${NEEDLE}&totals_only=1`)
    expect(totalsRes.status).toBe(200)
    expect(await totalsRes.json()).toMatchObject({ success: true, total: 11, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
  })

  test('a plan that ran over its budget is not tried again for ten minutes: the next requests go straight to today\'s query', async () => {
    planDataError = TIMEOUT()
    planTotalsError = TIMEOUT()
    await get(`q=${NEEDLE}&skip_totals=1`)
    await get(`q=${NEEDLE}&totals_only=1`)
    expect(planRows()).toHaveLength(1)
    expect(planTotals()).toHaveLength(1)
    calls.length = 0
    expect((await (await get(`q=${NEEDLE}&skip_totals=1`)).json()).plan).toBe('plain')
    expect((await (await get(`q=${NEEDLE}&totals_only=1`)).json()).plan).toBe('plain')
    expect(planRows()).toHaveLength(0)
    expect(planTotals()).toHaveLength(0)
  })

  test('if today\'s query then also times out, that is the same 408 as without the plan', async () => {
    planDataError = TIMEOUT()
    plainDataError = new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')
    const res = await get(`q=${NEEDLE}&skip_totals=1`)
    expect(res.status).toBe(408)
    expect((await res.json()).timed_out).toBe(true)
  })
})
