/**
 * End-to-end scenarios for the hit-set plan (lib/search-hit-set.ts), against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own ClickHouse,
 * app and volumes; it shares nothing with the real stack). The app there runs the PRODUCTION image, so this proves what the built image does, through its HTTP
 * server, with a real login cookie and a real ClickHouse that has merges of its own.
 *
 *   docker compose build app                         # or: REHEARSAL_APP_IMAGE=<tag> for a candidate that has not moved :latest
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-hit-set.ts                   # about 1 minute
 *   REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x \
 *     docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v   # the compose file wants these set even to stop the stack
 *
 * Every text is unique per run (the run id is in it), so a re-run on the same stack does not pass vacuously. The texts have only EDGE words (`hsRUN:pwRUN`):
 * a word inside the text would let the substring plan answer, and this script is about the plan that answers when it cannot. Exit 0 when every check passes,
 * 1 when one fails, 2 when the stack is not ready.
 *
 * What it proves, in the order of the page's own use: the plan answers; the rows and the totals of one search cost ONE scan together with every chip, sort,
 * Unique and page after them; each of those answers is IDENTICAL to today's query (`hit_set=0`); a row imported after the set was built is found
 * (a new part changes the fingerprint); a merge that replaces the parts does not lose rows; a search with more hits than the cap, one with no hits and one
 * with a narrowing filter behave as designed; an abandoned request does not raise an error.
 * Not covered here: killing a long scan on abort. It needs a scan that lasts seconds, which this small table cannot give; __tests__/hit-set-parity.live.test.ts
 * proves it on the real table, and __tests__/clickhouse-kill-on-abort.test.ts pins the mechanism.
 */
