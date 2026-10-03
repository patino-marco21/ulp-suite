/**
 * End-to-end scenarios for the domain search dictionary, against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own ClickHouse,
 * app and volumes; it shares nothing with the real stack). The app there runs the PRODUCTION image with its rebuild cron turned up to a tick a
 * minute, so the dictionary is built, found stale, and rebuilt by the app itself while this script watches.
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep      # brings the stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-search-dictionary.ts           # about 8 minutes
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Every term is unique per run (the run id is in the name), so a re-run on the same stack does not pass vacuously. Exit 0 when every check passes,
 * 1 when one fails, 2 when the stack is not ready.
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
const TERM = `probe-wallet-${RUN}.test`
const CAP_TERM = `cap-probe-${RUN}.test`
const FIT_TERM = `fit-probe-${RUN}.test`
const BYTES_TERM = `bytes-probe-${RUN}.test`

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

async function api(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const search = (term: string, extra = '') => api(`/api/credentials?q=${encodeURIComponent(term)}&limit=200&exclude_noise=1${extra}`)
const dictState = async (): Promise<any | null> => (await api('/api/monitoring/ingest-health')).body?.searchDictionary ?? null
const waitFresh = (timeoutMs = 300_000) => waitFor(async () => { const d = await dictState(); return d?.state === 'fresh' ? d : null }, timeoutMs, 3000)

/** Every page of a search by following the cursor; the dictionary plan or (legacy) today's query. */
async function walk(term: string, sort: string, dedupe: number, legacy: boolean) {
  const pages: any[] = []
  let cursor = ''
  for (let i = 0; i < 12; i++) {
    const r = await search(term, `&sort=${sort}&dedupe=${dedupe}&skip_totals=1${legacy ? '&dictionary=0' : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (r.status !== 200 || !r.body?.success) return { error: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`, pages }
    pages.push(r.body)
    if (!r.body.next_cursor) break
    cursor = r.body.next_cursor
  }
  return { error: null as string | null, pages }
}

function seed(): void {
  const src = (name: string) => `'seed-${RUN}-${name}'`
  // the site, its subdomain, two lookalike hosts, a scheme-less URL with the term in its path
  insert(`SELECT 'https://${TERM}/login', concat('user', toString(number), '@mail-', toString(number % 7), '.test'), concat('Pw-', toString(number), '-Aa1!'), '${TERM}', ${src('site')}, '' FROM numbers(450)`)
  insert(`SELECT 'https://app.${TERM}/signin', concat('app', toString(number), '@mail.test'), concat('Ap-', toString(number)), 'app.${TERM}', ${src('sub')}, '' FROM numbers(30)`)
  insert(`SELECT 'https://${TERM}.phish.test/login', concat('ph', toString(number), '@mail.test'), concat('Ph-', toString(number)), 'phish.test', ${src('look')}, '' FROM numbers(20)`)
  insert(`SELECT 'https://secure-${TERM}-login.test/', concat('sl', toString(number), '@mail.test'), concat('Sl-', toString(number)), 'login-host.test', ${src('look')}, '' FROM numbers(20)`)
  insert(`SELECT 'login.example.test/${TERM}/signin', concat('pt', toString(number), '@mail.test'), concat('Pt-', toString(number)), 'login.example.test', ${src('path')}, '' FROM numbers(10)`)
  // rows only the email-domain branch can reach: an unrelated site, a blank domain, and a NON-ASCII email domain (reverse() is bytewise)
  insert(`SELECT 'https://other-site.test/', concat('x', toString(number), '@${TERM}'), concat('Xe-', toString(number)), 'other-site.test', ${src('email')}, '' FROM numbers(25)`)
  insert(`SELECT '', concat('y', toString(number), '@${TERM}'), concat('Ye-', toString(number)), '', ${src('blank')}, '' FROM numbers(5)`)
  insert(`SELECT 'https://other-site.test/', concat('z', toString(number), '@${TERM}.пример'), concat('Ze-', toString(number)), 'other-site.test', ${src('nonascii')}, '' FROM numbers(5)`)
  // duplicates of the first site rows (Unique collapses them), noise (Declutter hides it), and unrelated rows
  insert(`SELECT 'https://${TERM}/login', concat('user', toString(number), '@mail-', toString(number % 7), '.test'), concat('Pw-', toString(number), '-Aa1!'), '${TERM}', ${src('dup')}, '' FROM numbers(10)`)
  insert(`SELECT 'http://192.0.2.7/${TERM}/admin.php', concat('n', toString(number), '@mail.test'), concat('Nz-', toString(number)), '192.0.2.7', ${src('noise')}, '' FROM numbers(10)`)
  insert(`SELECT 'https://unrelated.test/', concat('u', toString(number), '@mail.test'), concat('Un-', toString(number)), 'unrelated.test', ${src('control')}, '' FROM numbers(200)`)
  // the caps: 3,200 candidate domains (over the 3,000 count cap), 2,000 that fit (a ~76 KB literal), 2,000 long ones (over the 90,000 byte cap)
  insert(`SELECT concat('https://cd', toString(number), '.${CAP_TERM}/login'), concat('c', toString(number), '@mail.test'), 'pw', concat('cd', toString(number), '.${CAP_TERM}'), ${src('cap')}, '' FROM numbers(3200)`)
  insert(`SELECT concat('https://fit', toString(number), '-pad.${FIT_TERM}/'), concat('f', toString(number), '@mail.test'), 'pw', concat('fit', toString(number), '-pad.${FIT_TERM}'), ${src('fit')}, '' FROM numbers(2000)`)
  insert(`SELECT concat('https://b', toString(number), '-', repeat('x', 50), '.${BYTES_TERM}/'), concat('b', toString(number), '@mail.test'), 'pw', concat('b', toString(number), '-', repeat('x', 50), '.${BYTES_TERM}'), ${src('bytes')}, '' FROM numbers(2000)`)
}

