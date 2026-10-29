/**
 * End-to-end scenarios for the next-page cursor (lib/cursor-pagination.ts), against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own
 * ClickHouse, app and volumes; it shares nothing with the real stack). The app there runs the PRODUCTION image, so this proves what the built image does,
 * through its HTTP server, with a real login cookie and a real ClickHouse.
 *
 *   REHEARSAL_APP_IMAGE=<tag> npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-cursor-pages.ts                                        # about 1 minute
 *   REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x \
 *     docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v   # the compose file wants these set even to stop the stack
 *
 * Why (docs/superpowers/specs/2026-10-28-next-page-speed-design.md): ClickHouse 26.3 does not prune the primary key with a tuple comparison, so the cursor
 * carries a scalar superset in front of the exact tuple. The superset must change no row, and a table built to make that fail is the only way to know:
 *   - the rows tie on (domain, email, imported_at) in groups of 25, so a page boundary falls INSIDE a tie group and only url and password tell the rows apart;
 *   - twelve domains of different sizes, so boundaries fall on a change of domain, of email and of time;
 *   - one url carries two passwords of different lengths.
 * Every sort of the page is followed page by page to the end (pages of 7, a prime, so that boundaries land everywhere) and must hand back EXACTLY the rows of one
 * ordered read, in the same order, each once. Then cursors on every tie, and on the first and last row of every domain, are resumed with a short page. Then the
 * primary key is shown to prune on a table of 1.4 million rows (a mid-table cursor must leave out a good part of its 22 granules). Every text is unique per run.
 * Exit 0 when every check passes, 1 when one fails, 2 when the stack is not ready.
 */
import { execFileSync } from 'node:child_process'
import { buildCursorWhere, encodeCursor, SORT_MAP, type SortKey } from '@/lib/cursor-pagination'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const HOST = '127.0.0.1'
const PORT = 3101
const BASE = `http://${HOST}:${PORT}`
if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || PORT !== 3101) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const RUN = Date.now().toString(36)
const SRC = `cpseed-${RUN}` // source_file of the walk table
const BIG = `cpbig-${RUN}` // source_file of the 1.4 million rows
const WORD = `cpw${RUN}` // a whole word in every url of the walk table, for the search through the same pages
const PAGE = 7
const DOMAINS = 12

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}
const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}
// --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
const chQuery = (sql: string, extra: string[] = []) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', ...extra, '--query', sql])
const COLS = 'url, email, password, domain, source_file, breach_name, imported_at'

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 1000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch { /* not yet */ }
    await sleep(intervalMs)
  }
  return null
}

let cookie = ''
async function login(): Promise<void> {
  const email = sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL'])
  const password = sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD'])
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

type Row = { url: string; email: string; password: string; domain: string; imported_at: string }
const shown = (r: Record<string, unknown>): Row => ({ url: String(r.url), email: String(r.email), password: String(r.password), domain: String(r.domain), imported_at: String(r.imported_at) })

function seed(): number {
  // Twelve domains of 60, 101, 142 ... rows. Blocks of 40 rows share an email and blocks of 25 share a second: groups of up to 25 rows tie on
  // (domain, email, imported_at) and differ only in url, and the boundaries of the two blocks never line up.
  let total = 0
  for (let d = 0; d < DOMAINS; d++) {
    const n = 60 + 41 * d
    total += n
    chQuery(`INSERT INTO ulp.credentials (${COLS})
      SELECT concat('https://s${d}.test/${WORD}/p', toString(number)), concat('u', toString(intDiv(number, 40)), '@m${RUN}.test'), concat('pw', toString(number % 7), 'x'),
             'cp${RUN}-${d}.test', '${SRC}', '', toDateTime('2026-09-01 00:00:00') + intDiv(number, 25)
      FROM numbers(${n})`)
  }
  // The same url with two passwords of different lengths (the sorts that stop at the url need the length to tell them apart).
  chQuery(`INSERT INTO ulp.credentials (${COLS})
    SELECT concat('https://s3.test/${WORD}/p', toString(number)), concat('u', toString(intDiv(number, 40)), '@m${RUN}.test'), concat('pw', toString(number % 7), 'x', repeat('y', 1 + number % 3)),
           'cp${RUN}-3.test', '${SRC}', '', toDateTime('2026-09-01 00:00:00') + intDiv(number, 25)
    FROM numbers(30)`)
  return total + 30
}

/** One ordered read of the walk table: what every walk must hand back. */
function reference(sort: SortKey): Row[] {
  const out = chQuery(`SELECT url, email, password, domain, imported_at FROM ulp.credentials WHERE source_file = '${SRC}' ORDER BY ${SORT_MAP[sort]} FORMAT JSONEachRow`)
  return out.split('\n').filter(Boolean).map(line => shown(JSON.parse(line)))
}

/** Follows the cursor to the end, `limit` rows a page; every page asks like the page does (rows only, no totals). */
async function walk(sort: SortKey, limit: number, extra = ''): Promise<{ rows: Row[]; pages: number; error: string | null; plans: string[] }> {
  const rows: Row[] = []
  const plans: string[] = []
  let cursor = ''
  for (let pages = 1; pages < 5000; pages++) {
    const r = await api(`/api/credentials?source_file=${SRC}&sort=${sort}&limit=${limit}&skip_totals=1${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (r.status !== 200 || !r.body?.success) return { rows, pages, error: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`, plans }
    for (const x of r.body.results) rows.push(shown(x))
    if (typeof r.body.plan === 'string' && !plans.includes(r.body.plan)) plans.push(r.body.plan)
    if (!r.body.next_cursor) return { rows, pages, error: null, plans }
    cursor = r.body.next_cursor
  }
  return { rows, pages: 5000, error: 'no end after 5000 pages', plans }
}

const sameRows = (a: Row[], b: Row[]) => a.length === b.length && a.every((r, i) => JSON.stringify(r) === JSON.stringify(b[i]))
/** The first position where two row lists differ, for the message of a failed check. */
function firstDifference(got: Row[], want: Row[]): string {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) return `row ${i}: got ${JSON.stringify(got[i])?.slice(0, 120)}, want ${JSON.stringify(want[i])?.slice(0, 120)} (got ${got.length} rows, want ${want.length})`
  }
  return ''
}

