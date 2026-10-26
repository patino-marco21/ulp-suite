import { execSync } from 'node:child_process'
import { afterAll, describe, expect, test, vi } from 'vitest'

/**
 * LIVE check of the hit-set plan (lib/search-hit-set.ts) and of the cancellation of abandoned searches (lib/clickhouse.ts). Skipped unless HSP_PARITY=1; it talks
 * to the real ClickHouse (the running ulpsuite_clickhouse container) and drives the real GET /api/credentials handler.
 *
 *   HSP_PARITY=1 npx vitest run __tests__/hit-set-parity.live.test.ts
 *   HSP_PARITY=1 HSP_NEEDLES='/a/b.php,c:d' HSP_CHIPS=,email,phone HSP_SORTS=domain_asc,email_asc npx vitest run __tests__/hit-set-parity.live.test.ts
 *
 *   HSP_NEEDLES  comma list of texts with a special character (default: one invented text with no hits). Real search terms belong in YOUR environment,
 *                never in this file: the repository is public. A text with a rare whole word INSIDE it (not at either end) is the substring plan's and is
 *                skipped here, so the default has only edge words (`a:b`); use texts whose inner words are common.
 *   HSP_CHIPS    comma list of login_type values to try after the first search ('' = none); default ",email"
 *   HSP_SORTS    default domain_asc      HSP_DEDUPES  default 1      HSP_MAX_FAST_MS  default 15000: what a later click may take once the set exists
 *
 * Each text is searched TWICE per variant: with `hit_set=0` (today's query, the reference: every call drops the query cache and the condition cache first, so
 * each one is a real scan of 40-130 s) and with the plan. The results, the next-page cursor and both totals must be IDENTICAL; the first plan call pays the
 * one scan, and every later variant (a chip, a sort, Unique off) must be answered by the plan from the same set within HSP_MAX_FAST_MS.
 * A text with more hits than SEARCH_HIT_SET_MAX_HITS is the plain query's (reported and skipped: nothing to compare).
 *
 * The last two tests start a search with a text that exists nowhere, abandon it 3 s later (as a browser does when a newer search replaces it) and look in
 * system.processes: nothing may still be running for it.
 */
const LIVE = process.env.HSP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim())
const NEEDLES = list(process.env.HSP_NEEDLES, 'zzqxhitset:zzqxpass').filter(Boolean)
const CHIPS = list(process.env.HSP_CHIPS, ',email')
const SORTS = list(process.env.HSP_SORTS, 'domain_asc').filter(Boolean)
const DEDUPES = list(process.env.HSP_DEDUPES, '1').filter(Boolean)
const MAX_FAST_MS = Number(process.env.HSP_MAX_FAST_MS ?? 15_000)

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

