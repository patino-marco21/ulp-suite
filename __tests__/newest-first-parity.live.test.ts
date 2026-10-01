import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for "Newest first" (lib/newest-first.ts): the route's windowed answer must be IDENTICAL to the plain query's,
 * page after page. Skipped unless NFW_PARITY=1; it talks to a real ClickHouse and prints timings. READ-ONLY.
 *
 *   NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts                       # the live table
 *   NFW_PARITY=1 NFW_TABLE=ulp.zz_nfw npx vitest run __tests__/newest-first-parity.live.test.ts  # a sandbox copy
 *
 * It drives the real GET /api/credentials handler. The plain query is forced by answering the readiness check "not ready".
 * The user profile has the query cache on, so the cache is dropped before EVERY call: otherwise a "windowed" call that handed off
 * to the plain query would just read the result the plain call before it cached, and look fast. The response's `plan` says which
 * plan really answered. Re-run it after anything that rebuilds the table or the projection (a content-dedup swap, a ClickHouse
 * upgrade, a new projection definition).
 *
 *   NFW_TIMING_ONLY=1 ...   page 1 only, windowed only: how long the default view takes now, and whether windows or the plain
 *                           query answered (no parity comparison; the plain query takes 15-90 s per call on the live table)
 */

const LIVE = process.env.NFW_PARITY === '1'
const TABLE = process.env.NFW_TABLE ?? 'ulp.credentials'
const SHORT = TABLE.split('.')[1]

let forcePlain = false
const TIMING_ONLY = process.env.NFW_TIMING_ONLY === '1'
const timings: Array<{ scenario: string; page: number; plainMs: number; windowedMs: number; rows: number; plan: string }> = []

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/clickhouse', async () => {
  const actual = await vi.importActual<typeof import('@/lib/clickhouse')>('@/lib/clickhouse')
  const rewrite = (sql: string) => sql.replaceAll('ulp.credentials', TABLE).replaceAll("table = 'credentials'", `table = '${SHORT}'`)
  return {
    ...actual,
    executeQuery: async (sql: string, params?: Record<string, unknown>) => {
      if (forcePlain && /system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }]
      return actual.executeQuery(rewrite(sql), params)
    },
  }
})

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

const scenarios: Array<{ name: string; qs: string; plan?: 'windows' | 'plain' }> = [
  { name: 'default view: Declutter + Unique, no search', qs: 'exclude_noise=1&dedupe=1', plan: 'windows' },
  { name: 'binance.com, Declutter + Unique', qs: 'q=binance.com&exclude_noise=1&dedupe=1', plan: 'windows' },
  { name: 'binance.com, no Declutter, no Unique', qs: 'q=binance.com', plan: 'windows' },
  { name: 'word token: ledger', qs: 'q=ledger&exclude_noise=1&dedupe=1' },
  { name: 'rare domain: trezor.io', qs: 'q=trezor.io&exclude_noise=1&dedupe=1' },
  { name: 'no match at all', qs: 'q=zzqxnonexistent.example&exclude_noise=1&dedupe=1', plan: 'plain' },
  { name: 'accounts.google.com (many matches)', qs: 'q=accounts.google.com&exclude_noise=1&dedupe=1', plan: 'windows' },
  { name: 'tier T1 + corporate', qs: 'tier_include=T1&is_corporate=1&exclude_noise=1&dedupe=1' },
  { name: 'date range inside the newest burst', qs: 'date_from=2026-08-28&date_to=2026-08-28&exclude_noise=1&dedupe=1' },
  { name: 'date range in the middle of the data', qs: 'date_from=2026-08-10&date_to=2026-08-20&q=gmail&exclude_noise=1&dedupe=1' },
  { name: 'date range older than the projection', qs: 'date_from=2026-07-01&date_to=2026-07-10&exclude_noise=1&dedupe=1' },
  { name: 'password filters', qs: 'pw_mask=numeric&pw_len_min=6&pw_len_max=8&exclude_noise=1&dedupe=1', plan: 'windows' },
  { name: 'regex search', qs: 'q=%5Eadmin%40&regex=1&exclude_noise=1&dedupe=1' },
]

const PAGES = 3

describe.skipIf(!LIVE)(`newest-first parity on ${TABLE}`, () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | windowed ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.plainMs} | ${t.windowedMs} (${t.plan}) | ${t.rows}`)
  })

  test.each(scenarios)('$name', async ({ name, qs, plan }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')
    const { getClient } = await import('@/lib/clickhouse')

    const call = async (extra: string, plain: boolean) => {
      forcePlain = plain
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' }) // see the header: a hand-off would otherwise read the plain call's cached result
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}&sort=imported_desc&limit=50&skip_totals=1${extra}`))
      const ms = Date.now() - t0
      const body = await res.json()
      return { ms, body }
    }

    if (TIMING_ONLY) {
      const windowed = await call('', false)
      expect(windowed.body.success).toBe(true)
      if (plan) expect(windowed.body.plan, `which plan answered: ${name}`).toBe(plan)
      timings.push({ scenario: name, page: 1, plainMs: 0, windowedMs: windowed.ms, rows: windowed.body.results.length, plan: windowed.body.plan })
      return
    }

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const plain = await call(extra, true)
      const windowed = await call(extra, false)
      expect(windowed.body.success, `page ${page}: ${JSON.stringify(windowed.body).slice(0, 300)}`).toBe(true)
      expect(plain.body.success, `page ${page} (plain)`).toBe(true)
      expect(windowed.body.results).toEqual(plain.body.results)
      expect(windowed.body.next_cursor).toEqual(plain.body.next_cursor)
      if (page === 1 && plan) expect(windowed.body.plan, `which plan answered: ${name}`).toBe(plan)
      timings.push({ scenario: name, page, plainMs: plain.ms, windowedMs: windowed.ms, rows: plain.body.results.length, plan: windowed.body.plan })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }
  }, 30 * 60_000)
})
