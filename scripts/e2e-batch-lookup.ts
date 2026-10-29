/**
 * Rehearsal of the batch lookups, of the single domain lookup GET /api/v1/lookup?domain= (docs/superpowers/specs/2026-10-26-batch-lookup-design.md) and of
 * the site counts POST /api/lookup/counts, POST /api/v1/lookup/counts (docs/superpowers/specs/2026-10-26-site-counts-design.md)
 * on the BUILT candidate image, against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares
 * nothing with the real stack).
 *
 * It starts a FRESH install on the candidate image (the production init SQL and the app's migrations build the table and its indexes), seeds one
 * address stored in four casings, domains stored bare, with a `www.` and with a `:port` (the shapes the older parser left), a non-ASCII address,
 * 100 addresses and 100 domains for a full batch, and 1.5M filler rows (one part, about 23 granules). Then it drives the real HTTP routes with a
 * real login (and a real API key for v1) using what people paste: URLs, `www.` hosts, `<addr>`, `mailto:`, `addr:password`, any casing, both kinds
 * in one request. It also checks, on the freshly built indexes, that the text index is the one the hint assumes, that the hint narrows 100
 * absent addresses where the bloom filter alone cannot, and that the primary key narrows `domain IN (host, www. form)` (EXPLAIN, granules).
 * The site counts are checked on a site seeded with rows on the host, on its www. spelling and on subdomains (one two labels deep, one under another
 * listed site), plus rows that must NOT count (a name that merely ends with the site's, a :port spelling) and rows imported years ago for the window:
 * the exact numbers, every pasted shape, both routes agreeing, 100 sites, EXPLAIN (the reversed-domain projection leaves a few granules), and last the
 * fallback: with the projection cleared the answer says only hosts were counted, and after MATERIALIZE it counts subdomains again.
 * The site marks (docs/superpowers/specs/2026-10-29-site-marks-design.md) are checked on the same site: POST and PUT /api/lookup/marks with a session, one
 * mark for every spelling of the site, the refusals, and that a mark and its note survive recreating only the app (its data volume is kept).
 *
 *   git archive <commit> | docker build -t ulp-suite-app:batch-candidate -
 *   npx tsx scripts/e2e-batch-lookup.ts            # about 4 minutes; --keep leaves the stack running (the session cookie goes to $COOKIE_FILE)
 *
 * Exit 0 when every check passes, 1 when one fails, 2 when the rehearsal cannot start.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { domainIn, planEmailBatch } from '@/lib/batch-lookup'
import { subdomainCountsSql } from '@/lib/site-counts'

const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || !BASE.endsWith(':3101')) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const CANDIDATE_IMAGE = process.env.CANDIDATE_IMAGE ?? 'ulp-suite-app:batch-candidate'
const COOKIE_FILE = process.env.COOKIE_FILE ?? ''
const keep = process.argv.includes('--keep')
const RUN = randomBytes(4).toString('hex')

const ADDR = `batch.case.${RUN}@example.test`
const ADDR_STORED = [ADDR, ADDR, `Batch.Case.${RUN}@Example.test`, `BATCH.CASE.${RUN}@EXAMPLE.TEST`, `bAtCh.cAsE.${RUN}@example.test`]
const PORTAL = `portal-${RUN}.example.test`
const LEGACY_WWW = `www.legacy-${RUN}.example.test`
const LEGACY_PORT = `portbox-${RUN}.example.test:8443`
const NON_ASCII = `müller.${RUN}@example.test`
// The site counts: rows per stored domain, so the expected numbers are plain sums. Seeded in step 2 (one part), plus OLD_SUB in step 7.
const COUNTS_SITE = `counts-${RUN}.example.test`
const COUNTS_ROWS: Array<[string, number]> = [
  [COUNTS_SITE, 5],                    // the site itself
  [`www.${COUNTS_SITE}`, 2],           // a www. spelling the older parser kept: the site's own rows
  [`login.${COUNTS_SITE}`, 7],
  [`app.${COUNTS_SITE}`, 3],
  [`a.b.${COUNTS_SITE}`, 2],           // two labels deep
  [`x.login.${COUNTS_SITE}`, 1],       // under login.<site>, so it counts for that site too
  [`${COUNTS_SITE}:8443`, 1],          // a :port the older parser kept: not counted (a parse fragment, 79 rows of 150,079 on the real table)
  [`not-${COUNTS_SITE}`, 4],           // ends with the site's name but is not under it
]
const OLD_SUB = `old.${COUNTS_SITE}`   // 3 rows imported in 2020: inside the all-time count, outside any recent window

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}
const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-6).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 2000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* not yet */ }
    await sleep(intervalMs)
  }
  console.log(`  ... gave up waiting for: ${label}`)
  return null
}

interface Hit { found: boolean; count: number; results: Array<{ email: string }>; searched_as?: string }
interface BatchJson { success?: boolean; found?: number; queried?: number; results?: Record<string, Hit>; error?: string }

