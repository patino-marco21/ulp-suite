import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the substring plan (lib/search-substring-plan.ts): the route's answer through the plan must be IDENTICAL to today's plain
 * query, page after page, for rows and for totals, and never more than SSP_MAX_SLOWDOWN (1.2) times slower. Skipped unless SSP_PARITY=1; it talks to
 * the real ClickHouse (the running ulpsuite_clickhouse container) and prints timings. It drives the real GET /api/credentials handler; the plain query
 * is forced with `token_plans=0`, so the SQL it compares against cannot drift from the route's. A text with no whole word under the gate runs today's
 * query in both cases, so it is reported and skipped (nothing to compare, and each run would take 35-80 s).
 *
 *   SSP_PARITY=1 npx vitest run __tests__/substring-plan-parity.live.test.ts
 *   SSP_PARITY=1 SSP_NEEDLES='/a/b.php,c:d' SSP_SORTS=domain_asc,imported_desc SSP_PAGES=1 npx vitest run __tests__/substring-plan-parity.live.test.ts
 *
 *   SSP_NEEDLES   comma list of texts to search (default: three invented ones). Real search terms belong in YOUR environment, never in this file:
 *                 the repository is public.
 *   SSP_SORTS     default domain_asc,imported_desc      SSP_DEDUPES  default 1      SSP_PAGES  default 2      SSP_MAX_SLOWDOWN  default 1.2
 *
 * The second half needs no data: it checks the whole-token rule against ClickHouse itself on two tiny scratch tables (ulp.zz_ssp_*, dropped at the
 * end): the production text index cuts tokens at exactly the ASCII non-alphanumerics, and for thousands of generated (needle, haystack) pairs, every
 * whole word of a needle is a token of every haystack the needle's LIKE matches. It is also the tripwire for a ClickHouse upgrade that changes the
 * tokenizer.
 *
 * The user profile has the query cache on and ClickHouse keeps a per-granule condition cache, so both are dropped before EVERY call.
 */
const LIVE = process.env.SSP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const NEEDLES = list(process.env.SSP_NEEDLES, '/zzqxnonexistent/page.php,index.php?id=,a b')
const SORTS = list(process.env.SSP_SORTS, 'domain_asc,imported_desc')
const DEDUPES = list(process.env.SSP_DEDUPES, '1')
const PAGES = Number(process.env.SSP_PAGES ?? 2)
const MAX_SLOWDOWN = Number(process.env.SSP_MAX_SLOWDOWN ?? 1.2)

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