import { execFileSync } from 'node:child_process'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const HOST = '127.0.0.1'
const PORT = 3101
const BASE = `http://${HOST}:${PORT}`
if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || PORT !== 3101) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const RUN = Date.now().toString(36)
// A "user:pass" shaped text: a special character in it, and only words at its two ends, so no word can prune it.
const TEXT = `hs${RUN}:pw${RUN}`
const BIG_TEXT = `hb${RUN}:pb${RUN}` // more hits than the cap
const NONE_TEXT = `hn${RUN}:pn${RUN}` // no hits
const CAP = 5000 // SEARCH_HIT_SET_MAX_HITS default (lib/search-hit-set.ts)

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
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}
// --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--max_query_size=10000000', '--query', sql])
const insert = (select: string) => chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) ${select}`)

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
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const query = (text: string, extra = '') => `/api/credentials?q=${encodeURIComponent(text)}&limit=10&exclude_noise=1${extra}`

/** How many position scans ClickHouse ran for a text (the app's own statements, read back from its query log). */
function scansFor(text: string): number {
  chQuery('SYSTEM FLUSH LOGS')
  // `NOT LIKE '%query_log%'`: this very statement carries both strings, and would count itself on the next call.
  return Number(chQuery(`SELECT count() FROM system.query_log WHERE type = 'QueryFinish' AND query NOT LIKE '%query_log%' AND position(query, '_part_offset AS off') > 0 AND position(query, '${text}') > 0`))
}

/** All pages of a search by following the cursor, the totals separately: what the page itself asks for. */
async function walk(text: string, extra: string, plain: boolean) {
  const flag = plain ? '&hit_set=0' : ''
  const pages: any[] = []
  let cursor = ''
  for (let i = 0; i < 20; i++) {
    const r = await api(query(text, `${extra}${flag}&skip_totals=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
    if (r.status !== 200 || !r.body?.success) return { error: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`, pages, totals: null }
    pages.push(r.body)
    if (!r.body.next_cursor) break
    cursor = r.body.next_cursor
  }
  const t = await api(query(text, `${extra}${flag}&totals_only=1`))
  return { error: null as string | null, pages, totals: t.body }
}

function seed(): void {
  const src = (name: string) => `'seedhs-${RUN}-${name}'`
  // the text in the URL, over five domains; the duplicates and the noise below ride on the first rows
  insert(`SELECT concat('https://site', toString(number % 5), '.test/?k=${TEXT}&n=', toString(number)), concat('u', toString(number), '@mail.test'), concat('Pw-', toString(number)), concat('site', toString(number % 5), '.test'), ${src('url')}, '' FROM numbers(30)`)
  // the text in the LOGIN (a username) and in the PASSWORD (with a phone-number login): the plan must find what the legacy test finds in any of the three columns
  insert(`SELECT 'https://other.test/', concat('x', toString(number), '-${TEXT}'), concat('Lg-', toString(number)), 'other.test', ${src('login')}, '' FROM numbers(8)`)
  insert(`SELECT 'https://other.test/', concat('+1555000', toString(number)), concat('pre-${TEXT}-', toString(number)), 'other.test', ${src('pw')}, '' FROM numbers(6)`)
  // Unique collapses these; Declutter hides the IP-host noise
  insert(`SELECT concat('https://site', toString(number % 5), '.test/?k=${TEXT}&n=', toString(number)), concat('u', toString(number), '@mail.test'), concat('Pw-', toString(number)), concat('site', toString(number % 5), '.test'), ${src('dup')}, '' FROM numbers(5)`)
  insert(`SELECT concat('http://192.0.2.7/?k=${TEXT}&n=', toString(number)), concat('n', toString(number), '@mail.test'), concat('Nz-', toString(number)), '192.0.2.7', ${src('noise')}, '' FROM numbers(4)`)
  // the same text in capitals: LIKE is case-sensitive, so these do NOT match and must not appear
  insert(`SELECT concat('https://site', toString(number % 5), '.test/?k=${TEXT.toUpperCase()}'), concat('c', toString(number), '@mail.test'), 'Cc', concat('site', toString(number % 5), '.test'), ${src('caps')}, '' FROM numbers(6)`)
  insert(`SELECT 'https://unrelated.test/', concat('r', toString(number), '@mail.test'), concat('Un-', toString(number)), 'unrelated.test', ${src('control')}, '' FROM numbers(300)`)
  // more hits than the cap
  insert(`SELECT concat('https://big', toString(number % 50), '.test/?k=${BIG_TEXT}&n=', toString(number)), concat('b', toString(number), '@mail.test'), 'pw', concat('big', toString(number % 50), '.test'), ${src('big')}, '' FROM numbers(${CAP + 100})`)
}

async function main(): Promise<number> {
  console.log(`run ${RUN}: text ${TEXT}`)
  const ready = await waitFor(async () => (await fetch(`${BASE}/api/auth/check-users`)).status === 200, 20_000)
  if (!ready) { console.error('the rehearsal stack is not answering on 3101; start it with scripts/e2e-alert-rehearsal.ts --keep'); return 2 }
  await login()

  console.log('\n[1] seed')
  seed()
  // One part per partition, so that nothing merges behind the script's back (a merge changes the table's parts, which is the point of [4], not of [2]).
  chQuery('OPTIMIZE TABLE ulp.credentials FINAL')
  await sleep(2000)
  info('rows that match the text (legacy test, straight from ClickHouse)', chQuery(`SELECT count() FROM ulp.credentials WHERE url LIKE '%${TEXT}%' OR email LIKE '%${TEXT}%' OR password LIKE '%${TEXT}%'`))
  info('active parts', chQuery(`SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active`))

  console.log('\n[2] one scan answers the page\'s pair and every click after it, and each answer is today\'s answer')
  const pair = await Promise.all([api(query(TEXT, '&skip_totals=1')), api(query(TEXT, '&totals_only=1'))])
  check('the rows request is answered by the hit-set plan', pair[0].status === 200 && pair[0].body?.plan === 'hits', JSON.stringify(pair[0].body).slice(0, 160))
  check('the totals request is answered by the hit-set plan', pair[1].status === 200 && pair[1].body?.plan === 'hits', JSON.stringify(pair[1].body).slice(0, 160))
  check('the pair made ONE scan', scansFor(TEXT) === 1, String(scansFor(TEXT)))

  let compared = 0
  let different = 0
  const planSeen = new Set<string>()
  for (const sort of ['domain_asc', 'email_asc', 'pw_len_desc', 'imported_desc']) {
    for (const dedupe of [1, 0]) {
      for (const chip of ['', 'email', 'username', 'phone']) {
        const extra = `&sort=${sort}&dedupe=${dedupe}${chip ? `&login_type=${chip}` : ''}`
        const plain = await walk(TEXT, extra, true)
        const planned = await walk(TEXT, extra, false)
        const label = `${sort}, Unique ${dedupe}, ${chip || 'no chip'}`
        if (plain.error || planned.error) { check(label, false, plain.error ?? planned.error ?? ''); different++; continue }
        for (const p of planned.pages) planSeen.add(String(p.plan))
        const same = plain.pages.length === planned.pages.length
          && plain.pages.every((p, i) => JSON.stringify(p.results) === JSON.stringify(planned.pages[i].results) && p.next_cursor === planned.pages[i].next_cursor)
          && plain.totals.total === planned.totals.total && plain.totals.raw_total === planned.totals.raw_total
        compared++
        if (!same) { different++; check(`${label}: identical to today's query`, false, `plain ${plain.totals.total}/${plain.totals.raw_total}, plan ${planned.totals.total}/${planned.totals.raw_total}, ${plain.pages.length} vs ${planned.pages.length} pages`) }
      }
    }
  }
  check(`${compared} combinations of sort, Unique and chip, every page and both totals: identical to today's query`, compared === 32 && different === 0, `${different} different of ${compared}`)
  check('they were answered by the hit-set plan (Newest first may be answered by its time windows)', [...planSeen].every(p => p === 'hits' || p === 'windows') && planSeen.has('hits'), [...planSeen].join(','))
  check('and all of them cost no further scan', scansFor(TEXT) === 1, String(scansFor(TEXT)))
  const matching = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE url LIKE '%${TEXT}%' OR email LIKE '%${TEXT}%' OR password LIKE '%${TEXT}%'`))
  const raw = (await api(query(TEXT, '&totals_only=1&exclude_noise=0'))).body
  check('the totals count what ClickHouse counts (the text in the URL, the login and the password; the capital-letter lookalikes do not match)', raw?.raw_total === matching, `${raw?.raw_total} against ${matching}`)

  console.log('\n[3] a row imported after the set was built is found')
  insert(`SELECT 'https://site1.test/?k=${TEXT}&late=1', 'late1@mail.test', 'LatePw-1', 'site1.test', 'seedhs-${RUN}-late', '' FROM numbers(1)`)
  insert(`SELECT 'https://site2.test/?k=${TEXT}&late=2', 'late2@mail.test', 'LatePw-2', 'site2.test', 'seedhs-${RUN}-late', '' FROM numbers(1)`)
  const afterImport = await walk(TEXT, '&sort=domain_asc&dedupe=0', false)
  const plainAfterImport = await walk(TEXT, '&sort=domain_asc&dedupe=0', true)
  const lateRows = afterImport.pages.flatMap(p => p.results).filter((r: any) => String(r.url).includes('late='))
  check('both new rows are in the answer', lateRows.length === 2, `${lateRows.length}`)
  check('and the answer is identical to today\'s, totals included', JSON.stringify(afterImport.pages.map(p => p.results)) === JSON.stringify(plainAfterImport.pages.map(p => p.results))
    && afterImport.totals.raw_total === plainAfterImport.totals.raw_total, `${afterImport.totals?.raw_total} against ${plainAfterImport.totals?.raw_total}`)
  // Two scans; a third only if ClickHouse merged the two small new parts behind the script's back, which the fingerprint is there to notice.
  check('a second scan was made for the new parts', [2, 3].includes(scansFor(TEXT)), String(scansFor(TEXT)))

  console.log('\n[4] a merge replaces the parts: nothing is lost')
  chQuery('OPTIMIZE TABLE ulp.credentials FINAL')
  await sleep(2000)
  const afterMerge = await walk(TEXT, '&sort=email_asc&dedupe=1&login_type=email', false)
  const plainAfterMerge = await walk(TEXT, '&sort=email_asc&dedupe=1&login_type=email', true)
  check('the answer after the merge is identical to today\'s', afterMerge.error === null && JSON.stringify(afterMerge.pages.map(p => p.results)) === JSON.stringify(plainAfterMerge.pages.map(p => p.results))
    && afterMerge.totals.total === plainAfterMerge.totals.total, afterMerge.error ?? '')
  check('the merged parts were scanned again', scansFor(TEXT) >= 3 && scansFor(TEXT) <= 5, String(scansFor(TEXT)))

  console.log('\n[5] more hits than the cap, no hits, a narrowing filter')
  const big1 = await api(query(BIG_TEXT, '&skip_totals=1'))
  check(`more than ${CAP} hits: today's query answers`, big1.status === 200 && big1.body?.plan === 'plain' && big1.body?.results?.length === 10, JSON.stringify(big1.body).slice(0, 160))
  const big2 = await api(query(BIG_TEXT, '&skip_totals=1&login_type=email'))
  check('and the next click does not scan again (the verdict is remembered)', big2.body?.plan === 'plain' && scansFor(BIG_TEXT) === 1, `${big2.body?.plan}, ${scansFor(BIG_TEXT)} scans`)
  const none = await Promise.all([api(query(NONE_TEXT, '&skip_totals=1')), api(query(NONE_TEXT, '&totals_only=1'))])
  check('a text with no hits: an empty page and zero totals from the plan', none[0].body?.plan === 'hits' && none[0].body?.results?.length === 0 && none[1].body?.plan === 'hits' && none[1].body?.total === 0 && none[1].body?.raw_total === 0,
    JSON.stringify([none[0].body, none[1].body]).slice(0, 200))
  const before = scansFor(TEXT)
  const narrowed = await api(query(TEXT, '&skip_totals=1&domain=site1.test'))
  const narrowedPlain = await api(query(TEXT, '&skip_totals=1&domain=site1.test&hit_set=0'))
  check('a domain filter keeps today\'s query: no scan, the same rows', narrowed.body?.plan === 'plain' && scansFor(TEXT) === before && JSON.stringify(narrowed.body.results) === JSON.stringify(narrowedPlain.body.results), String(narrowed.body?.plan))
  const forced = await api(query(TEXT, '&skip_totals=1&hit_set=0'))
  check('hit_set=0 forces today\'s query', forced.body?.plan === 'plain')

  console.log('\n[6] an abandoned request ends quietly')
  const logsBefore = sh('docker', ['logs', APP]).split('\n').filter(l => l.includes('Credentials browse error')).length
  for (let i = 0; i < 5; i++) {
    const c = new AbortController()
    const p = fetch(`${BASE}${query(TEXT, `&skip_totals=1&sort=email_desc&dedupe=${i % 2}`)}`, { headers: { cookie }, signal: c.signal }).catch(() => null)
    await sleep(1 + i)
    c.abort()
    await p
  }
  await sleep(1500)
  const logsAfter = sh('docker', ['logs', APP]).split('\n').filter(l => l.includes('Credentials browse error')).length
  check('five requests aborted at once: no "Credentials browse error" in the app log', logsAfter === logsBefore, `${logsAfter - logsBefore} new`)
  const alive = await api(query(TEXT, '&skip_totals=1'))
  check('and the app keeps answering', alive.status === 200 && alive.body?.success === true)

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length ? 1 : 0
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1) })
