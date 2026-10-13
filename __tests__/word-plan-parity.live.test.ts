import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the word plan (lib/search-dictionary-plan.ts, wordTermFromQuery): for a single word the route's answer through the plan must be
 * IDENTICAL to today's plain query, page after page, for rows and for totals, and never more than SWP_MAX_SLOWDOWN (1.2) times slower. Skipped unless
 * SWP_PARITY=1; it talks to the real ClickHouse (the running ulpsuite_clickhouse container) and prints timings. It drives the real GET /api/credentials
 * handler; the plain query is forced with `token_plans=0`, so the SQL it compares against cannot drift from the route's. A word over the dictionary caps
 * (or a stale dictionary) runs today's query in both cases, so it is reported and skipped; a word that fails only the ROWS gate is compared too (its rows
 * must then come from today's query and be identical, its totals from the plan unless they fail the totals gate as well).
 *
 *   SWP_PARITY=1 npx vitest run __tests__/word-plan-parity.live.test.ts
 *   SWP_PARITY=1 SWP_WORDS=ledger,trezor SWP_SORTS=domain_asc,imported_desc SWP_PAGES=1 npx vitest run __tests__/word-plan-parity.live.test.ts
 *
 *   SWP_WORDS     comma list of words (default: two invented/public ones). Real search terms belong in YOUR environment, never in this file: the repository
 *                 is public.
 *   SWP_SORTS     default domain_asc,imported_desc      SWP_DEDUPES  default 1      SWP_PAGES  default 1      SWP_MAX_SLOWDOWN  default 1.2
 *   SWP_EXTRA     query parameters appended to every request, e.g. `&imported_after=2026-10-12` (a date-bounded word search)
 *
 * Calibrating the gates: raise the limits so that every word's rows and totals go through the plan, and raise the two budgets in lib/search-plan-gate.ts
 * for the run (otherwise the plan gives up at 8 s and 12 s and the run records today's query instead), then read the timing table (the assertion on speed is
 * meaningless then, so raise SWP_MAX_SLOWDOWN too):
 *   SEARCH_WORD_ROWS_MAX_DOMAINS=3000 SEARCH_WORD_ROWS_MAX_EMAIL_ROWS=100000000 SEARCH_WORD_TOTALS_MAX_EMAIL_ROWS=100000000 SWP_MAX_SLOWDOWN=1000 SWP_PARITY=1 ...
 *
 * The user profile has the query cache on and ClickHouse keeps a per-granule condition cache, so both are dropped before EVERY call.
 */
const LIVE = process.env.SWP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const WORDS = list(process.env.SWP_WORDS, 'zzqxnonexistent,ledger')
const SORTS = list(process.env.SWP_SORTS, 'domain_asc,imported_desc')
const DEDUPES = list(process.env.SWP_DEDUPES, '1')
const PAGES = Number(process.env.SWP_PAGES ?? 1)
const MAX_SLOWDOWN = Number(process.env.SWP_MAX_SLOWDOWN ?? 1.2)
const EXTRA = process.env.SWP_EXTRA ?? ''

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

type Timing = { scenario: string; page: string; plainMs: number; planMs: number; plan: string; rows: number }
const timings: Timing[] = []
const skipped: string[] = []