describe.skipIf(!LIVE)('substring plan parity on the live table', () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | plan ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.plainMs} | ${t.planMs} (${t.plan}) | ${t.rows}`)
    for (const s of skipped) console.log(s)
  })

  test('a text whose rarest word is absent from the data is answered by the plan, quickly', async () => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const t0 = Date.now()
    const rows = await (await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent('/zzqxnonexistent/page.php')}&skip_totals=1&sort=domain_asc`))).json()
    const totals = await (await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent('/zzqxnonexistent/page.php')}&totals_only=1`))).json()
    console.log(`absent word: rows plan=${rows.plan}, totals plan=${totals.plan}, both in ${Date.now() - t0} ms`)
    expect(rows).toMatchObject({ success: true, plan: 'substring', results: [] })
    expect(totals).toMatchObject({ success: true, plan: 'substring', total: 0, raw_total: 0 })
  }, 120_000)

  const matrix = NEEDLES.flatMap((needle, i) => SORTS.flatMap(sort => DEDUPES.map(dedupe => ({ needle, sort, dedupe, label: `text #${i + 1}` }))))

  test.each(matrix)('$label | $sort | Unique=$dedupe', async ({ needle, sort, dedupe, label }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { resolveSubstringChoice, substringNeedleFromQuery } = await import('@/lib/search-substring-plan')
    const { resetSearchPlanGateCache } = await import('@/lib/search-plan-gate')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const text = substringNeedleFromQuery(needle, false)
    resetSearchPlanGateCache()
    const choice = text ? await resolveSubstringChoice(text) : null
    if (!choice) {
      skipped.push(`${label}: no whole word under the gate (or not a substring search): today's query runs, nothing to compare`)
      return
    }

    const call = async (qs: string, cold: boolean) => {
      if (cold) resetSearchPlanGateCache()
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }
    const base = `q=${encodeURIComponent(needle)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}`
    const scenario = `${label} (rarest word ${choice.hits} hits) ${sort} U${dedupe}`
    const slow = (plan: number, plain: number) => plan <= plain * MAX_SLOWDOWN + 1000

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const plain = await call(`${base}&skip_totals=1&token_plans=0${extra}`, true)
      const planned = await call(`${base}&skip_totals=1${extra}`, page === 1)
      expect(plain.body.success, `page ${page} (plain): ${JSON.stringify(plain.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.success, `page ${page}: ${JSON.stringify(planned.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.results).toEqual(plain.body.results)
      expect(planned.body.next_cursor).toEqual(plain.body.next_cursor)
      // Newest first is answered by the time windows when they can (a term concentrated in new data); the plan only after they hand off.
      expect(sort === 'imported_desc' ? ['substring', 'windows'] : ['substring'], `which plan answered: ${scenario} page ${page}`).toContain(planned.body.plan)
      expect(slow(planned.ms, plain.ms), `${scenario} page ${page}: plan ${planned.ms} ms against plain ${plain.ms} ms`).toBe(true)
      timings.push({ scenario, page: String(page), plainMs: plain.ms, planMs: planned.ms, plan: planned.body.plan, rows: plain.body.results.length })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }

    const plainTotals = await call(`${base}&totals_only=1&token_plans=0`, true)
    const plannedTotals = await call(`${base}&totals_only=1`, true)
    expect(plannedTotals.body.success).toBe(true)
    expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
      .toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
    expect(plannedTotals.body.plan).toBe('substring')
    expect(slow(plannedTotals.ms, plainTotals.ms), `${scenario} totals: plan ${plannedTotals.ms} ms against plain ${plainTotals.ms} ms`).toBe(true)
    timings.push({ scenario, page: 'totals', plainMs: plainTotals.ms, planMs: plannedTotals.ms, plan: plannedTotals.body.plan, rows: Number(plannedTotals.body.total) })
  }, 60 * 60_000)
})

