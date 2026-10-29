import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'
import { NOISE_FILTER } from '@/lib/ulp-noise'

/**
 * LIVE check of the cursor (lib/cursor-pagination.ts) on the real table. Skipped unless CURSOR_PARITY=1; it talks to the real ClickHouse (the running
 * ulpsuite_clickhouse container, read-only) and drives the real GET /api/credentials handler. About a minute.
 *
 *   CURSOR_PARITY=1 npx vitest run __tests__/cursor-pagination.live.test.ts
 *
 * Why (docs/superpowers/specs/2026-10-28-next-page-speed-design.md): ClickHouse 26.3 does not prune the primary key with a tuple comparison, so a cursor that
 * was only `(domain, email, imported_at, url, password) > (...)` restarted the read at the first granule on every page. The cursor now carries a scalar superset the
 * key can use in front of the exact tuple. Two things must hold on the real table, and a test that mocks the SQL can prove neither:
 *   - the primary key (and, for imported_asc, the partition key) PRUNES: EXPLAIN selects far fewer granules than the table has;
 *   - the superset changes no row: fifteen pages followed through the route, inside one big domain, from a cursor in the middle of it and across the end of it, hand back the
 *     cursors of one ordered read of the same table (a skipped or a repeated row at a page boundary would shift every cursor after it).
 * CURSOR_TIMING_FILE=<path to a JSON file> adds one more test: how long the pages of ONE search take through the route (cold query and condition caches, the
 * page cache as it is). The file is {"q": "<the search text>", "start": {domain, email, imported_at, url, password} | null, "extra": "&login_type=email", "pages": 3}:
 * it holds a real search, so it lives in YOUR scratch directory, never in this repository. `start` is the cursor to begin from (null = the first page).
 * The walks use Declutter (exclude_noise=1), as the page does by default: the first group of the key, (domain, email, imported_at) all empty, is a run of
 * legacy junk rows so long that no ordered read of the whole table finishes in 100 s, with or without a cursor.
 * Nothing here names a search term or a domain: the middle of the table is "the first domain after 'm'".
 */
const LIVE = process.env.CURSOR_PARITY === '1'
const PAGE = 200
const PAGES = 15

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

type Key = { domain: string; email: string; imported_at: string; url: string; password: string }
const KEY_COLS = 'domain, email, imported_at, url, password'

/** The granules a section of EXPLAIN indexes = 1 selected out of the table's, read from its text. */
function granules(lines: string[], section: 'MinMax' | 'Partition' | 'PrimaryKey'): { selected: number; total: number } {
  const at = lines.findIndex(l => l.trim() === section)
  if (at < 0) throw new Error(`EXPLAIN has no ${section} section:\n${lines.join('\n')}`)
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^\s*Granules:\s*(\d+)\/(\d+)\s*$/.exec(lines[i])
    if (m) return { selected: Number(m[1]), total: Number(m[2]) }
    if (/^\s*(MinMax|Partition|PrimaryKey|Skip)\s*$/.test(lines[i])) break
  }
  throw new Error(`no Granules line under ${section}:\n${lines.join('\n')}`)
}

