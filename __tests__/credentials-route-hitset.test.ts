import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

/**
 * GET /api/credentials and the hit-set plan (lib/search-hit-set.ts): a text with a special character that the substring plan cannot help with is scanned ONCE
 * for the positions of its few rows, and every request of that search (the rows, the totals, each chip, each sort) is today's query plus those positions.
 * Also: what a request that the browser has abandoned does. The ClickHouse seam is faked; the SQL is proven on the real server by
 * __tests__/hit-set-parity.live.test.ts and scripts/e2e-hit-set.ts.
 */
type Call = { sql: string; params: Record<string, unknown>; signal?: AbortSignal }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let probeHits: Record<string, number> = {}
let scanRows: Array<Record<string, unknown>> = []
let scanError: Error | null = null
let holdScan = false
let holdPlainRows = false
/** Fingerprints handed out in order; the last one repeats. */
let fingerprints: string[] = ['A']
const abortError = () => Object.assign(new Error('Query aborted by client'), { name: 'AbortError' })

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    calls.push({ sql, params, signal })
    if (signal?.aborted) throw abortError()
    if (/AS fingerprint/.test(sql)) {
      const fp = fingerprints.length > 1 ? (fingerprints.shift() as string) : fingerprints[0]
      return fp === '' ? [] : [{ fingerprint: fp, parts: '15' }]
    }
    if (/_part_offset AS off/.test(sql)) {
      if (holdScan) await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError()), { once: true }))
      if (scanError) throw scanError
      return scanRows
    }
    if (/SELECT count\(\) AS hits FROM/.test(sql)) return [{ hits: String(probeHits[String(params.tok)] ?? 50_001) }]
    if (/system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }] // Newest-first windows NOT ready
    if (/AS raw_total/.test(sql)) return [totalsRow]
    if (/\) AS t\s/.test(sql)) {
      if (holdPlainRows && !sql.includes('_part_offset IN')) await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError()), { once: true }))
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
import { resetSearchHitSetCache } from '@/lib/search-hit-set'

