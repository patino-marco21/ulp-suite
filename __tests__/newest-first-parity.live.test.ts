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
 *
 * The `plan` expectations are PERFORMANCE expectations, not correctness ones: the rows are always compared first. The windows hand off to
 * the plain query when the next window is predicted to run past 2.5 s (lib/newest-first.ts, HANDOFF_MS), and a first window that runs on a
 * cold OS page cache (it follows scenarios that scan the whole table) can cross that line. A "which plan answered" failure with identical
 * rows: re-run that scenario alone (-t "<name>") before suspecting the code.
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
  // Since the search dictionary (2026-10-04) a one-domain term with no match is answered by it, after the windows hand off: the rows are
  // still the plain plan's (none), only the plan that answered changed from 'plain' to 'dictionary'.
  { name: 'no match at all', qs: 'q=zzqxnonexistent.example&exclude_noise=1&dedupe=1', plan: 'dictionary' },
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A word search on the windowed plan must return what the table plan returns, mixed-case matches included.
//
// On the table the text index ANSWERS hasToken (its preprocessor is lower(col), so "Foo", "FOO" and "foo" all match "foo"). A projection
// part has no text index, so hasToken there is the plain case-sensitive function and drops the capitalised forms. The windows read the
// projection (skip indexes off), so they spell word tokens over the lowercased column instead. Measured 2026-10-05 on the newest 2.2M rows
// for a common word: 27,285 matches on the table, 27,263 from the projection with the plain spelling. The 13 scenarios above never caught it:
// their only word search ("ledger") hands off to the plain plan.
//
//   NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts -t "case parity"
//   NFW_CASE_WORDS=login,admin NFW_CASE_WINDOW_SECONDS=3600 ...     other words / a wider window than the newest 15 minutes
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CASE_WORDS = (process.env.NFW_CASE_WORDS ?? 'login,admin,account,shop,game,bank,user,test').split(',').map(w => w.trim()).filter(Boolean)
const CASE_WINDOW_SECONDS = Number(process.env.NFW_CASE_WINDOW_SECONDS ?? 900)

describe.skipIf(!LIVE)(`newest-first case parity on ${TABLE}`, () => {
  /** The oldest second of the window the checks read: CASE_WINDOW_SECONDS back from the newest row (a projection key-range read, cheap). */
  async function windowFloor(): Promise<number> {
    const { getClient } = await import('@/lib/clickhouse')
    const rs = await getClient().query({ query: `SELECT toUnixTimestamp(max(imported_at)) AS n FROM ${TABLE}`, format: 'JSONEachRow' })
    const [row] = await rs.json<{ n: string }>()
    return Number(row.n) - CASE_WINDOW_SECONDS
  }

  async function countIn(where: string, params: Record<string, unknown>, settings: string, floor: number): Promise<number> {
    const { getClient } = await import('@/lib/clickhouse')
    const rs = await getClient().query({
      query: `SELECT count() AS c FROM ${TABLE} WHERE ${where} AND negate(toUnixTimestamp(imported_at)) < -${floor} SETTINGS use_query_cache = 0, ${settings}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ c: string }>()
    return Number(row.c)
  }

  test('case parity, term set: the lowercased spelling read without skip indexes equals the table plan (the plain spelling does not always)', async () => {
    const { buildULPWhere, parseULPQuery } = await import('@/lib/ulp-search')
    const floor = await windowFloor()
    const rows: Array<{ word: string; table: number; lowered: number; plainSpelling: number }> = []
    for (const word of CASE_WORDS) {
      const tokens = parseULPQuery(word)
      const plain = buildULPWhere(tokens)
      const lowered = buildULPWhere(tokens, { caseInsensitiveTokens: true })
      rows.push({
        word,
        // base table, skip indexes on: the text index answers hasToken
        table: await countIn(plain.clause, plain.params, 'optimize_use_projections = 0', floor),
        // what a projected window now runs: skip indexes off, word tokens over lower(col)
        lowered: await countIn(lowered.clause, lowered.params, 'use_skip_indexes = 0', floor),
        // what it ran before: skip indexes off, plain spelling (function semantics, case-sensitive)
        plainSpelling: await countIn(plain.clause, plain.params, 'use_skip_indexes = 0', floor),
      })
    }
    console.log('\nword | table plan | lowered spelling, skip off | plain spelling, skip off')
    for (const r of rows) console.log(`${r.word} | ${r.table} | ${r.lowered} | ${r.plainSpelling}`)
    for (const r of rows) expect(r.lowered, `word "${r.word}": lowercased spelling vs the table plan`).toBe(r.table)
    expect(
      rows.some(r => r.plainSpelling < r.table),
      'no candidate word has a mixed-case match in the window, so this run proves nothing: widen NFW_CASE_WINDOW_SECONDS or set NFW_CASE_WORDS',
    ).toBe(true)
  }, 20 * 60_000)

  test('case parity, end to end: a page that starts on a case-only match is identical on the windowed and the plain plan', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')
    const { encodeCursor } = await import('@/lib/cursor-pagination')
    const floor = await windowFloor()

    // The newest row that matches a word only when lowercased, for the first candidate word that has one.
    let target: Record<string, string> | undefined
    let word = ''
    for (const w of CASE_WORDS) {
      const raw = `(hasToken(url,'${w}') OR hasToken(email,'${w}') OR hasToken(password,'${w}') OR url_host LIKE '%${w}%' OR email_domain LIKE '%${w}%')`
      const low = `(hasToken(lower(url),'${w}') OR hasToken(lower(email),'${w}') OR hasToken(lower(password),'${w}') OR url_host LIKE '%${w}%' OR email_domain LIKE '%${w}%')`
      const rs = await getClient().query({
        query: `SELECT toString(imported_at) AS imported_at, domain, email, url, password FROM ${TABLE}
                WHERE negate(toUnixTimestamp(imported_at)) < -${floor} AND ${low} AND NOT ${raw}
                ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC LIMIT 1 SETTINGS use_skip_indexes = 0, use_query_cache = 0`,
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<Record<string, string>>()
      if (row) { target = row; word = w; break }
    }
    expect(target, 'no candidate word has a case-only match in the window: widen NFW_CASE_WINDOW_SECONDS or set NFW_CASE_WORDS').toBeDefined()

    // A cursor that puts exactly that row first: same second, same domain / email / url, an empty password sorts before it.
    const cursor = encodeCursor('imported_desc', { imported_at: target!.imported_at, domain: target!.domain, email: target!.email, url: target!.url, password: '' })
    const key = (r: Record<string, unknown>) => `${r.imported_at}|${r.url}|${r.email}|${r.password}`
    const call = async (plain: boolean) => {
      forcePlain = plain
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      const res = await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent(word)}&sort=imported_desc&limit=20&skip_totals=1&cursor=${encodeURIComponent(cursor)}`))
      const body = await res.json()
      expect(body.success, `${plain ? 'plain' : 'windowed'}: ${JSON.stringify(body).slice(0, 200)}`).toBe(true)
      return body as { plan: string; results: Array<Record<string, unknown>> }
    }
    const windowed = await call(false)
    const plain = await call(true)
    expect(windowed.plan, 'the windowed call must really be answered by windows').toBe('windows')
    expect(plain.results.map(key), `word "${word}"`).toEqual(windowed.results.map(key))
    expect(plain.results.some(r => key(r) === key(target!)), 'the plain plan returns the case-only row').toBe(true)
  }, 15 * 60_000)
})