async function main(): Promise<number> {
  try { sh('docker', ['image', 'inspect', CANDIDATE_IMAGE]) } catch { console.error(`The image ${CANDIDATE_IMAGE} is missing.`); return 2 }
  if (sh('docker', ['ps', '-aq', '--filter', 'name=ulprehearsal_']) !== '') {
    console.error(`A rehearsal stack already exists. Remove it first:  docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    return 2
  }
  const memAvailKb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0)
  if (memAvailKb < 6 * 1024 * 1024) {
    console.error(`Only ${(memAvailKb / 1048576).toFixed(1)} GiB of memory is available; the rehearsal needs about 6 GiB.`)
    return 2
  }

  const dockerCfg = mkdtempSync(join(tmpdir(), 'rehearsal-docker-'))
  writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore
  const secrets = {
    REHEARSAL_JWT_SECRET: randomBytes(32).toString('hex'),
    REHEARSAL_ADMIN_EMAIL: 'admin@rehearsal.test',
    REHEARSAL_ADMIN_PASSWORD: randomBytes(18).toString('base64url') + 'Aa1!',
    REHEARSAL_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  }
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: dockerCfg, REHEARSAL_APP_IMAGE: CANDIDATE_IMAGE, ...secrets }
  const compose = (args: string[]) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], env)
  // --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
  const chQuery = (sql: string, params: Record<string, string> = {}) =>
    sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', ...Object.entries(params).map(([k, v]) => `--param_${k}=${v}`), '--query', sql])
  const chOrEmpty = (sql: string) => { try { return chQuery(sql) } catch { return '' } }
  const appHealthy = () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy'

  let cookie = ''
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  const asSession = (method: string, path: string, body?: unknown) => call(method, path, body, cookie ? { cookie } : {})
  const batch = async (body: unknown) => {
    const t = Date.now()
    const res = await asSession('POST', '/api/lookup/batch', body)
    return { ...res, json: res.json as BatchJson, ms: Date.now() - t }
  }
  const login = async () => {
    const res = await call('POST', '/api/auth/login', { email: secrets.REHEARSAL_ADMIN_EMAIL, password: secrets.REHEARSAL_ADMIN_PASSWORD })
    const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
    const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
    if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
    cookie = `auth=${auth}`
  }
  /** Granules an index leaves for a WHERE, from EXPLAIN (text form): the first "Granules: a/b" after the line that names it ("Name: idx_..." or "PrimaryKey"). */
  const granules = (where: string, params: Record<string, string>, marker: string): { selected: number; initial: number } | null => {
    const lines = chQuery(`EXPLAIN indexes = 1 SELECT count() FROM ulp.credentials WHERE ${where} SETTINGS optimize_use_projections = 0`, params).split('\n')
    const at = lines.findIndex(l => l.includes(marker))
    const m = at < 0 ? null : /Granules:\s*(\d+)\/(\d+)/.exec(lines.slice(at).find(l => /Granules:/.test(l)) ?? '')
    return m ? { selected: Number(m[1]), initial: Number(m[2]) } : null
  }

  try {
    console.log(`1. A fresh install on the candidate image (${CANDIDATE_IMAGE})`)
    compose(['up', '-d'])
    const chUp = await waitFor('ClickHouse healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', CH]) === 'healthy', 240_000)
    const chStable = await waitFor('ClickHouse on its native port', async () => {
      for (let i = 0; i < 3; i++) { if (chOrEmpty('SELECT 1') !== '1') return false; await sleep(2000) }
      return true
    }, 180_000, 1000)
    check('ClickHouse started from the production init SQL', !!chUp && !!chStable)
    if (!chUp || !chStable) return 1
    sh('docker', ['restart', APP], env)
    const up = await waitFor('app healthy', appHealthy, 300_000)
    check('the candidate app started and ran its migrations', !!up)
    if (!up) return 1
    const text = chOrEmpty("SELECT type_full FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_inv_email'")
    check('the fresh table has the text index the hint assumes (splitByNonAlpha, preprocessor lower(email))', /splitByNonAlpha/.test(text) && /preprocessor\s*=\s*lower\(email\)/.test(text), text)
    const lc = chOrEmpty("SELECT expr FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'")
    check('and the lower(email) bloom filter', lc === 'lower(email)', lc)

    console.log('2. Seed: addresses and domains as the older parser left them, a site with subdomains, 100 + 100 for a full batch, 1.5M filler rows, as ONE insert = one part')
    const row = (url: string, email: string, password: string, domain: string, i: number) =>
      `SELECT '${url}' AS url, '${email}' AS email, '${password}' AS password, '${domain}' AS domain, 'seed-${RUN}' AS source_file, 'Breach-${RUN}-${i}' AS breach_name`
    const seeds = [
      ...ADDR_STORED.map((email, i) => row(`https://site${i}.example.test/login`, email, `pw-${i}`, `site${i}.example.test`, i)),
      ...[0, 1, 2].map(i => row(`https://${PORTAL}/login`, `user${i}.${RUN}@example.test`, `pw-p${i}`, PORTAL, i)),
      row(`https://${LEGACY_WWW}/`, `legacy.${RUN}@example.test`, 'pw-l', LEGACY_WWW, 0),
      row(`https://${LEGACY_PORT}/`, `port.${RUN}@example.test`, 'pw-q', LEGACY_PORT, 0),
      row('https://nonascii.example.test/', NON_ASCII, 'pw-n', 'nonascii.example.test', 0),
    ].join(' UNION ALL ')
    const countsSeed = COUNTS_ROWS.map(([domain, n]) =>
      `SELECT 'https://${domain}/x', concat('c', toString(number), '-${RUN}@example.test'), 'pw', '${domain}', 'seed-${RUN}', '' FROM numbers(${n})`).join(' UNION ALL ')
    const hundred = (pw: string) => `SELECT concat('https://bd', toString(number), '-${RUN}.example.test/'), concat('batch', toString(number), '-${RUN}@example.test'), '${pw}', concat('bd', toString(number), '-${RUN}.example.test'), 'seed-${RUN}', '' FROM numbers(100)`
    const filler = `SELECT concat('https://f', toString(number % 50), '.filler.test/'), concat('filler', toString(number), '-${RUN}@mail.test'), 'pw', concat('f', toString(number % 50), '.filler.test'), 'seed-filler-${RUN}', '' FROM numbers(1500000)`
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) ${seeds} UNION ALL ${countsSeed} UNION ALL ${hundred('pwA')} UNION ALL ${hundred('pwB')} UNION ALL ${filler} SETTINGS max_insert_threads = 1, max_insert_block_size = 5000000, min_insert_block_size_rows = 5000000, min_insert_block_size_bytes = 1000000000`)
    const partCount = chQuery("SELECT count() FROM system.parts WHERE database='ulp' AND table='credentials' AND active")
    check('the seed is one part', partCount === '1', `parts ${partCount}`)
    if (partCount !== '1') return 2

    await login()
    if (COOKIE_FILE) writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 })
    const anon = await call('POST', '/api/lookup/batch', { domains: [PORTAL] })
    check('the route needs a session (401 without one)', anon.status === 401, `status ${anon.status}`)

    console.log('3. The Batch Lookup route, with what people paste')
    const shapes: Array<[string, string]> = [
      ['a bare host', PORTAL],
      ['https://host/path?query#fragment', `https://${PORTAL}/login?next=/a/b#top`],
      ['http://WWW.HOST/ in capitals', `http://WWW.${PORTAL.toUpperCase()}/`],
      ['host:port', `${PORTAL}:8443`],
      ['https://user@host/path', `https://user@${PORTAL}/path`],
      ['padded and quoted', `  "${PORTAL}",  `],
    ]
    for (const [label, sent] of shapes) {
      const r = await batch({ domains: [sent] })
      const hit = r.json.results?.[sent]
      check(`domain, ${label}: found, the 3 rows of the host`, r.status === 200 && hit?.found === true && hit.count === 3, JSON.stringify(hit).slice(0, 160))
    }
    const urlHit = (await batch({ domains: [`https://www.${PORTAL}/x`] })).json.results?.[`https://www.${PORTAL}/x`]
    check('a result says what was searched (searched_as = the bare host)', urlHit?.searched_as === PORTAL, JSON.stringify(urlHit).slice(0, 160))
    const bare = (await batch({ domains: [PORTAL] })).json.results?.[PORTAL]
    check('a bare host answers in the shape it always had (no searched_as)', bare !== undefined && !('searched_as' in bare))
    const www = (await batch({ domains: [LEGACY_WWW] })).json.results?.[LEGACY_WWW]
    check('a host stored with its www. is found when typed with it', www?.found === true && www.count === 1, JSON.stringify(www).slice(0, 160))
    const port = (await batch({ domains: [LEGACY_PORT] })).json.results?.[LEGACY_PORT]
    check('a host stored with its :port (older parser) is still found when typed with it: no match the old comparison found is lost', port?.found === true && port.count === 1, JSON.stringify(port).slice(0, 160))

    const emailShapes: Array<[string, string]> = [
      ['the lower-case address', ADDR],
      ['UPPER-CASE', ADDR.toUpperCase()],
      ['Mixed case', `Batch.Case.${RUN}@Example.test`],
      ['padded with spaces', `   ${ADDR}   `],
      ['<address>', `<${ADDR}>`],
      ['Name <address>', `Some Name <${ADDR}>`],
      ['mailto:address', `mailto:${ADDR}`],
      ['address:password', `${ADDR}:Secret1!`],
    ]
    for (const [label, sent] of emailShapes) {
      const r = await batch({ emails: [sent] })
      const hit = r.json.results?.[sent]
      check(`address, ${label}: all 5 rows in 4 stored casings`, r.status === 200 && hit?.count === 5 && new Set(hit.results.map(x => x.email)).size === 4, JSON.stringify(hit).slice(0, 160))
    }
    const na = await batch({ emails: [NON_ASCII, `<${NON_ASCII}>`] })
    check('a non-ASCII address is found (its own query, no hint), also inside <...>', na.json.results?.[NON_ASCII]?.count === 1 && na.json.results?.[`<${NON_ASCII}>`]?.count === 1, JSON.stringify(na.json).slice(0, 200))
    const mixed = await batch({ emails: [`<${ADDR}>`, NON_ASCII], domains: [`https://www.${PORTAL}/x`] })
    check('one request with both kinds (and a non-ASCII address) answers all three', mixed.json.found === 3 && mixed.json.queried === 3, JSON.stringify(mixed.json).slice(0, 200))
    const none = await batch({ emails: [`nobody-${RUN}@example.test`], domains: [`https://nobody-${RUN}.example.test/`] })
    check('entries that are not stored are not found', none.json.found === 0 && none.json.queried === 2)

    console.log('4. A full batch of 100 addresses and of 100 domains')
    const addresses = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? `  <Batch${i}-${RUN}@EXAMPLE.test>  ` : `batch${i}-${RUN}@example.test`))
    const hosts = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? `https://www.bd${i}-${RUN}.example.test/login` : `bd${i}-${RUN}.example.test`))
    const a100 = await batch({ emails: addresses })
    check('100 addresses (a third of them padded, in <...> and capitals): all found, 2 rows each', a100.status === 200 && a100.json.found === 100 && addresses.every(x => a100.json.results?.[x]?.count === 2), `status ${a100.status}, found ${a100.json.found}`)
    info('100 addresses', `${a100.ms} ms`)
    check('and well inside the 30 s cap', a100.ms < 30_000)
    const d100 = await batch({ domains: hosts })
    // Each domain was seeded with two rows (the passwords pwA and pwB), like each address.
    check('100 domains (half of them URLs with www. and a path): all found, 2 rows each', d100.status === 200 && d100.json.found === 100 && hosts.every(x => d100.json.results?.[x]?.count === 2), `status ${d100.status}, found ${d100.json.found}`)
    info('100 domains', `${d100.ms} ms`)
    const over = await batch({ emails: Array.from({ length: 101 }, (_, i) => `x${i}@example.test`) })
    check('101 entries are refused with 422', over.status === 422, `status ${over.status}`)

    console.log('5. The index hint on the freshly built indexes (EXPLAIN, 100 addresses that are not stored)')
    const absent = Array.from({ length: 100 }, (_, i) => `zz-absent-${RUN}-${i}@no-such-host.invalid`)
    const plan = planEmailBatch(absent)
    const group = plan.groups[0]
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(group.params)) params[k] = Array.isArray(v) ? `[${v.map(w => `'${w}'`).join(',')}]` : v
    const withHint = granules(group.where, params, 'Name: idx_inv_email')
    const plainWhere = group.where.slice(0, group.where.indexOf(' AND indexHint('))
    const bloomOnly = granules(plainWhere, params, 'Name: idx_bf_email_lc')
    info('granules, text index with the hint', withHint ? `${withHint.selected} of ${withHint.initial}` : 'unknown')
    info('granules, bloom filter alone', bloomOnly ? `${bloomOnly.selected} of ${bloomOnly.initial}` : 'unknown')
    check('the table has enough granules to tell (at least 20)', !!withHint && withHint.initial >= 20, JSON.stringify(withHint))
    check('the bloom filter alone keeps at least 75% of the granules for 100 addresses', !!bloomOnly && bloomOnly.selected * 4 >= bloomOnly.initial * 3, JSON.stringify(bloomOnly))
    check('the hint leaves at most 25%', !!withHint && withHint.selected * 4 <= withHint.initial, JSON.stringify(withHint))
    // The domain lookups (batch and single) compare `domain IN (...)`, built by the same function as the routes use; the key's first column is `domain`.
    const keyed = domainIn([PORTAL, `www.${PORTAL}`])
    const byKey = granules(keyed.where, keyed.params, 'PrimaryKey')
    info('granules, primary key with domain IN (host, www. form)', byKey ? `${byKey.selected} of ${byKey.initial}` : 'unknown')
    check('the primary key narrows domain IN (host, www. form) to at most 4 granules of at least 20', !!byKey && byKey.initial >= 20 && byKey.selected <= 4, JSON.stringify(byKey))

    console.log('6. POST /api/v1/lookup/batch and GET /api/v1/lookup?domain= with a real API key, and the page')
    const created = await asSession('POST', '/api/v1/api-keys', { name: `rehearsal-${RUN}`, role: 'admin' })
    const key = created.json?.data?.apiKey as string | undefined
    check('an API key was created', created.status === 200 && !!key, `status ${created.status}`)
    const v1 = async (body: unknown, headers: Record<string, string>) => call('POST', '/api/v1/lookup/batch', body, headers)
    const noKey = await v1({ domains: [PORTAL] }, {})
    check('v1 refuses a request without a key', noKey.status === 401, `status ${noKey.status}`)
    const single = (domain: string, headers: Record<string, string>, query = '') =>
      call('GET', `/api/v1/lookup?domain=${encodeURIComponent(domain)}${query}`, undefined, headers)
    const noKeySingle = await single(PORTAL, {})
    check('GET /api/v1/lookup refuses a request without a key', noKeySingle.status === 401, `status ${noKeySingle.status}`)
    if (key) {
      const sentDomain = `https://www.${PORTAL.toUpperCase()}/login?x=1`
      const sentEmail = `mailto:${ADDR.toUpperCase()}`
      const r = await v1({ domains: [sentDomain], emails: [sentEmail, NON_ASCII] }, { 'x-api-key': key })
      const j = r.json as BatchJson
      check('v1: a URL, a mailto: address in capitals and a non-ASCII address are all found', r.status === 200 && j.found === 3, JSON.stringify(j).slice(0, 200))
      check('v1: the URL is the 3 rows of the host, the address its 5 rows in 4 casings', j.results?.[sentDomain]?.count === 3 && j.results?.[sentEmail]?.count === 5)
      const r100 = await v1({ emails: addresses }, { authorization: `Bearer ${key}` })
      check('v1: 100 addresses, all found (Bearer form of the key)', r100.status === 200 && (r100.json as BatchJson).found === 100, `status ${r100.status}`)

      // The single lookup cleans the domain the same way (design: the follow-up section of docs/superpowers/specs/2026-10-26-batch-lookup-design.md).
      const keyHeaders = { 'x-api-key': key }
      const s0 = await single(PORTAL, keyHeaders)
      check('GET /api/v1/lookup?domain=: a bare host answers in the shape it always had (found, the 3 rows, no searched_as)',
        s0.status === 200 && s0.json?.found === true && s0.json.count === 3 && !('searched_as' in s0.json)
          && JSON.stringify(Object.keys(s0.json)) === JSON.stringify(['success', 'found', 'domain', 'count', 'results']), JSON.stringify(s0.json).slice(0, 200))
      for (const [label, sent] of shapes) {
        const r = await single(sent, keyHeaders)
        check(`GET /api/v1/lookup?domain=, ${label}: found, the 3 rows of the host`, r.status === 200 && r.json?.found === true && r.json.count === 3, JSON.stringify(r.json).slice(0, 160))
      }
      const sUrl = await single(`https://www.${PORTAL.toUpperCase()}/login?x=1`, keyHeaders)
      check('GET /api/v1/lookup?domain=: the answer echoes what was sent (lower case) and says what was searched',
        sUrl.json?.domain === `https://www.${PORTAL}/login?x=1` && sUrl.json?.searched_as === PORTAL, JSON.stringify(sUrl.json).slice(0, 200))
      const sWww = await single(LEGACY_WWW, keyHeaders)
      check('GET /api/v1/lookup?domain=: a host stored with its www. is found when typed with it', sWww.json?.found === true && sWww.json.count === 1, JSON.stringify(sWww.json).slice(0, 160))
      const sPort = await single(LEGACY_PORT, keyHeaders)
      check('GET /api/v1/lookup?domain=: a host stored with its :port (older parser) is still found when typed with it: no match the exact comparison found is lost',
        sPort.json?.found === true && sPort.json.count === 1, JSON.stringify(sPort.json).slice(0, 160))
      const sNone = await single('https://', keyHeaders)
      check('GET /api/v1/lookup?domain=: text with no host in it is a 200, not found', sNone.status === 200 && sNone.json?.found === false && sNone.json.count === 0, JSON.stringify(sNone.json).slice(0, 160))
      const sBlank = await single('   ', keyHeaders)
      check('GET /api/v1/lookup?domain=: a blank domain is still a 400', sBlank.status === 400, `status ${sBlank.status}`)
      const sAfter = await single(`https://${PORTAL}/`, keyHeaders, '&imported_after=2000-01-01')
      const sBefore = await single(`https://${PORTAL}/`, keyHeaders, '&imported_before=2000-01-01')
      check('GET /api/v1/lookup?domain=: the imported window composes with the host list (the 3 rows after 2000, none before; the window is echoed)',
        sAfter.json?.count === 3 && sAfter.json.imported_after !== undefined && sBefore.json?.found === false && sBefore.json.imported_before !== undefined,
        `${JSON.stringify(sAfter.json).slice(0, 120)} | ${JSON.stringify(sBefore.json).slice(0, 120)}`)
    }
    const page = await asSession('GET', '/lookup')
    check('the Batch Lookup page of the candidate is the new one', page.status === 200 && /Emails, domains or URLs/.test(page.text), `status ${page.status}`)

    console.log('7. Site counts: POST /api/lookup/counts (session) and POST /api/v1/lookup/counts (API key)')
    // Three rows imported in 2020 under a subdomain of the site: the all-time count includes them, a recent window does not. A second part, after the checks that want one.
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name, imported_at)
      SELECT 'https://${OLD_SUB}/x', concat('o', toString(number), '-${RUN}@example.test'), 'pw', '${OLD_SUB}', 'seed-${RUN}', '', toDateTime('2020-01-01 00:00:00') FROM numbers(3)`)
    const counts = async (body: unknown) => {
      const t = Date.now()
      const res = await asSession('POST', '/api/lookup/counts', body)
      return { ...res, ms: Date.now() - t }
    }
    const anonCounts = await call('POST', '/api/lookup/counts', { domains: [COUNTS_SITE] })
    check('the counts route needs a session (401 without one)', anonCounts.status === 401, `status ${anonCounts.status}`)

    // Rows of the site: 5 on the host + 2 on its www. spelling; on subdomains 7 (login) + 3 (app) + 2 (a.b) + 1 (x.login) + 3 (old) = 16 in 5 subdomains.
    // The 4 rows of not-<site> and the 1 row stored as <site>:8443 are not the site's.
    const SITE_TOP = [
      { domain: `login.${COUNTS_SITE}`, count: 7 }, { domain: `app.${COUNTS_SITE}`, count: 3 }, { domain: OLD_SUB, count: 3 },
      { domain: `a.b.${COUNTS_SITE}`, count: 2 }, { domain: `x.login.${COUNTS_SITE}`, count: 1 },
    ]
    const site = await counts({ domains: [COUNTS_SITE] })
    const hit = site.json?.results?.[COUNTS_SITE]
    check('a site: 23 rows = 7 on the host (with its www. spelling) + 16 on 5 subdomains; the look-alike name and the :port spelling are not counted',
      site.status === 200 && hit?.count === 23 && hit.host_count === 7 && hit.subdomain_count === 16 && hit.subdomains === 5 && hit.found === true, JSON.stringify(hit).slice(0, 220))
    check('its biggest subdomains come in order (most rows first, ties by name)', JSON.stringify(hit?.top_subdomains) === JSON.stringify(SITE_TOP), JSON.stringify(hit?.top_subdomains).slice(0, 260))
    check('the answer says subdomains were counted and a bare host has no searched_as', site.json?.subdomains_counted === true && !('searched_as' in (hit ?? {})), JSON.stringify(site.json).slice(0, 120))

    const nested = (await counts({ domains: [`login.${COUNTS_SITE}`] })).json?.results?.[`login.${COUNTS_SITE}`]
    check('a subdomain listed as a site counts its own rows and what is under it: 7 + 1 = 8', nested?.count === 8 && nested.host_count === 7 && nested.subdomain_count === 1 && nested.subdomains === 1, JSON.stringify(nested).slice(0, 200))

    const countShapes: Array<[string, string]> = [
      ['https://www.host/path?query', `https://www.${COUNTS_SITE}/login?next=/a/b`],
      ['HTTP://WWW.HOST:8080/ in capitals', `HTTP://WWW.${COUNTS_SITE.toUpperCase()}:8080/`],
      ['host:port', `${COUNTS_SITE}:8443`],
      ['*.host wildcard', `*.${COUNTS_SITE}`],
      ['.host', `.${COUNTS_SITE}`],
      ['padded and quoted', `  "${COUNTS_SITE}",  `],
      ['host with a path', `${COUNTS_SITE}/en/some/page.html`],
    ]
    const shaped = await counts({ domains: countShapes.map(([, v]) => v) })
    for (const [label, sent] of countShapes) {
      const r = shaped.json?.results?.[sent]
      check(`site, ${label}: the same 23 rows`, r?.count === 23 && r.host === COUNTS_SITE && r.error === undefined, JSON.stringify(r).slice(0, 160))
    }
    check('a pasted URL says what was counted (searched_as = the bare host)', shaped.json?.results?.[countShapes[0][1]]?.searched_as === COUNTS_SITE)

    const odd = await counts({ domains: [`quiet-${RUN}.example.test`, 'localhost', 'https://', `not-${COUNTS_SITE}`] })
    check('a site with no row is found:false with zeros, not an error', odd.json?.results?.[`quiet-${RUN}.example.test`]?.count === 0 && odd.json.results[`quiet-${RUN}.example.test`].found === false)
    check('text that is not a site has the reason and null numbers, never a 0',
      odd.json?.results?.localhost?.error === 'not a site address' && odd.json.results.localhost.count === null && odd.json.results['https://']?.error === 'not a site address')
    check('the look-alike name is a site of its own: its 4 rows, none of the real site\'s', odd.json?.results?.[`not-${COUNTS_SITE}`]?.count === 4, JSON.stringify(odd.json?.results?.[`not-${COUNTS_SITE}`]).slice(0, 160))

    const recent = await counts({ domains: [COUNTS_SITE], imported_after: '2021-01-01' })
    const rr = recent.json?.results?.[COUNTS_SITE]
    check('a window after 2021 leaves the 20 recent rows (the 3 imported in 2020 drop out: 4 subdomains) and is echoed',
      rr?.count === 20 && rr.subdomain_count === 13 && rr.subdomains === 4 && recent.json.imported_after !== undefined, JSON.stringify(rr).slice(0, 200))
    const older = await counts({ domains: [COUNTS_SITE], imported_before: '2021-01-01' })
    check('a window before 2021 leaves only the 3 old rows', older.json?.results?.[COUNTS_SITE]?.count === 3 && older.json.results[COUNTS_SITE].host_count === 0, JSON.stringify(older.json?.results?.[COUNTS_SITE]).slice(0, 200))
    const future = await counts({ domains: [COUNTS_SITE], imported_after: '2100-01-01' })
    check('a window with no rows counts 0, not an error', future.status === 200 && future.json?.results?.[COUNTS_SITE]?.count === 0 && future.json.results[COUNTS_SITE].found === false, `status ${future.status}`)
    const badWindow = await counts({ domains: [COUNTS_SITE], imported_after: 'last tuesday' })
    check('a malformed window is a 400', badWindow.status === 400, `status ${badWindow.status}`)
    const farWindow = await counts({ domains: [COUNTS_SITE], imported_after: '2999-01-01' })
    check('a date beyond what a DateTime holds (2106) is a 400 naming the range, not a count', farWindow.status === 400 && /supported range/.test(farWindow.json?.error ?? ''), `status ${farWindow.status}`)

    const sites100 = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? `https://www.bd${i}-${RUN}.example.test/login` : `bd${i}-${RUN}.example.test`))
    const c100 = await counts({ domains: sites100 })
    check('100 sites (half of them URLs): all found, 2 rows each', c100.status === 200 && c100.json?.found === 100 && sites100.every(x => c100.json.results?.[x]?.count === 2), `status ${c100.status}, found ${c100.json?.found}`)
    info('100 sites', `${c100.ms} ms`)
    check('and well inside one request (45 s)', c100.ms < 45_000)
    const c101 = await counts({ domains: Array.from({ length: 101 }, (_, i) => `s${i}.example.test`) })
    check('101 sites are refused with 422', c101.status === 422, `status ${c101.status}`)
    check('an empty list is refused with 400', (await counts({ domains: [] })).status === 400)

    // The plan on the freshly built table: the reversed-domain projection serves it and leaves a few granules (the seed is about 23).
    const explainParams: Record<string, string> = {}
    const explained = subdomainCountsSql([COUNTS_SITE, `login.${COUNTS_SITE}`], { lower: null, upper: null })
    for (const [k, v] of Object.entries(explained.params)) explainParams[k] = String(v)
    const countsPlan = chQuery(`EXPLAIN indexes = 1 ${explained.sql}`, explainParams)
    const gr = [...countsPlan.matchAll(/Granules:\s*(\d+)\/(\d+)/g)].map(m => ({ selected: Number(m[1]), initial: Number(m[2]) }))
    const planned = gr[gr.length - 1]
    info('granules, subdomain counts for 2 sites', planned ? `${planned.selected} of ${planned.initial}` : 'unknown')
    check('the plan reads the reversed-domain projection', countsPlan.includes('proj_domain_rev'))
    check('and leaves at most 4 granules of at least 20', !!planned && planned.initial >= 20 && planned.selected <= 4, JSON.stringify(planned))

    if (key) {
      const v1c = (body: unknown, headers: Record<string, string>) => call('POST', '/api/v1/lookup/counts', body, headers)
      const noKeyCounts = await v1c({ domains: [COUNTS_SITE] }, {})
      check('v1 counts refuse a request without a key', noKeyCounts.status === 401, `status ${noKeyCounts.status}`)
      const body = { domains: [COUNTS_SITE, `https://www.login.${COUNTS_SITE}/x`, 'localhost', `quiet-${RUN}.example.test`] }
      const viaKey = await v1c(body, { 'x-api-key': key })
      const viaBearer = await v1c(body, { authorization: `Bearer ${key}` })
      const viaSession = await counts(body)
      check('v1 counts answer with a key (both header forms)', viaKey.status === 200 && viaBearer.status === 200 && viaKey.json?.found === 2, `status ${viaKey.status}`)
      check('and exactly what the page route answers for the same list', JSON.stringify(viaKey.json) === JSON.stringify(viaSession.json) && JSON.stringify(viaBearer.json) === JSON.stringify(viaSession.json))
      const v1Window = await v1c({ domains: [COUNTS_SITE], imported_after: '2021-01-01' }, { 'x-api-key': key })
      check('v1 counts take the window', v1Window.json?.results?.[COUNTS_SITE]?.count === 20)
    }
    const countsPage = await asSession('GET', '/counts')
    check('the Site Counts page is served', countsPage.status === 200 && /Sites or URLs \(one per line\)/.test(countsPage.text) && /Upload a list/.test(countsPage.text), `status ${countsPage.status}`)

    console.log('8. Site marks: POST and PUT /api/lookup/marks (session), kept when only the app container is recreated')
    const marks = {
      read: (hosts: string[]) => asSession('POST', '/api/lookup/marks', { hosts }),
      change: (body: unknown) => asSession('PUT', '/api/lookup/marks', body),
    }
    const anonRead = await call('POST', '/api/lookup/marks', { hosts: [COUNTS_SITE] })
    const anonChange = await call('PUT', '/api/lookup/marks', { host: COUNTS_SITE, status: 'done' })
    check('the marks route needs a session (401 without one, both verbs)', anonRead.status === 401 && anonChange.status === 401, `${anonRead.status} / ${anonChange.status}`)
    const unmarked = await marks.read([COUNTS_SITE])
    check('a site nobody marked has no mark', unmarked.status === 200 && unmarked.json?.success === true && Object.keys(unmarked.json.marks ?? {}).length === 0, JSON.stringify(unmarked.json).slice(0, 160))
    const setTodo = await marks.change({ host: COUNTS_SITE, status: 'todo' })
    check('PUT sets a status, and answers with what is stored and who set it',
      setTodo.status === 200 && setTodo.json?.mark?.status === 'todo' && setTodo.json.mark.note === null && setTodo.json.mark.updated_by === secrets.REHEARSAL_ADMIN_EMAIL, JSON.stringify(setTodo.json).slice(0, 220))
    // The page keeps a mark under the host the counts name, so the three spellings below must all be counted under one host and show the one mark.
    const spellings = [COUNTS_SITE, `https://www.${COUNTS_SITE}/login`, `*.${COUNTS_SITE}`]
    const spelled = await counts({ domains: spellings })
    const spelledHosts = spellings.map(s => spelled.json?.results?.[s]?.host as string)
    check('three spellings of the site are counted under one host', spelledHosts.every(h => h === COUNTS_SITE), JSON.stringify(spelledHosts))
    const shared = await marks.read(spelledHosts)
    check('and show the one mark', Object.keys(shared.json?.marks ?? {}).length === 1 && shared.json.marks[COUNTS_SITE]?.status === 'todo', JSON.stringify(shared.json).slice(0, 200))
    const noted = await marks.change({ host: COUNTS_SITE, note: '  looked at the login page  ' })
    check('a note is trimmed and the status stays', noted.json?.mark?.note === 'looked at the login page' && noted.json.mark.status === 'todo', JSON.stringify(noted.json).slice(0, 220))
    const refusals = await Promise.all([
      marks.change({ host: `https://www.${COUNTS_SITE}/login`, status: 'done' }), // a host as typed, not as the counts name it
      marks.change({ host: COUNTS_SITE, status: 'finished' }),
      marks.change({ host: COUNTS_SITE, note: 'x'.repeat(501) }),
      marks.change({ host: COUNTS_SITE }),
      marks.read([]),
    ])
    check('a host as typed, a status outside the list, a note over 500 characters, an empty change and an empty read are all refused (400)', refusals.every(r => r.status === 400), refusals.map(r => r.status).join(','))
    const unchanged = await marks.read([COUNTS_SITE])
    check('and none of them changed the mark', unchanged.json?.marks?.[COUNTS_SITE]?.status === 'todo' && unchanged.json.marks[COUNTS_SITE].note === 'looked at the login page', JSON.stringify(unchanged.json).slice(0, 220))

    // The data volume outlives the container: recreate only the app (as scripts/e2e-disk-gate.ts does) and read the mark back.
    compose(['up', '-d', '--no-deps', '--force-recreate', 'app'])
    const appBack = await waitFor('the recreated app healthy', appHealthy, 300_000)
    check('the app was recreated and came back healthy', !!appBack)
    if (appBack) {
      await login()
      const afterRecreate = await marks.read([COUNTS_SITE])
      const kept = afterRecreate.json?.marks?.[COUNTS_SITE]
      check('after the recreate the status and the note are still there', kept?.status === 'todo' && kept.note === 'looked at the login page', JSON.stringify(afterRecreate.json).slice(0, 220))
      const cleared = await marks.change({ host: COUNTS_SITE, status: null, note: null })
      const gone = await marks.read([COUNTS_SITE])
      check('clearing both removes the mark', cleared.status === 200 && cleared.json?.mark === null && Object.keys(gone.json?.marks ?? {}).length === 0, JSON.stringify(cleared.json).slice(0, 160))
    }

    // Last, because it changes the table: without the reversed-domain projection on every part only hosts can be counted, and the answer says so.
    chQuery('ALTER TABLE ulp.credentials CLEAR PROJECTION proj_domain_rev SETTINGS mutations_sync = 2')
    const cleared = chOrEmpty("SELECT count() FROM system.projection_parts WHERE database='ulp' AND table='credentials' AND name='proj_domain_rev' AND active")
    check('the projection is cleared on every part', cleared === '0', `projection parts ${cleared}`)
    const hostsOnly = await counts({ domains: [COUNTS_SITE] })
    const ho = hostsOnly.json?.results?.[COUNTS_SITE]
    check('without it only the host is counted (7 rows), the subdomain numbers are null, and the answer says so',
      hostsOnly.status === 200 && hostsOnly.json?.subdomains_counted === false && ho?.count === 7 && ho.host_count === 7 && ho.subdomain_count === null && ho.subdomains === null, JSON.stringify(ho).slice(0, 220))
    chQuery('ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_domain_rev SETTINGS mutations_sync = 2')
    const restored = await counts({ domains: [COUNTS_SITE] })
    check('after MATERIALIZE the subdomains are counted again (23 rows)', restored.json?.subdomains_counted === true && restored.json.results?.[COUNTS_SITE]?.count === 23, JSON.stringify(restored.json).slice(0, 200))
  } catch (err) {
    check('the rehearsal ran to the end', false, err instanceof Error ? err.message : String(err))
  } finally {
    if (keep) {
      console.log(`\nStack left running (--keep). App: ${BASE}. Remove it with:\n  REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    } else {
      try { compose(['down', '-v', '--remove-orphans']) } catch (err) { console.error('teardown failed:', err instanceof Error ? err.message : String(err)) }
    }
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