type Timing = { scenario: string; plainRowsMs: number; planRowsMs: number; plainTotalsMs: number; planTotalsMs: number; plan: string; rows: number }
const timings: Timing[] = []
const skipped: string[] = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe.skipIf(!LIVE)('hit-set plan on the live table', () => {
  test.each(NEEDLES.map((needle, i) => ({ needle, label: `text #${i + 1}` })))('$label: the plan\'s answer equals today\'s, and every later click is cheap', async ({ needle, label }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { resetSearchHitSetCache } = await import('@/lib/search-hit-set')
    const { resetSearchPlanGateCache } = await import('@/lib/search-plan-gate')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const call = async (qs: string, cold: boolean) => {
      if (cold) {
        resetSearchPlanGateCache()
        resetNewestFirstReadyCache()
        await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
        await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      }
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }

    resetSearchHitSetCache()
    let built = false // the set is built by the first plan call of this text; the others must find it
    for (const sort of SORTS) for (const dedupe of DEDUPES) for (const chip of CHIPS) {
      const base = `q=${encodeURIComponent(needle)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}${chip ? `&login_type=${chip}` : ''}`
      const scenario = `${label} ${sort} U${dedupe} ${chip || 'no chip'}`

      const plannedRows = await call(`${base}&skip_totals=1`, false)
      const plannedTotals = await call(`${base}&totals_only=1`, false)
      expect(plannedRows.body.success, `${scenario}: ${JSON.stringify(plannedRows.body).slice(0, 300)}`).toBe(true)
      if (!built) {
        built = true
        if (plannedRows.body.plan !== 'hits') {
          skipped.push(`${scenario}: answered by '${plannedRows.body.plan}' (more hits than the cap, or not eligible): today's query runs, nothing to compare`)
          return
        }
      } else {
        expect(plannedRows.body.plan, `${scenario}: a later click must be answered from the set`).toBe('hits')
        expect(plannedRows.ms, `${scenario}: rows took ${plannedRows.ms} ms`).toBeLessThan(MAX_FAST_MS)
        expect(plannedTotals.ms, `${scenario}: totals took ${plannedTotals.ms} ms`).toBeLessThan(MAX_FAST_MS)
      }
      expect(plannedTotals.body.plan).toBe('hits')

      const plainRows = await call(`${base}&skip_totals=1&hit_set=0`, true)
      const plainTotals = await call(`${base}&totals_only=1&hit_set=0`, true)
      expect(plainRows.body.success, `${scenario} (plain): ${JSON.stringify(plainRows.body).slice(0, 300)}`).toBe(true)
      expect(plainRows.body.plan).toBe('plain')
      expect(plannedRows.body.results).toEqual(plainRows.body.results)
      expect(plannedRows.body.next_cursor).toEqual(plainRows.body.next_cursor)
      expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
        .toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
      timings.push({
        scenario, plainRowsMs: plainRows.ms, planRowsMs: plannedRows.ms, plainTotalsMs: plainTotals.ms, planTotalsMs: plannedTotals.ms,
        plan: plannedRows.body.plan, rows: plainRows.body.results.length,
      })
    }
  }, 60 * 60_000)

  /** The ClickHouse statements still running whose text contains `marker`. */
  async function running(marker: string): Promise<number> {
    const { getClient } = await import('@/lib/clickhouse')
    const rs = await getClient().query({
      query: 'SELECT count() AS n FROM system.processes WHERE position(query, {m:String}) > 0 AND query NOT LIKE \'%system.processes%\'',
      query_params: { m: marker }, format: 'JSONEachRow',
    })
    return Number(((await rs.json()) as Array<{ n: string }>)[0]?.n ?? 0)
  }

  test.each([
    ['today\'s query (hit_set=0)', 'hit_set=0&skip_totals=1'],
    ['the position scan', 'skip_totals=1'],
  ])('an abandoned search leaves nothing running in ClickHouse: %s', async (_label, extra) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { resetSearchHitSetCache } = await import('@/lib/search-hit-set')
    resetSearchHitSetCache()
    // Only edge words (`a:b`): a word INSIDE the text would let the substring plan answer in a second, and there would be nothing left to abandon.
    const marker = `zzabandon${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const needle = `${marker}:${marker}x`
    const controller = new AbortController()
    const response = GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent(needle)}&${extra}&exclude_noise=1&dedupe=1`, { signal: controller.signal }))

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && (await running(marker)) === 0) await sleep(250)
    expect(await running(marker), 'the search should be running in ClickHouse before it is abandoned').toBeGreaterThan(0)
    await sleep(3_000)
    controller.abort() // the browser moved on
    expect((await response).status).toBe(499)

    const gone = Date.now() + 15_000 // the kill is sent at once for today's query, after a 1.5 s grace for the shared scan
    while (Date.now() < gone && (await running(marker)) > 0) await sleep(250)
    expect(await running(marker), 'nothing may still be scanning for a search nobody waits for').toBe(0)
  }, 120_000)
})

afterAll(() => {
  if (!LIVE) return
  console.log('\nscenario | plain rows ms | plan rows ms | plain totals ms | plan totals ms | plan | rows')
  for (const t of timings) console.log(`${t.scenario} | ${t.plainRowsMs} | ${t.planRowsMs} | ${t.plainTotalsMs} | ${t.planTotalsMs} | ${t.plan} | ${t.rows}`)
  for (const s of skipped) console.log(s)
})