describe.skipIf(!LIVE)('word plan parity on the live table', () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | plan ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.plainMs} | ${t.planMs} (${t.plan}) | ${t.rows}`)
    for (const s of skipped) console.log(s)
  })

  test('the dictionary is fresh, so the comparison below measures the plan and not its fallback', async () => {
    const { getSearchDictionaryStatus, resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    resetSearchDictionaryCache()
    const status = await getSearchDictionaryStatus()
    console.log(`dictionary: ${status.state}, ${status.pairRows} host pairs, ${status.emailRows} email domains, built ${status.builtAt}`)
    expect(status.state, 'run scripts/build-search-dictionary.ts first').toBe('fresh')
  })

  const matrix = WORDS.flatMap((word, i) => SORTS.flatMap(sort => DEDUPES.map(dedupe => ({ word, sort, dedupe, label: `word #${i + 1}` }))))

  test.each(matrix)('$label | $sort | Unique=$dedupe', async ({ word, sort, dedupe, label }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { wordTermFromQuery, resolveWordCandidates, resetDictionaryPlanCache } = await import('@/lib/search-dictionary-plan')
    const { probeEmailDomainRows, wordRowsGate, wordTotalsGate, resetSearchPlanGateCache } = await import('@/lib/search-plan-gate')
    const { resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const term = wordTermFromQuery(word, false)
    resetDictionaryPlanCache(); resetSearchPlanGateCache(); resetSearchDictionaryCache()
    const candidates = term ? await resolveWordCandidates(term) : null
    if (!term || !candidates) {
      skipped.push(`${label}: over the dictionary caps, not a plain word or no fresh dictionary: today's query runs, nothing to compare`)
      return
    }
    const emailRows = candidates.emailDomains.length === 0 ? 0 : await probeEmailDomainRows(term.word, candidates.emailRevLiteral)
    const rowsPlan = wordRowsGate(candidates, emailRows)
    const totalsPlan = wordTotalsGate(emailRows)

    const call = async (qs: string, cold: boolean) => {
      if (cold) { resetDictionaryPlanCache(); resetSearchPlanGateCache(); resetSearchDictionaryCache() }
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }
    const base = `q=${encodeURIComponent(word)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}${EXTRA}`
    const scenario = `${label} (|D| ${candidates.domains.length}, |E| ${candidates.emailDomains.length}, ${emailRows} e-mail rows, rows ${rowsPlan ? 'plan' : 'plain'}, totals ${totalsPlan ? 'plan' : 'plain'}) ${sort} U${dedupe}`
    const slow = (plan: number, plain: number) => plan <= plain * MAX_SLOWDOWN + 1000
    // Newest first is answered by the time windows when they can (a word concentrated in new data); the plan or the plain query only after they hand off.
    const expectedRows = rowsPlan ? (sort === 'imported_desc' ? ['words', 'windows'] : ['words']) : (sort === 'imported_desc' ? ['plain', 'windows'] : ['plain'])

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const plain = await call(`${base}&skip_totals=1&token_plans=0${extra}`, true)
      const planned = await call(`${base}&skip_totals=1${extra}`, page === 1)
      expect(plain.body.success, `page ${page} (plain): ${JSON.stringify(plain.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.success, `page ${page}: ${JSON.stringify(planned.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.results).toEqual(plain.body.results)
      expect(planned.body.next_cursor).toEqual(plain.body.next_cursor)
      expect(expectedRows, `which plan answered the rows: ${scenario} page ${page}`).toContain(planned.body.plan)
      if (planned.body.plan === 'words') expect(slow(planned.ms, plain.ms), `${scenario} page ${page}: plan ${planned.ms} ms against plain ${plain.ms} ms`).toBe(true)
      timings.push({ scenario, page: String(page), plainMs: plain.ms, planMs: planned.ms, plan: planned.body.plan, rows: plain.body.results.length })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }

    const plainTotals = await call(`${base}&totals_only=1&token_plans=0`, true)
    const plannedTotals = await call(`${base}&totals_only=1`, true)
    expect(plannedTotals.body.success).toBe(true)
    expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
      .toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
    expect(plannedTotals.body.plan, `${scenario}: which plan answered the totals (words, unless the gate said no or the plan ran over its budget)`).toBe(totalsPlan ? 'words' : 'plain')
    if (plannedTotals.body.plan === 'words') expect(slow(plannedTotals.ms, plainTotals.ms), `${scenario} totals: plan ${plannedTotals.ms} ms against plain ${plainTotals.ms} ms`).toBe(true)
    timings.push({ scenario, page: 'totals', plainMs: plainTotals.ms, planMs: plannedTotals.ms, plan: plannedTotals.body.plan, rows: Number(plannedTotals.body.total) })
  }, 60 * 60_000)
})