describe.skipIf(!LIVE)('cursor on the live table', () => {
  async function run<T = Record<string, unknown>>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const { executeQuery } = await import('@/lib/clickhouse')
    return (await executeQuery(sql, params)) as T[]
  }

  async function explain(sort: 'domain_asc' | 'domain_desc' | 'imported_asc', key: Key, legacy = false) {
    const { buildCursorWhere, SORT_MAP } = await import('@/lib/cursor-pagination')
    const built = buildCursorWhere(sort, { sort, v: { ...key } })
    // The tuple the cursor was before, kept here as the reference the pruning is measured against.
    const legacyClause: Record<string, string> = {
      domain_asc: '(domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})',
      domain_desc: '(domain < {c_d:String} OR (domain = {c_d:String} AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})))',
      imported_asc: '(imported_at, domain, email, url, password) > ({c_ia:DateTime}, {c_d:String}, {c_e:String}, {c_u:String}, {c_pw:String})',
    }
    const rows = await run<{ explain: string }>(
      `EXPLAIN indexes = 1 SELECT url, email, password, domain, imported_at FROM ulp.credentials WHERE 1 = 1 AND ${legacy ? legacyClause[sort] : built.clause} ORDER BY ${SORT_MAP[sort]} LIMIT 200`,
      built.params,
    )
    return rows.map(r => r.explain)
  }

  test('domain_asc: the primary key prunes a mid-table cursor (the tuple form selected every granule)', async () => {
    const [mid] = await run<Key>(`SELECT ${KEY_COLS} FROM ulp.credentials WHERE domain > 'm' ORDER BY domain ASC, email ASC, imported_at ASC, url ASC, password ASC LIMIT 1`)
    expect(mid, 'the table has no domain after "m"').toBeDefined()
    const now = granules(await explain('domain_asc', mid), 'PrimaryKey')
    const before = granules(await explain('domain_asc', mid, true), 'PrimaryKey')
    console.info(`domain_asc: ${now.selected} of ${now.total} granules (the tuple form: ${before.selected} of ${before.total})`)
    expect(now.total).toBeGreaterThan(1000)
    expect(now.selected, 'a cursor in the middle of the table must leave out a good part of it').toBeLessThan(now.total * 0.9)
  })

  test('domain_desc: the primary key prunes a cursor below the middle of the table', async () => {
    const [d] = await run<{ domain: string }>(`SELECT domain FROM ulp.credentials WHERE domain < 'm' ORDER BY domain DESC LIMIT 1`)
    const [mid] = await run<Key>(`SELECT ${KEY_COLS} FROM ulp.credentials WHERE domain = {d:String} ORDER BY email ASC, imported_at ASC, url ASC, password ASC LIMIT 1`, { d: d.domain })
    const now = granules(await explain('domain_desc', mid), 'PrimaryKey')
    console.info(`domain_desc: ${now.selected} of ${now.total} granules`)
    expect(now.selected).toBeLessThan(now.total * 0.9)
  })

  test('imported_asc: the partition key drops the months before the cursor', async () => {
    const [{ at }] = await run<{ at: string }>(`SELECT toString(max(imported_at) - INTERVAL 20 DAY) AS at FROM ulp.credentials`)
    const key: Key = { domain: 'a', email: 'a', imported_at: at, url: 'a', password: 'a' }
    const now = granules(await explain('imported_asc', key), 'Partition')
    const before = granules(await explain('imported_asc', key, true), 'Partition')
    console.info(`imported_asc: ${now.selected} of ${now.total} partition granules (the tuple form: ${before.selected} of ${before.total})`)
    expect(now.selected, 'the older months must be out').toBeLessThan(before.selected)
  })

  /** One ordered read of the table's non-noise rows (the page's default view), `limit` rows from `offset`: the cursors a walk must hand out come from these. */
  async function reference(where: string, params: Record<string, unknown>, limit: number, offset = 0): Promise<Key[]> {
    const { SORT_MAP } = await import('@/lib/cursor-pagination')
    return run<Key>(
      `SELECT ${KEY_COLS} FROM ulp.credentials WHERE ${NOISE_FILTER}${where} ORDER BY ${SORT_MAP.domain_asc} LIMIT ${limit} OFFSET ${offset} SETTINGS max_execution_time = 120`,
      params,
    )
  }

  /** Follows the route page by page and returns the cursor each page handed back. */
  async function walk(start: Key | null, pages: number, extra = ''): Promise<Key[]> {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { encodeCursor, decodeCursor } = await import('@/lib/cursor-pagination')
    const handed: Key[] = []
    let token = start ? encodeCursor('domain_asc', start as unknown as Record<string, unknown>) : ''
    for (let p = 0; p < pages; p++) {
      const res = await GET(new NextRequest(`http://localhost/api/credentials?sort=domain_asc&limit=${PAGE}&exclude_noise=1&skip_totals=1${extra}${token ? `&cursor=${encodeURIComponent(token)}` : ''}`))
      const body = await res.json()
      expect(body.success, `page ${p + 1}: ${JSON.stringify(body).slice(0, 200)}`).toBe(true)
      expect(body.results.length, `page ${p + 1}`).toBe(PAGE)
      expect(body.next_cursor, `page ${p + 1} must have a next page`).toBeTruthy()
      handed.push(decodeCursor(body.next_cursor)!.v as unknown as Key)
      token = body.next_cursor
    }
    return handed
  }

  const lastOfEachPage = (rows: Key[]) => rows.filter((_, i) => (i + 1) % PAGE === 0).map(r => ({ domain: r.domain, email: r.email, imported_at: r.imported_at, url: r.url, password: r.password }))

  /**
   * A domain of plain letters with thousands of rows, taken from the "m" region of the table (the data there is dense; the very start and the rows right
   * after "m" hold junk with enormous runs of equal keys, which no ordered read finishes quickly). Its rows tie on email and on imported_at by the thousand.
   */
  async function bigCleanDomain(): Promise<string> {
    const rows = await run<{ domain: string }>(
      `SELECT domain FROM ulp.credentials WHERE ${NOISE_FILTER} AND domain >= 'mb' AND domain < 'n' AND match(domain, '^[a-z0-9][a-z0-9.-]*[a-z]$')
       GROUP BY domain HAVING count() >= ${PAGE * PAGES} ORDER BY domain LIMIT 1 SETTINGS max_execution_time = 120`,
    )
    expect(rows[0], 'no domain in the m region has enough rows to walk').toBeDefined()
    return rows[0].domain
  }

  test(`domain_asc: ${PAGES} pages through one domain are one ordered read (rows tie on email, time and url)`, async () => {
    const d = await bigCleanDomain()
    const ref = await reference(' AND domain = {d:String}', { d }, PAGE * PAGES)
    expect(ref.length).toBe(PAGE * PAGES)
    expect(await walk(null, PAGES, `&domain=${encodeURIComponent(d)}`)).toEqual(lastOfEachPage(ref))
  }, 10 * 60_000)

  test('domain_asc: pages resumed from a cursor inside the domain continue where the ordered read does', async () => {
    const d = await bigCleanDomain()
    const ref = await reference(' AND domain = {d:String}', { d }, PAGE * PAGES)
    const from = 1234
    // a cursor at row `from` (0-based) of the domain; the pages after it start at row from + 1
    const walked = await walk(ref[from], PAGES - 7, `&domain=${encodeURIComponent(d)}`)
    expect(walked).toEqual(lastOfEachPage(ref.slice(from + 1)).slice(0, PAGES - 7))
  }, 10 * 60_000)

  test('domain_asc: a cursor in the middle of a run of rows that tie on email and imported_at loses none of the run', async () => {
    const d = await bigCleanDomain()
    const ref = await reference(' AND domain = {d:String}', { d }, PAGE * PAGES)
    // the rows whose successor has the same email AND the same imported_at: the cursor sits inside such a run and only url and password tell the rows apart
    const ties: number[] = []
    for (let i = 0; i + PAGE < ref.length; i++) if (ref[i].email === ref[i + 1].email && ref[i].imported_at === ref[i + 1].imported_at) ties.push(i)
    console.info(`rows that tie with the next one on email and imported_at: ${ties.length} of ${ref.length}`)
    expect(ties.length, 'the chosen domain has no such rows to test with').toBeGreaterThan(0)
    const step = Math.max(1, Math.floor(ties.length / 12))
    for (let k = 0; k < ties.length; k += step) {
      const i = ties[k]
      const [handed] = await walk(ref[i], 1, `&domain=${encodeURIComponent(d)}`)
      // one page after the cursor ends at row i + PAGE of the ordered read
      expect(handed, `cursor at row ${i}`).toEqual(lastOfEachPage(ref.slice(i + 1))[0])
    }
  }, 10 * 60_000)

  test('domain_asc: a cursor on the last row of a domain goes on with the next domain', async () => {
    const d = await bigCleanDomain()
    const [last] = await run<Key>(
      `SELECT ${KEY_COLS} FROM ulp.credentials WHERE ${NOISE_FILTER} AND domain = {d:String} ORDER BY email DESC, imported_at DESC, url DESC, password DESC LIMIT 1`,
      { d },
    )
    const pages = 5
    const ref = await reference(' AND domain > {d:String}', { d }, PAGE * pages)
    expect(ref.length).toBe(PAGE * pages)
    expect(ref[0].domain, 'the rows after the last row of a domain belong to a later domain').not.toBe(d)
    expect(await walk(last, pages)).toEqual(lastOfEachPage(ref))
  }, 10 * 60_000)

  test.skipIf(!process.env.CURSOR_TIMING_FILE)('timing: the pages of one search through the route (CURSOR_TIMING_FILE)', async () => {
    const { readFileSync } = await import('node:fs')
    const spec = JSON.parse(readFileSync(process.env.CURSOR_TIMING_FILE as string, 'utf8')) as { q: string; start: Key | null; extra?: string; pages?: number }
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { encodeCursor } = await import('@/lib/cursor-pagination')
    const { getClient } = await import('@/lib/clickhouse')
    const { resetSearchHitSetCache } = await import('@/lib/search-hit-set')
    const { resetSearchPlanGateCache } = await import('@/lib/search-plan-gate')
    resetSearchHitSetCache()
    resetSearchPlanGateCache()
    await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
    await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
    let token = spec.start ? encodeCursor('domain_asc', spec.start as unknown as Record<string, unknown>) : ''
    for (let p = 1; p <= (spec.pages ?? 3); p++) {
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent(spec.q)}&sort=domain_asc&limit=${PAGE}&dedupe=1&skip_totals=1${spec.extra ?? ''}${token ? `&cursor=${encodeURIComponent(token)}` : ''}`))
      const body = await res.json()
      console.info(`TIMING page ${p}${p === 1 && spec.start ? ' (from the given cursor)' : ''}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${body.results?.length ?? 0} rows, plan ${body.plan}, ${body.next_cursor ? 'has a next page' : 'last page'}`)
      expect(body.success, JSON.stringify(body).slice(0, 200)).toBe(true)
      if (!body.next_cursor) break
      token = body.next_cursor
    }
  }, 30 * 60_000)
})