async function main(): Promise<number> {
  console.log(`run ${RUN}: term ${TERM}`)
  const ready = await waitFor(async () => (await fetch(`${BASE}/api/auth/check-users`)).status === 200, 20_000)
  if (!ready) { console.error('the rehearsal stack is not answering on 3101; start it with scripts/e2e-alert-rehearsal.ts --keep'); return 2 }
  await login()

  console.log('\n[1] seed, and the app builds the dictionary by itself')
  seed()
  info('rows seeded for the main term', chQuery(`SELECT count() FROM ulp.credentials WHERE source_file LIKE 'seed-${RUN}-%' AND (url_host LIKE '%${TERM}%' OR email_domain LIKE '%${TERM}%')`))
  const first = await waitFresh()
  check('the cron built the dictionary on a fresh install', !!first, JSON.stringify(await dictState()))
  if (!first) return 1
  info('dictionary', `${first.pairRows} host pairs, ${first.emailRows} email domains, ${first.bytes} bytes, built ${first.builtAt}`)
  check('Ingest Health reports its size', first.pairRows > 0 && first.emailRows > 0 && first.bytes > 0)

  console.log('\n[2] the dictionary plan returns exactly what the plain query returns')
  for (const sort of ['domain_asc', 'email_asc', 'pw_len_desc', 'imported_desc']) {
    for (const dedupe of [1, 0]) {
      const plain = await walk(TERM, sort, dedupe, true)
      const planned = await walk(TERM, sort, dedupe, false)
      const label = `${sort}, Unique ${dedupe}: ${plain.pages.length} pages`
      if (plain.error || planned.error) { check(label, false, plain.error ?? planned.error ?? ''); continue }
      const same = plain.pages.length === planned.pages.length
        && plain.pages.every((p, i) => JSON.stringify(p.results) === JSON.stringify(planned.pages[i].results) && p.next_cursor === planned.pages[i].next_cursor)
      check(`${label}, rows and cursors identical`, same)
      const expected = sort === 'imported_desc' ? ['dictionary', 'windows'] : ['dictionary']
      check(`${sort}, Unique ${dedupe}: answered by the ${expected.join(' or ')} plan`, expected.includes(planned.pages[0].plan), String(planned.pages[0].plan))
    }
  }
  const t1 = await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1`)
  const t0 = await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1&dictionary=0`)
  check('the totals equal the plain query\'s, both numbers', t1.body?.total === t0.body?.total && t1.body?.raw_total === t0.body?.raw_total, `${JSON.stringify(t1.body)} vs ${JSON.stringify(t0.body)}`)
  check('the totals came from the dictionary plan', t1.body?.plan === 'dictionary' && t0.body?.plan === 'plain')

  console.log('\n[3] rows only the email-domain branch or a path-text host can reach are found')
  const every = (await walk(TERM, 'email_asc', 0, false)).pages.flatMap(p => p.results as any[])
  check('a row with a non-ASCII email domain (reverse() is bytewise)', every.some(r => String(r.email).endsWith('.пример')))
  check('a row whose domain is blank', every.some(r => String(r.email).startsWith('y') && String(r.email).endsWith(`@${TERM}`)))
  check('a row on an unrelated site whose EMAIL domain is the term', every.some(r => r.domain === 'other-site.test'))
  check('a scheme-less URL with the term in its path', every.some(r => r.domain === 'login.example.test'))
  check('a lookalike host', every.some(r => r.domain === 'phish.test'))

  console.log('\n[4] the caps')
  const over = await walk(CAP_TERM, 'domain_asc', 1, false)
  check('3,200 candidate domains (over the 3,000 cap): today\'s query answers', over.pages[0]?.plan === 'plain', String(over.pages[0]?.plan))
  check('...and its rows are right', JSON.stringify(over.pages[0]?.results) === JSON.stringify((await walk(CAP_TERM, 'domain_asc', 1, true)).pages[0]?.results))
  const fit = await walk(FIT_TERM, 'domain_asc', 1, false)
  check('2,000 candidate domains in a ~76 KB inlined list: ClickHouse accepts it and the dictionary answers', fit.pages[0]?.plan === 'dictionary', fit.error ?? String(fit.pages[0]?.plan))
  check('...and its rows are identical to the plain query\'s', JSON.stringify(fit.pages[0]?.results) === JSON.stringify((await walk(FIT_TERM, 'domain_asc', 1, true)).pages[0]?.results))
  const bytes = await walk(BYTES_TERM, 'domain_asc', 1, false)
  check('2,000 long domains (over the 90,000-byte list cap): today\'s query answers', bytes.pages[0]?.plan === 'plain', String(bytes.pages[0]?.plan))

  console.log('\n[5] new data: the plan steps aside until the app has rebuilt, and no row is missed')
  const lateHost = `late.${TERM}`
  insert(`SELECT 'https://${lateHost}/', 'late-row@mail.test', 'Lt-1', '${lateHost}', 'seed-${RUN}-late', '' FROM numbers(1)`)
  const sawStale = await waitFor(async () => { const d = await dictState(); return d && d.state !== 'fresh' ? d : null }, 30_000, 500)
  check('an inserted row with a NEW domain makes the dictionary stale', !!sawStale, JSON.stringify(await dictState()))
  // The credentials route caches its freshness verdict for 3 s; a search inside that window could still use the old candidates (accepted: it needs
  // a single insert followed within 3 s by a search for a term whose new row has a new domain). Wait it out so this check is deterministic.
  await sleep(3500)
  const staleAnswer = await search(TERM, '&sort=domain_asc&dedupe=1&skip_totals=1')
  check('while stale the search is answered by today\'s query', staleAnswer.body?.plan === 'plain', String(staleAnswer.body?.plan))
  check('...and the new row is in it (a stale dictionary would have missed it)', (staleAnswer.body?.results ?? []).some((r: any) => r.domain === lateHost))
  const rebuilt = await waitFresh()
  check('the app rebuilt the dictionary by itself', !!rebuilt, JSON.stringify(await dictState()))
  const afterBuild = await walk(TERM, 'domain_asc', 1, false)
  check('then the dictionary answers again, with the new row in it', afterBuild.pages[0]?.plan === 'dictionary' && afterBuild.pages[0].results.some((r: any) => r.domain === lateHost))

  console.log('\n[6] a dictionary table dropped under a cached "fresh"')
  chQuery('DROP TABLE ulp.search_host_dict SYNC')
  const immediate = await search(TERM, '&sort=email_asc&dedupe=1&skip_totals=1')
  const reference = await search(TERM, '&sort=email_asc&dedupe=1&skip_totals=1&dictionary=0')
  // Right after the drop the answer may come from a candidate list the app already holds (still correct) or from the plain query (the lookup failed,
  // or the status already says missing), so only the ROWS are checked here; the plan is checked once the status has caught up.
  check('the answer is still right', immediate.status === 200 && JSON.stringify(immediate.body?.results) === JSON.stringify(reference.body?.results))
  const sawMissing = await waitFor(async () => { const d = await dictState(); return d?.state === 'missing' ? d : null }, 30_000, 500)
  check('the status reports the dropped table as missing', !!sawMissing, JSON.stringify(await dictState()))
  await sleep(3500)
  const whileMissing = await search(TERM, '&sort=email_asc&dedupe=1&skip_totals=1')
  check('while a table is missing the plain query answers, with the same rows', whileMissing.body?.plan === 'plain' && JSON.stringify(whileMissing.body?.results) === JSON.stringify(reference.body?.results), String(whileMissing.body?.plan))
  check('the app rebuilt the missing table', !!(await waitFresh()), JSON.stringify(await dictState()))

  console.log('\n[7] queries while the dictionary goes stale, rebuilds and is swapped in')
  const swapHost = `swap.${TERM}`
  insert(`SELECT 'https://${swapHost}/', 'swap-row@mail.test', 'Sw-1', '${swapHost}', 'seed-${RUN}-swap', '' FROM numbers(1)`)
  const expected = (await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1&dictionary=0`)).body
  await waitFor(async () => { const d = await dictState(); return d && d.state !== 'fresh' ? d : null }, 30_000, 500)
  await sleep(3500) // past the 3 s freshness cache, as in [5]
  const plans = new Set<string>()
  let requests = 0
  let wrong = 0
  const end = Date.now() + 240_000
  while (Date.now() < end) {
    const t = await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1`)
    requests++
    if (t.status !== 200 || !t.body?.success || t.body.total !== expected.total || t.body.raw_total !== expected.raw_total) wrong++
    plans.add(String(t.body?.plan))
    if (plans.has('plain') && plans.has('dictionary') && (await dictState())?.state === 'fresh') break
    await sleep(250)
  }
  check(`${requests} totals requests across the stale, rebuild and swap: every one succeeded with the right numbers`, wrong === 0 && requests > 10, `${wrong} wrong of ${requests}`)
  check('both plans answered during the run', plans.has('plain') && plans.has('dictionary'), [...plans].join(','))

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length ? 1 : 0
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1) })
