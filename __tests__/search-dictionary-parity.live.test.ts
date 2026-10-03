import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the domain search dictionary (lib/search-dictionary-plan.ts): the route's answer from the dictionary must be IDENTICAL to
 * today's plain query, page after page, for rows and for totals. Skipped unless SDP_PARITY=1; it talks to the real ClickHouse (the running
 * ulpsuite_clickhouse container) and prints timings. READ-ONLY. It drives the real GET /api/credentials handler; the plain query is forced with
 * `dictionary=0`, so the legacy SQL it compares against cannot drift from the route's. It also prints the timings the design promised (first page,
 * later pages, totals), which is why there is no separate benchmark script.
 *
 *   SDP_PARITY=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts
 *   SDP_PARITY=1 SDP_TERMS=ledger.com,kraken.com SDP_SORTS=domain_asc,email_asc SDP_PAGES=2 SDP_DEDUPES=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts
 *
 *   SDP_TERMS         comma list of domain-shaped terms (default: three public brands and one that matches nothing). Real search terms belong in YOUR
 *                     environment, never in this file: the repository is public.
 *   SDP_SORTS         default domain_asc,email_asc,imported_desc      SDP_DEDUPES  default 1,0 (Unique on, off)      SDP_PAGES  default 2
 *   SDP_LEGACY_TERMS  terms expected to exceed a cap (e.g. google.com): they must answer from the plain query
 *   SDP_TIMING_ONLY=1 first page and totals through the dictionary only, no legacy comparison (the plain query takes 8-60 s per call)
 *
 * The user profile has the query cache on and ClickHouse keeps a per-granule condition cache, so both are dropped before EVERY call (a repeat of
 * the same WHERE looks about 10x faster otherwise), and the planner's lookup cache is reset before the first page of each scenario. Re-run it after
 * anything that rebuilds the table or the dictionary (a content-dedup swap, a ClickHouse upgrade); it is also the tripwire for the two ClickHouse 26.3
 * quirks the plan works around.
 */
const LIVE = process.env.SDP_PARITY === '1'
const TIMING_ONLY = process.env.SDP_TIMING_ONLY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const TERMS = list(process.env.SDP_TERMS, 'ledger.com,trezor.io,kraken.com,zzqxnonexistent.example')
const SORTS = list(process.env.SDP_SORTS, 'domain_asc,email_asc,imported_desc')
const DEDUPES = list(process.env.SDP_DEDUPES, '1,0')
const PAGES = Number(process.env.SDP_PAGES ?? 2)
const LEGACY_TERMS = new Set(list(process.env.SDP_LEGACY_TERMS, ''))

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

// "Newest first" is answered by the time windows (lib/newest-first.ts) when they can, and by the plan only after they hand off, so for that sort either may answer.
const expectedPlans = (term: string, sort: string): string[] =>
  LEGACY_TERMS.has(term) ? ['plain'] : sort === 'imported_desc' ? ['dictionary', 'windows'] : ['dictionary']

type Timing = { scenario: string; page: string; legacyMs: number; planMs: number; plan: string; rows: number }
const timings: Timing[] = []
const matrix = TERMS.flatMap(term => SORTS.flatMap(sort => DEDUPES.map(dedupe => ({ term, sort, dedupe }))))