const PART = '202610_1612_2827_27_2426'
const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const isScan = (c: Call) => /_part_offset AS off/.test(c.sql)
const isFingerprint = (c: Call) => /AS fingerprint/.test(c.sql)
const isRows = (c: Call) => /\) AS t\s/.test(c.sql)
const isTotals = (c: Call) => /AS raw_total/.test(c.sql)
const positional = (c: Call) => c.sql.includes('_part_offset IN')
const scans = () => calls.filter(isScan)
const hitRows = () => calls.filter(c => isRows(c) && positional(c))
const hitTotals = () => calls.filter(c => isTotals(c) && positional(c))
const plainRows = () => calls.filter(c => isRows(c) && !positional(c))
const plainTotals = () => calls.filter(c => isTotals(c) && !positional(c))
const get = (qs: string, init?: ConstructorParameters<typeof NextRequest>[1]) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`, init))
// the page's own first-page pair
const pair = (qs: string) => Promise.all([get(`${qs}&skip_totals=1`), get(`${qs}&totals_only=1`)])
const NEEDLE = encodeURIComponent('/ledger/login.php')
const BASE = `q=${NEEDLE}&exclude_noise=1&dedupe=1`
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  totalsRow = { total: '11', raw_total: '12' }
  probeHits = { ledger: 90_000, login: 90_000 } // over the substring plan's gate: no word to prune with
  scanRows = [{ part: PART, off: '7' }, { part: PART, off: '9' }]
  scanError = null
  holdScan = false
  holdPlainRows = false
  fingerprints = ['A']
  resetSearchHitSetCache()
  resetSearchPlanGateCache()
  resetNewestFirstReadyCache()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); warnSpy.mockRestore(); errorSpy.mockRestore(); resetSearchHitSetCache() })

describe('GET /api/credentials — the hit-set plan', () => {
  test('the page\'s rows request and totals request share ONE scan and are both answered through the positions', async () => {
    const [rowsRes, totalsRes] = await pair(BASE)
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'hits' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'hits' })
    expect(scans()).toHaveLength(1)
    expect(scans()[0].params).toMatchObject({ lk0: '%/ledger/login.php%', hsCap: 5_001 })
    expect(hitRows()).toHaveLength(1)
    expect(hitTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
    const conjunct = `AND ((_part = '${PART}' AND _part_offset IN (7,9)))`
    expect(norm(hitRows()[0].sql)).toContain(conjunct)
    expect(norm(hitTotals()[0].sql)).toContain(conjunct)
  })

  test('a click on the e-mail chip is answered from the same set: no second scan, and both the chip and the positions are in the SQL', async () => {
    await pair(BASE)
    expect(scans()).toHaveLength(1)
    calls.length = 0
    const [rowsRes, totalsRes] = await pair(`${BASE}&login_type=email`)
    expect(await rowsRes.json()).toMatchObject({ plan: 'hits' })
    expect(await totalsRes.json()).toMatchObject({ plan: 'hits' })
    expect(scans()).toHaveLength(0)
    expect(hitRows()[0].sql).toContain("login_type IN ('email')")
    expect(hitTotals()[0].sql).toContain("login_type IN ('email')")
    expect(plainRows().length + plainTotals().length).toBe(0)
  })

  test('so is a sort, Unique off and Declutter off', async () => {
    await pair(BASE)
    calls.length = 0
    await get(`q=${NEEDLE}&skip_totals=1&sort=email_asc`)
    await get(`q=${NEEDLE}&skip_totals=1&sort=domain_desc&dedupe=0`)
    expect(scans()).toHaveLength(0)
    expect(hitRows()).toHaveLength(2)
  })

  test('the rows SQL is today\'s rows SQL plus the positions and three settings; nothing else differs', async () => {
    await get(`${BASE}&skip_totals=1&limit=50`)
    const plan = hitRows()[0]
    calls.length = 0
    await get(`${BASE}&skip_totals=1&limit=50&hit_set=0`)
    const plain = plainRows()[0]
    const undone = norm(plan.sql)
      .replace(/ AND \(\(_part = '[^']*' AND _part_offset IN \([0-9,]*\)\)( OR \(_part = '[^']*' AND _part_offset IN \([0-9,]*\)\))*\)/, '')
      .replace('max_execution_time = 20,', 'max_execution_time = 300,')
      .replace('optimize_use_projections = 0, optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0, ', '')
    expect(undone).toBe(norm(plain.sql))
    expect(plan.sql).toContain('url LIKE {lk0:String}') // the legacy predicate is still there
    expect(plan.sql).toContain("timeout_overflow_mode = 'throw'")
    expect(plan.sql).toContain('http_wait_end_of_query = 1')
    expect(plan.params).toMatchObject({ lk0: '%/ledger/login.php%', limit: 50 })
  })

  test('the totals SQL is today\'s totals SQL plus the positions, a 20 s limit that THROWS, and the position settings', async () => {
    await get(`${BASE}&totals_only=1`)
    const plan = hitTotals()[0]
    calls.length = 0
    await get(`${BASE}&totals_only=1&hit_set=0`)
    const plain = plainTotals()[0]
    expect(plain.sql).toContain("timeout_overflow_mode = 'break'")
    expect(plan.sql).toContain("timeout_overflow_mode = 'throw'")
    expect(plan.sql).toContain('max_execution_time = 20')
    expect(plan.sql).toContain('optimize_use_projections = 0')
    expect(plan.sql).toContain('optimize_move_to_prewhere = 0')
    const undone = norm(plan.sql)
      .replace(/ AND \(\(_part = '[^']*' AND _part_offset IN \([0-9,]*\)\)( OR \(_part = '[^']*' AND _part_offset IN \([0-9,]*\)\))*\)/, '')
      .replace('max_execution_time = 20,', 'max_execution_time = 300,')
      .replace("timeout_overflow_mode = 'throw'", "timeout_overflow_mode = 'break'")
      .replace(/, optimize_use_projections = 0, optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0$/, ', optimize_use_projections = 0')
    expect(norm(plain.sql).replace(/, optimize_use_projections = 0$/, ', optimize_use_projections = 0')).toBe(undone)
  })

  test('new parts in the table (an import landed) mean a new scan: the old positions would miss the new rows', async () => {
    fingerprints = ['A', 'A', 'A', 'B', 'B', 'B']
    await get(`${BASE}&skip_totals=1`)
    await get(`${BASE}&skip_totals=1&login_type=email`)
    expect(scans()).toHaveLength(2)
  })

  test('if the parts change while the answering query runs, its answer is not trusted: today\'s query answers', async () => {
    fingerprints = ['A', 'A', 'B'] // read before the set is used, at the end of the scan, then after the answering query
    const res = await get(`${BASE}&skip_totals=1`)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, plan: 'plain' })
    expect(hitRows()).toHaveLength(1)
    expect(plainRows()).toHaveLength(1)
  })

  test('the same for the totals: parts that change while the count runs make today\'s count answer', async () => {
    fingerprints = ['A', 'A', 'B']
    const body = await (await get(`${BASE}&totals_only=1`)).json()
    expect(body).toMatchObject({ success: true, plan: 'plain', total: 11, raw_total: 12 })
    expect(hitTotals()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test('a search with no hits is answered empty, with zero totals, and the answering queries are not even run', async () => {
    scanRows = []
    const [rowsRes, totalsRes] = await pair(BASE)
    expect(await rowsRes.json()).toMatchObject({ success: true, results: [], next_cursor: null, plan: 'hits' })
    expect(await totalsRes.json()).toMatchObject({ success: true, total: 0, raw_total: 0, plan: 'hits' })
    expect(scans()).toHaveLength(1)
    expect(calls.filter(c => isRows(c) || isTotals(c))).toHaveLength(0)
  })

  test('more hits than the cap: today\'s query answers, and the verdict is remembered (no second scan for the next click)', async () => {
    vi.stubEnv('SEARCH_HIT_SET_MAX_HITS', '1')
    const first = await (await get(`${BASE}&skip_totals=1`)).json()
    expect(first).toMatchObject({ success: true, plan: 'plain' })
    expect(plainRows()).toHaveLength(1)
    await get(`${BASE}&skip_totals=1&login_type=email`)
    expect(scans()).toHaveLength(1)
  })

  test('a scan that fails: today\'s query answers, and the failure is not retried at once', async () => {
    scanError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    const body = await (await get(`${BASE}&skip_totals=1`)).json()
    expect(body).toMatchObject({ success: true, plan: 'plain' })
    await get(`${BASE}&skip_totals=1&login_type=email`)
    expect(scans()).toHaveLength(1)
    expect(plainRows()).toHaveLength(2)
  })

  test('the parts cannot be read: no plan, today\'s query', async () => {
    fingerprints = ['']
    const body = await (await get(`${BASE}&skip_totals=1`)).json()
    expect(body).toMatchObject({ success: true, plan: 'plain' })
    expect(scans()).toHaveLength(0)
  })

  test.each([
    ['a domain', 'domain=ledger.com'],
    ['a breach', 'breach=Some%20Breach'],
    ['a source file', 'source_file=a.txt'],
    ['a URL host', 'url_host=ledger.com'],
    ['an e-mail domain', 'email_domain=gmail.com'],
    ['an imported range', 'imported_after=2026-10-01'],
  ])('%s narrows the search by itself: no scan is started, today\'s query is cheap and answers', async (_label, extra) => {
    const body = await (await get(`${BASE}&skip_totals=1&${extra}`)).json()
    expect(body).toMatchObject({ success: true, plan: 'plain' })
    expect(scans()).toHaveLength(0)
  })

  test.each([
    ['hit_set=0', 'hit_set=0'],
    ['token_plans=0', 'token_plans=0'],
  ])('%s forces today\'s query for that one request', async (_label, extra) => {
    const body = await (await get(`${BASE}&skip_totals=1&${extra}`)).json()
    expect(body).toMatchObject({ success: true, plan: 'plain' })
    expect(calls.filter(c => isScan(c) || isFingerprint(c))).toHaveLength(0)
  })

  test('SEARCH_HIT_SET=0 switches the plan off for every request', async () => {
    vi.stubEnv('SEARCH_HIT_SET', '0')
    const body = await (await get(`${BASE}&skip_totals=1`)).json()
    expect(body).toMatchObject({ success: true, plan: 'plain' })
    expect(calls.filter(c => isScan(c) || isFingerprint(c))).toHaveLength(0)
  })

  test('a request for a later page uses the set that is there but never starts a scan', async () => {
    const cursor = encodeURIComponent(encodeCursor('domain_asc', { domain: 's1.example', email: 'u1@mail.test', imported_at: '2026-08-28 23:34:14', url: 'u', password: 'p' }))
    const alone = await (await get(`${BASE}&sort=domain_asc&cursor=${cursor}`)).json()
    expect(alone).toMatchObject({ success: true, plan: 'plain' })
    expect(scans()).toHaveLength(0)
    await get(`${BASE}&skip_totals=1&sort=domain_asc`) // the first page makes the set
    calls.length = 0
    const next = await (await get(`${BASE}&sort=domain_asc&cursor=${cursor}`)).json()
    expect(next).toMatchObject({ success: true, plan: 'hits' })
    expect(scans()).toHaveLength(0)
    expect(hitRows()[0].sql).toContain('domain')
  })

  test('the substring plan still goes first: a text with a rare whole word is answered by it and no scan starts', async () => {
    probeHits = { ledger: 120, login: 90_000 }
    const body = await (await get(`${BASE}&skip_totals=1`)).json()
    expect(body).toMatchObject({ success: true, plan: 'substring' })
    expect(scans()).toHaveLength(0)
  })

  test.each([
    ['a domain', 'ledger.com'],
    ['a single word', 'ledger'],
    ['an address', 'a%40b.com'],
    ['two terms', 'a%2Fb%2C%20c%2Fd'],
  ])('%s is not a text with a special character: not eligible', async (_label, q) => {
    await get(`q=${q}&skip_totals=1`)
    expect(scans()).toHaveLength(0)
  })

  test('a regular expression is not eligible', async () => {
    await get(`q=${NEEDLE}&regex=1&skip_totals=1`)
    expect(scans()).toHaveLength(0)
  })
})

describe('GET /api/credentials — a request the browser has abandoned', () => {
  test('hands its signal to the long queries: the plain rows and totals', async () => {
    const controller = new AbortController()
    await get(`${BASE}&hit_set=0`, { signal: controller.signal })
    await get(`${BASE}&hit_set=0&totals_only=1`, { signal: controller.signal })
    const long = calls.filter(c => isRows(c) || isTotals(c))
    expect(long.length).toBeGreaterThanOrEqual(2)
    for (const c of long) expect(c.signal).toBeInstanceOf(AbortSignal)
    expect(controller.signal.aborted).toBe(false)
    controller.abort()
    for (const c of long) expect(c.signal?.aborted).toBe(true) // the same request signal, following the browser's
  })

  test('an abort while today\'s query runs ends the request with 499, quietly, with nothing on the error log', async () => {
    holdPlainRows = true
    const controller = new AbortController()
    const response = get(`${BASE}&skip_totals=1&hit_set=0`, { signal: controller.signal })
    await vi.waitFor(() => expect(plainRows()).toHaveLength(1))
    controller.abort()
    const res = await response
    expect(res.status).toBe(499)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('an abort while the position scan runs ends the request with 499 and does not fall back to today\'s query', async () => {
    holdScan = true
    const controller = new AbortController()
    const response = get(`${BASE}&skip_totals=1`, { signal: controller.signal })
    await vi.waitFor(() => expect(scans()).toHaveLength(1))
    controller.abort()
    const res = await response
    expect(res.status).toBe(499)
    expect(plainRows()).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('the shared scan is killed once the last request waiting for it has gone (after a short grace)', async () => {
    vi.useFakeTimers()
    holdScan = true
    const controller = new AbortController()
    const response = get(`${BASE}`, { signal: controller.signal })
    await vi.waitFor(() => expect(scans()).toHaveLength(1))
    const scanSignal = scans()[0].signal as AbortSignal
    controller.abort()
    expect((await response).status).toBe(499)
    expect(scanSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(scanSignal.aborted).toBe(true)
  })

  test('a failure that is not an abort is still a 500 and is still logged', async () => {
    const boom = new Error('Code: 62. DB::Exception: Syntax error')
    const { executeQuery } = await import('@/lib/clickhouse')
    vi.mocked(executeQuery).mockImplementationOnce(async () => { throw boom })
    const res = await get('q=hello&skip_totals=1&hit_set=0')
    expect(res.status).toBe(500)
    expect(errorSpy).toHaveBeenCalledWith('Credentials browse error:', boom.message)
  })
})
