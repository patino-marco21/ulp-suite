import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the imported-range bound (lib/imported-range.ts): for several cutoffs, searches and sorts, the route's answer with
 * the helper's plan (the projection form where it is allowed, the windows over proj_imported_desc) must be ROW FOR ROW what the PLAIN bound
 * returns, page after page, and the totals must match too. Skipped unless IRP_PARITY=1; it talks to a real ClickHouse, prints timings and
 * is READ-ONLY.
 *
 *   IRP_PARITY=1 npx vitest run __tests__/imported-range-parity.live.test.ts                  # the live table (30-60 min: the plain plan is slow)
 *   IRP_PARITY=1 IRP_ONLY="oldest first" npx vitest run __tests__/imported-range-parity.live.test.ts   # scenarios whose name contains the text
 *   IRP_PARITY=1 IRP_TABLE=ulp.zz_irp npx vitest run ...                                      # a sandbox copy
 *
 * It drives the real GET /api/credentials handler. The plain plan is forced by answering the readiness check "not ready", which makes
 * planImportedRange emit the plain bound and Newest-first hand off to the plain query. The user profile has the query cache on, so it is
 * dropped before EVERY call (a cached answer would look like a speedup and hide a difference). Re-run it after anything that rebuilds the table
 * or the projection, and after a ClickHouse upgrade.
 */

const LIVE = process.env.IRP_PARITY === '1'
const TABLE = process.env.IRP_TABLE ?? 'ulp.credentials'
const SHORT = TABLE.split('.')[1]
const ONLY = process.env.IRP_ONLY ?? ''
const PAGES = Number(process.env.IRP_PAGES ?? 2)

let forcePlain = false
const timings: Array<{ scenario: string; what: string; plainMs: number; helperMs: number; plan: string }> = []

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

// The data runs 2026-07-03 .. 2026-08-28. Cutoffs: the newest ~2.2M rows, the whole newest burst (143M rows), the newest partition, both partitions.
const NEWEST = '2026-08-28T23:30:00Z'
const BURST = '2026-08-28T20:00:00Z'
const PARTITION = '2026-08-16T00:00:00Z'
const BOTH = '2026-07-10T00:00:00Z'
const VIEW = 'exclude_noise=1&dedupe=1'

const scenarios: Array<{ name: string; qs: string; plainExtra?: string }> = [
  { name: 'no query, newest first, newest rows', qs: `imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'no query, newest first, the whole burst', qs: `imported_after=${BURST}&sort=imported_desc&${VIEW}` },
  { name: 'domain term, newest first, newest rows', qs: `q=binance.com&imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'domain term, newest first, the whole burst', qs: `q=binance.com&imported_after=${BURST}&sort=imported_desc&${VIEW}` },
  { name: 'domain term, oldest first (projection form on the plain query)', qs: `q=binance.com&imported_after=${BURST}&sort=imported_asc&${VIEW}` },
  { name: 'domain term, default sort (plain bound)', qs: `q=binance.com&imported_after=${PARTITION}&${VIEW}` },
  { name: 'domain term, closed window', qs: `q=binance.com&imported_after=${BURST}&imported_before=2026-08-28T22:00:00Z&sort=imported_desc&${VIEW}` },
  { name: 'domain term, upper bound only', qs: `q=binance.com&imported_before=2026-08-20T00:00:00Z&sort=imported_desc&${VIEW}` },
  { name: 'domain term, range spanning both partitions', qs: `q=binance.com&imported_after=${BOTH}&sort=imported_desc&${VIEW}` },
  { name: '@domain term, newest first', qs: `q=${encodeURIComponent('@gmail.com')}&imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'word term, newest first (plain bound; windows over lower(col))', qs: `q=ledger&imported_after=${BURST}&sort=imported_desc&${VIEW}` },
  { name: 'word term that has mixed-case matches, newest first', qs: `q=login&imported_after=${NEWEST}&sort=imported_desc` },
  { name: 'regex, newest first', qs: `q=${encodeURIComponent('^admin@')}&regex=1&imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'legacy date_from (a whole UTC day), newest first', qs: `date_from=2026-08-28&sort=imported_desc&${VIEW}` },
  {
    name: 'one domain term + a bound, dictionary on against off',
    qs: `q=trezor.io&imported_after=${BOTH}&sort=domain_asc&${VIEW}`,
    plainExtra: '&dictionary=0',
  },
]

describe.skipIf(!LIVE)(`imported-range parity on ${TABLE}`, () => {
  afterAll(() => {
    console.log('\nscenario | what | plain plan ms | helper plan ms (plan)')
    for (const t of timings) console.log(`${t.scenario} | ${t.what} | ${t.plainMs} | ${t.helperMs} (${t.plan})`)
  })

  test.each(scenarios.filter(s => !ONLY || s.name.includes(ONLY)))('$name', async ({ name, qs, plainExtra }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')
    const { getClient } = await import('@/lib/clickhouse')

    const call = async (extra: string, plain: boolean) => {
      forcePlain = plain
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}&limit=50${plain ? plainExtra ?? '' : ''}${extra}`))
      const ms = Date.now() - t0
      return { ms, status: res.status, body: await res.json() }
    }

    // Totals first: the same search, no rows.
    const plainTotals = await call('&totals_only=1', true)
    const helperTotals = await call('&totals_only=1', false)
    expect(helperTotals.body.success, `totals: ${JSON.stringify(helperTotals.body).slice(0, 300)}`).toBe(true)
    expect(plainTotals.body.success, 'totals (plain)').toBe(true)
    expect({ total: helperTotals.body.total, raw_total: helperTotals.body.raw_total }).toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
    timings.push({ scenario: name, what: 'totals', plainMs: plainTotals.ms, helperMs: helperTotals.ms, plan: helperTotals.body.plan ?? '-' })

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = `&skip_totals=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const plain = await call(extra, true)
      const helper = await call(extra, false)
      expect(helper.body.success, `page ${page}: ${JSON.stringify(helper.body).slice(0, 300)}`).toBe(true)
      expect(plain.body.success, `page ${page} (plain)`).toBe(true)
      expect(helper.body.results).toEqual(plain.body.results)
      expect(helper.body.next_cursor).toEqual(plain.body.next_cursor)
      timings.push({ scenario: name, what: `page ${page} (${plain.body.results.length} rows)`, plainMs: plain.ms, helperMs: helper.ms, plan: helper.body.plan })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }
  }, 40 * 60_000)
})