describe.skipIf(!LIVE)('search dictionary parity on the live table', () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | dictionary ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.legacyMs} | ${t.planMs} (${t.plan}) | ${t.rows}`)
  })

  test('the dictionary is fresh, so the comparison below measures the plan and not its fallback', async () => {
    const { getSearchDictionaryStatus, resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    resetSearchDictionaryCache()
    const status = await getSearchDictionaryStatus()
    console.log(`dictionary: ${status.state}, ${status.pairRows} host pairs, ${status.emailRows} email domains, ${status.bytes} bytes, built ${status.builtAt}`)
    expect(status.state, 'run scripts/build-search-dictionary.ts first').toBe('fresh')
  })

  test.each(matrix)('$term | $sort | Unique=$dedupe', async ({ term, sort, dedupe }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { resetDictionaryPlanCache } = await import('@/lib/search-dictionary-plan')
    const { resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const call = async (qs: string, cold: boolean) => {
      if (cold) { resetDictionaryPlanCache(); resetSearchDictionaryCache() }
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }
    const base = `q=${encodeURIComponent(term)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}`
    const scenario = `${term} ${sort} U${dedupe}`

    if (TIMING_ONLY) {
      const planned = await call(`${base}&skip_totals=1`, true)
      expect(planned.body.success).toBe(true)
      expect(expectedPlans(term, sort)).toContain(planned.body.plan)
      const totals = await call(`${base}&totals_only=1`, true)
      timings.push({ scenario, page: '1', legacyMs: 0, planMs: planned.ms, plan: planned.body.plan, rows: planned.body.results.length })
      timings.push({ scenario, page: 'totals', legacyMs: 0, planMs: totals.ms, plan: totals.body.plan, rows: Number(totals.body.total) })
      return
    }

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const legacy = await call(`${base}&skip_totals=1&dictionary=0${extra}`, true)
      const planned = await call(`${base}&skip_totals=1${extra}`, page === 1)
      expect(legacy.body.success, `page ${page} (plain): ${JSON.stringify(legacy.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.success, `page ${page}: ${JSON.stringify(planned.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.results).toEqual(legacy.body.results)
      expect(planned.body.next_cursor).toEqual(legacy.body.next_cursor)
      expect(expectedPlans(term, sort), `which plan answered: ${scenario} page ${page}`).toContain(planned.body.plan)
      timings.push({ scenario, page: String(page), legacyMs: legacy.ms, planMs: planned.ms, plan: planned.body.plan, rows: legacy.body.results.length })
      if (!legacy.body.next_cursor) break
      cursor = legacy.body.next_cursor
    }

    const legacyTotals = await call(`${base}&totals_only=1&dictionary=0`, true)
    const plannedTotals = await call(`${base}&totals_only=1`, true)
    expect(plannedTotals.body.success).toBe(true)
    expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
      .toEqual({ total: legacyTotals.body.total, raw_total: legacyTotals.body.raw_total })
    timings.push({ scenario, page: 'totals', legacyMs: legacyTotals.ms, planMs: plannedTotals.ms, plan: plannedTotals.body.plan, rows: Number(plannedTotals.body.total) })
  }, 60 * 60_000)
})

describe.skipIf(!LIVE)('candidate lists written as literals reach the live ClickHouse byte for byte', () => {
  test('25 awkward strings come back identical (quotes, backslashes, an injection attempt, NUL, RTL override, a 4,000-character value)', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { chStringArrayLiteral } = await import('@/lib/clickhouse-literals')
    const nasty = [
      'plain.com', "a'b.com", 'a\\b.com', "a\\'b.com", "'; DROP TABLE ulp.credentials; --", '\\\\\'', "x'] ) OR 1=1 --",
      'line\nbreak.com', 'tab\tchar.com', 'nul\u0000byte.com', 'bell\u0007.com', 'del\u007f.com', 'emoji-😀.com', 'rtl-‮evil.com',
      'percent%_underscore_.com', '', ' ', 'a'.repeat(4000), 'ünïcödé.例え.jp', 'back`tick"dq.com', '--comment', '/* c */', '\\x41', '\\0', '\\n',
    ]
    const rows = await executeQuery(`SELECT ${chStringArrayLiteral(nasty)} AS a`, {})
    expect(rows[0].a).toEqual(nasty)
  })

  test('the reversed form matches reverse() on the server, including a non-ASCII value', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { chStringLiteral, chReversedLiteral } = await import('@/lib/clickhouse-literals')
    for (const v of ['ledger.com', 'é.com', 'пример.рф', "o'neil.com"]) {
      const [row] = await executeQuery(`SELECT reverse(${chStringLiteral(v)}) = ${chReversedLiteral(v)} AS same`, {})
      expect(Number(row.same), v).toBe(1)
    }
  })
})