/** The granules the primary key selected out of the table's, from EXPLAIN indexes = 1 (the cursor's parameters are bound with --param_*). */
function primaryKeyGranules(sort: SortKey, key: Record<string, string>, clause: string): { selected: number; total: number } {
  const paramFlags = Object.entries(key).map(([k, v]) => `--param_${k}=${v}`)
  const text = chQuery(`EXPLAIN indexes = 1 SELECT url FROM ulp.credentials WHERE ${clause} ORDER BY ${SORT_MAP[sort]} LIMIT 25`, paramFlags)
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.trim() === 'PrimaryKey')
  for (let i = at + 1; at >= 0 && i < lines.length; i++) {
    const m = /^\s*Granules:\s*(\d+)\/(\d+)\s*$/.exec(lines[i])
    if (m) return { selected: Number(m[1]), total: Number(m[2]) }
  }
  throw new Error(`no PrimaryKey granules in EXPLAIN:\n${text}`)
}

async function main(): Promise<number> {
  console.log(`run ${RUN}`)
  const ready = await waitFor(async () => (await fetch(`${BASE}/api/auth/check-users`)).status === 200, 20_000)
  if (!ready) { console.error('the rehearsal stack is not answering on 3101; start it with scripts/e2e-alert-rehearsal.ts --keep'); return 2 }
  await login()

  console.log('\n[1] seed')
  const total = seed()
  chQuery('OPTIMIZE TABLE ulp.credentials FINAL')
  await sleep(1500)
  info('rows in the walk table', chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${SRC}'`))
  info('active parts', chQuery(`SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active`))
  check('the walk table has the rows that were seeded', Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${SRC}'`)) === total)
  const ties = Number(chQuery(`SELECT count() FROM (SELECT domain, email, imported_at FROM ulp.credentials WHERE source_file = '${SRC}' GROUP BY domain, email, imported_at HAVING count() >= 10)`))
  check('the table has big tie groups on (domain, email, imported_at)', ties >= 20, String(ties))

  console.log(`\n[2] every sort, followed to the end in pages of ${PAGE}, is one ordered read: the same rows, in the same order, each once`)
  const sorts: Array<[SortKey, number]> = [
    ['domain_asc', PAGE], ['domain_desc', PAGE], ['imported_asc', PAGE], ['imported_desc', PAGE],
    ['email_asc', 40], ['email_desc', 40], ['pw_len_asc', 40], ['pw_len_desc', 40],
  ]
  for (const [sort, limit] of sorts) {
    const want = reference(sort)
    const got = await walk(sort, limit)
    const pagesWanted = Math.ceil(want.length / limit)
    check(`${sort}: ${want.length} rows over ${pagesWanted} pages, identical to one ordered read`, got.error === null && sameRows(got.rows, want), got.error ?? firstDifference(got.rows, want))
    check(`${sort}: the last page is the end (no cursor), and no page is missing`, got.error === null && got.pages === pagesWanted, `${got.pages} pages, wanted ${pagesWanted}`)
    if (sort === 'domain_asc' || sort === 'imported_desc') info(`${sort} answered by`, got.plans.join(', '))
  }

  console.log('\n[3] a cursor on any row hands over to the row after it (every tie, and the first and last row of every domain)')
  const want = reference('domain_asc')
  const picks = new Set<number>()
  for (let i = 0; i + 1 < want.length; i++) {
    const tie = want[i].domain === want[i + 1].domain && want[i].email === want[i + 1].email && want[i].imported_at === want[i + 1].imported_at
    const edge = want[i].domain !== want[i + 1].domain || (i > 0 && want[i].domain !== want[i - 1].domain)
    if ((tie && i % 3 === 0) || edge || i % 97 === 0) picks.add(i)
  }
  info('cursors tried', picks.size)
  let resumed = 0
  let firstBad = ''
  for (const i of picks) {
    const token = encodeCursor('domain_asc', want[i] as unknown as Record<string, unknown>)
    const r = await api(`/api/credentials?source_file=${SRC}&sort=domain_asc&limit=10&skip_totals=1&cursor=${encodeURIComponent(token)}`)
    const got = r.status === 200 && r.body?.success ? (r.body.results as Array<Record<string, unknown>>).map(shown) : []
    if (sameRows(got, want.slice(i + 1, i + 11))) resumed++
    else if (!firstBad) firstBad = `cursor on row ${i}: ${firstDifference(got, want.slice(i + 1, i + 11))}`
  }
  check(`all ${picks.size} cursors continue with exactly the next rows`, resumed === picks.size, firstBad)

  console.log('\n[4] the same pages through a search (a whole word of the url), whichever plan answers')
  const wordWalk = await walk('domain_asc', PAGE, `&q=${WORD}`)
  check(`a word search followed to the end equals the ordered read (${wordWalk.rows.length} rows)`, wordWalk.error === null && sameRows(wordWalk.rows, want), wordWalk.error ?? firstDifference(wordWalk.rows, want))
  info('answered by', wordWalk.plans.join(', '))

  console.log('\n[5] the page\'s own defaults (Declutter and Unique on) accept the cursor')
  const first = await api(`/api/credentials?source_file=${SRC}&sort=domain_asc&limit=25&exclude_noise=1&dedupe=1&skip_totals=1`)
  check('the first page of the default view has a cursor', first.status === 200 && !!first.body?.next_cursor, JSON.stringify(first.body).slice(0, 200))
  const second = await api(`/api/credentials?source_file=${SRC}&sort=domain_asc&limit=25&exclude_noise=1&dedupe=1&skip_totals=1&cursor=${encodeURIComponent(first.body?.next_cursor ?? '')}`)
  check('the second page answers with rows that come after the first page\'s', second.status === 200 && second.body?.results?.length > 0
    && JSON.stringify(shown(second.body.results[0])) !== JSON.stringify(shown(first.body.results[first.body.results.length - 1])), JSON.stringify(second.body).slice(0, 200))

  console.log('\n[6] the primary key prunes (1.4 million rows, 28 domains, about 22 granules)')
  chQuery(`INSERT INTO ulp.credentials (${COLS})
    SELECT concat('https://b.test/', toString(number)), concat('e', toString(number % 1000), '@b.test'), 'pw', concat('big', lpad(toString(intDiv(number, 50000)), 3, '0'), '.test'), '${BIG}', '', toDateTime('2026-09-02 00:00:00')
    FROM numbers(1400000)`)
  chQuery('OPTIMIZE TABLE ulp.credentials FINAL')
  await sleep(1500)
  const mid = JSON.parse(chQuery(`SELECT domain, email, toString(imported_at) AS imported_at, url, password FROM ulp.credentials WHERE source_file = '${BIG}' AND domain = 'big014.test' ORDER BY ${SORT_MAP.domain_asc} LIMIT 1 FORMAT JSONEachRow`)) as Record<string, string>
  const key = { c_d: mid.domain, c_e: mid.email, c_ia: mid.imported_at, c_u: mid.url, c_pw: mid.password }
  const built = buildCursorWhere('domain_asc', { sort: 'domain_asc', v: { ...mid } })
  const legacy = '(domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})'
  const now = primaryKeyGranules('domain_asc', key, built.clause)
  const before = primaryKeyGranules('domain_asc', key, legacy)
  info('domain_asc, a cursor in domain 14 of 28', `${now.selected} of ${now.total} granules (the tuple form: ${before.selected} of ${before.total})`)
  check('the table is big enough to show pruning', now.total >= 15, String(now.total))
  check('domain_asc: a mid-table cursor leaves out a good part of the table', now.selected <= now.total * 0.7, `${now.selected} of ${now.total}`)
  const builtDesc = buildCursorWhere('domain_desc', { sort: 'domain_desc', v: { ...mid } })
  const desc = primaryKeyGranules('domain_desc', key, builtDesc.clause)
  info('domain_desc, the same cursor', `${desc.selected} of ${desc.total} granules`)
  check('domain_desc: the same cursor leaves out the domains above it', desc.selected <= desc.total * 0.7, `${desc.selected} of ${desc.total}`)

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