// ── the whole-token rule against ClickHouse itself ──────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe.skipIf(!LIVE)('the whole-token rule agrees with ClickHouse', () => {
  const INDEX_TABLE = 'ulp.zz_ssp_index'
  const PAIRS_TABLE = 'ulp.zz_ssp_pairs'
  afterAll(async () => {
    const { getClient } = await import('@/lib/clickhouse')
    await getClient().command({ query: `DROP TABLE IF EXISTS ${INDEX_TABLE}` })
    await getClient().command({ query: `DROP TABLE IF EXISTS ${PAIRS_TABLE}` })
  })

  test('the production text index cuts tokens at exactly the ASCII non-alphanumerics; every other character, non-ASCII ones included, is part of a token', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const { SEARCH_INDEX_DEFINITIONS } = await import('@/lib/search-index-definitions')
    const client = getClient()
    await client.command({ query: `DROP TABLE IF EXISTS ${INDEX_TABLE}` })
    await client.command({ query: `CREATE TABLE ${INDEX_TABLE} (id UInt32, url String) ENGINE = MergeTree ORDER BY id` })
    const def = SEARCH_INDEX_DEFINITIONS.find(d => d.name === 'idx_inv_url')!
    await client.command({ query: def.addIndexSql(INDEX_TABLE) }) // the production DDL, verbatim, on an empty table: inserted rows are indexed
    const sample = [...Array(128).keys()].map(c => String.fromCharCode(c)).concat(['é', '–', ' ', '€', '日', '😀', 'ß', 'À', '·', '“'])
    await client.insert({ table: INDEX_TABLE, format: 'JSONEachRow', values: sample.map((c, id) => ({ id, url: `q${c}Abc${c}q` })) })
    await client.command({ query: `OPTIMIZE TABLE ${INDEX_TABLE} FINAL` })

    const explain = await (await client.query({ query: `EXPLAIN indexes = 1 SELECT id FROM ${INDEX_TABLE} WHERE hasToken(url, 'abc')`, format: 'TSVRaw' as never })).text()
    expect(explain).toContain('idx_inv_url')
    const found = ((await (await client.query({ query: `SELECT id FROM ${INDEX_TABLE} WHERE hasToken(url, 'abc') ORDER BY id`, format: 'JSONEachRow' })).json()) as Array<{ id: number }>)
      .map(r => Number(r.id))
    const expected = sample.map((c, id) => ({ c, id })).filter(({ c }) => c.charCodeAt(0) < 128 && !/[A-Za-z0-9]/.test(c)).map(({ id }) => id)
    expect(found).toEqual(expected)
  }, 120_000)

  test('property: every whole word of a needle is a token of every haystack the needle matches', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const { wholeTokens } = await import('@/lib/search-substring-plan')
    const client = getClient()
    await client.command({ query: `DROP TABLE IF EXISTS ${PAIRS_TABLE}` })
    await client.command({ query: `CREATE TABLE ${PAIRS_TABLE} (id UInt32, needle String, haystack String) ENGINE = MergeTree ORDER BY id` })

    const rand = mulberry32(20261013)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    const ALPHABET = ['a', 'B', '1', 'x9', '.', '/', '-', '_', '%', 'é', ' ', ':', '~', '\\', '€', '😀', '\t', 'login']
    const FILL = ['a', 'Z', '7', '.', '/', ' ', 'é', '_', '%', '-', '😀', '~', 'ledger']
    const fill = (max: number) => Array.from({ length: Math.floor(rand() * (max + 1)) }, () => pick(FILL)).join('')
    const rows: Array<{ id: number; needle: string; haystack: string }> = []
    for (let n = 0; n < 700; n++) {
      const needle = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick(ALPHABET)).join('')
      for (let h = 0; h < 8; h++) {
        // Expand the needle the way a LIKE pattern reads it: % is any string, _ any one character; then put arbitrary text on both sides.
        const expanded = Array.from(needle).map(ch => (ch === '%' ? fill(3) : ch === '_' ? pick(FILL) : ch)).join('')
        rows.push({ id: rows.length, needle, haystack: fill(3) + expanded + fill(3) })
      }
    }
    await client.insert({ table: PAIRS_TABLE, format: 'JSONEachRow', values: rows })
    const answered = (await (await client.query({
      query: `SELECT id, needle, haystack LIKE concat('%', needle, '%') AS m, tokens(lower(haystack), 'splitByNonAlpha') AS toks FROM ${PAIRS_TABLE}`,
      format: 'JSONEachRow',
    })).json()) as Array<{ id: number; needle: string; m: number; toks: string[] }>

    let matched = 0
    let withWords = 0
    const failures: string[] = []
    for (const r of answered) {
      if (!Number(r.m)) continue
      matched++
      const words = wholeTokens(r.needle)
      if (words.length) withWords++
      for (const w of words) if (!r.toks.includes(w)) failures.push(`pair ${r.id}: word ${JSON.stringify(w)} of needle ${JSON.stringify(r.needle)} is not a token`)
    }
    console.log(`property: ${rows.length} pairs, ${matched} matched by LIKE, ${withWords} of those with at least one whole word, ${failures.length} failures`)
    expect(matched).toBeGreaterThan(500)
    expect(withWords).toBeGreaterThan(50)
    expect(failures.slice(0, 5)).toEqual([])
  }, 120_000)
})
