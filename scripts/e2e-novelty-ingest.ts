/**
 * End-to-end check of novelty-aware ingest on the production image, against the ISOLATED rehearsal stack
 * (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * The unit tests use fakes. This uses real uploads, a real ClickHouse and a real process kill. Scenarios (keys for --only=):
 *   basic       a new file; the same content under a new name (0 new, the name remembered, a second upload of it skipped); a
 *               half-overlap file; a file with repeated lines; a ZIP with a new and a known entry; a file dropped in the inbox
 *   tags        Telegram channel tags on credential lines (space-separated, glued on, with an advert): the tag is cut off, a banner line
 *               and a watermark line are skipped, and a banner that starts with http does not swallow the lines after it
 *   positional  a credential line the field split rejects does not take the two lines after it for a login and a password (no merged
 *               row, nothing lost), a genuine label-free URL / login / password record still imports, and "https://e-mail:password"
 *               (a stray scheme, no url) is kept as an e-mail:password pair, and "login:password:https://url" (the url last) is read
 *               in that order, "http://url login:password" (one space) is read as url, login, password, a ";jsessionid=..." path
 *               parameter stays in the url, and "e-mail:password | note" keeps the pair
 *   v6          parser v6: space-padded colons, an Android app id without its scheme (one row per login+password), a slash in the password (e-mail and
 *               other login), a numeric login, a protocol-relative url, UTF-8 text stored as typed, login == password (stored unless it is an e-mail),
 *               and a T3 line of a kept country (Poland, stored) next to one of another country (Brazil, dropped)
 *   pipes       parser v6.1: a pipe that joins a url, only its scheme or a label and a credential ("https://| host:login:pass", "Network:| ...", "url|login:pass"),
 *               a ';' in the password of a colon-separated line, a ";name=value" path parameter in a url without a scheme, and the layouts that must not move
 *   monitor     a monitor alerts for rows that are new to the database, not for a row the database already held
 *   big         2.5M distinct lines + 100k repeats of early lines (past the old 2M in-file cap): exact, in 5 slabs, phases visible
 *   kill        the app is killed in the middle of the commit; after the restart the orphan stage tables are gone and a retry
 *               adds exactly the rows that were missing (no duplicates)
 *   freeze      ClickHouse is frozen for 45 s in the middle of the commit (longer than the 30 s stall timeout): the watchdog fails
 *               the job, nothing of the failed import is left running on the server, the queue is free, and a retry adds only the rest
 *   concurrent  UPLOAD_CONCURRENCY=2, two files that share 30,000 rows: written once
 *   gate        free disk under the ingest floor while staging: the import waits (its stage exists), resumes, writes each row once
 *   off         INGEST_NOVELTY_CHECK=off: the direct path, no stage tables, rows stored again as before
 *   quality-gate  a file where 1 line in 20 breaks a rule is HELD (production defaults): zero rows stored, it waits in inbox/held with its report, Release imports it
 *                 once, and the audit row exists. (The disk gate's scenario is called "gate".)
 *   archive-ref   a file imported from the source archive through an .archiveref: same counts as the plain import, identity in ulp.sources, a same-name file with other
 *                 content is a new file, a damaged archive fails before one row is committed, and no plaintext copy of the file appears in the inbox
 *   same-name     the same-name check compares size: the same file again is skipped (and the job log says so), another file under that name is imported and gets its
 *                 own ulp.sources row; the job log records the rows repeated inside a file
 *   link          a finished file put back into the inbox as a second hard-linked name of itself: the second pass is skipped and labelled, and nothing is stranded in
 *                 processing/ (rename(2) between two names of one file does nothing), on the real inbox volume
 *   progress      two inbox files at once (UPLOAD_CONCURRENCY=2), one with short lines and one with long ones: the status endpoint lists both, each share read
 *                 follows the bytes read and not an assumed line length, the estimated total converges on the real one, and one file finishing leaves the other's card
 *   retention     inbox/done at start-up: a file imported over 7 days ago is removed only when the source archive holds it (a real archive, an .archiveref, a restart); a
 *                 file the archive does not hold, one imported yesterday although its own date is 40 days old, and one the job log never imported all stay
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-novelty-ingest.ts            # about 15 minutes; --only=kill,off runs just those; --skip-gate leaves out the filler
 *   REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x \
 *     docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v   # the compose file wants these set even to stop the stack
 *
 * Needs `zip` and `curl`, and about 40 GiB of free host disk for the gate scenario. Exit 0 when every check passes, 1 when one
 * fails, 2 when the stack is not ready or there is not enough room to run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const RECEIVER = 'ulprehearsal_receiver'
const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const GiB = 1024 ** 3
const FILLER = '/var/lib/clickhouse/zz_novelty_filler'
const BRAND = 'novelty-brand.test'

if (![APP, CH, RECEIVER].every(n => n.startsWith('ulprehearsal_'))) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length).split(',')
const want = (key: string) => !onlyArg || onlyArg.includes(key)
const skipGate = process.argv.includes('--skip-gate')

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}

const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-4).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

// --async_insert=0: the default profile buffers inserts, and this script reads what was written straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
const inList = (names: string[]) => names.map(n => `'${n}'`).join(', ')
const rowsFor = (...names: string[]) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file IN (${inList(names)})`))
const distinctFor = (...names: string[]) => Number(chQuery(`SELECT uniqExact(content_key_hash) FROM ulp.credentials WHERE source_file IN (${inList(names)})`))
const sourceLine = (name: string) => chQuery(`SELECT line_count FROM ulp.sources WHERE filename = '${name}'`)
const stageTableCount = () => Number(chQuery("SELECT count() FROM system.tables WHERE database = 'ulp' AND name LIKE 'zz_import_%'"))
const freeBytes = () => Number(chQuery("SELECT unreserved_space FROM system.disks WHERE name = 'default'"))
const appLog = () => {
  const r = spawnSync('docker', ['logs', APP], { encoding: 'utf8', maxBuffer: 256 << 20 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}
const receiverLines = (): Array<Record<string, any>> =>
  sh('docker', ['logs', RECEIVER]).split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* not yet */
    }
    await sleep(intervalMs)
  }
  return null
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const RUN = Date.now().toString(36) // source names are unique per run: the importer skips a name it has already imported
const work = mkdtempSync(join(tmpdir(), 'e2e-novelty-'))
const dockerCfg = mkdtempSync(join(tmpdir(), 'e2e-novelty-docker-'))
writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore

// The content carries the run id, so that a second run on the same stack does not find every row already known.
const line = (tag: string, i: number) => `https://shop${i % 500}.example-store.test/login:${tag}${RUN}x${i}@probe-mail.test:Pw-${tag}${RUN}x${i}-Xy!`
const lines = (tag: string, from: number, to: number) => Array.from({ length: to - from }, (_, k) => line(tag, from + k))
const text = (ls: string[]) => ls.join('\n') + '\n'
const fixture = (name: string, ls: string[]) => {
  const path = join(work, name)
  writeFileSync(path, text(ls))
  return path
}

function writeBig(path: string, tag: string, distinct: number, repeats: number): void {
  writeFileSync(path, '')
  const CHUNK = 100_000
  for (let from = 0; from < distinct; from += CHUNK) appendFileSync(path, text(lines(tag, from, Math.min(distinct, from + CHUNK))))
  appendFileSync(path, text(lines(tag, 0, repeats)))
}

// ── the app: secrets, login, API ────────────────────────────────────────────────────────────────
let secrets = { jwt: '', email: '', password: '' }
let cookie = ''

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: secrets.email, password: secrets.password }),
  })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}

interface AppSettings { concurrency?: string; novelty?: string; slab?: string; floorBytes?: number }

/** Looks for an accounting failure in the log of the container that is about to be replaced (its log goes with it). */
function scanLog(label: string): void {
  let log = ''
  try {
    log = appLog()
  } catch {
    return
  }
  check(`${label}: no accounting error in the app log`, !/NoveltyAccountingError|written-rows|accounting/i.test(log))
}

/** Recreates only the rehearsal app, keeping its data volume and its secrets. */
async function recreateApp(s: AppSettings = {}): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerCfg,
    REHEARSAL_JWT_SECRET: secrets.jwt,
    REHEARSAL_ADMIN_EMAIL: secrets.email,
    REHEARSAL_ADMIN_PASSWORD: secrets.password,
    REHEARSAL_WEBHOOK_SECRET: 'unused-here', // the compose file interpolates it; the receiver is not touched
    REHEARSAL_UPLOAD_CONCURRENCY: s.concurrency ?? '',
    REHEARSAL_INGEST_NOVELTY_CHECK: s.novelty ?? '',
    REHEARSAL_INGEST_NOVELTY_SLAB_ROWS: s.slab ?? '',
    REHEARSAL_INGEST_MIN_FREE_BYTES: s.floorBytes === undefined ? '' : String(s.floorBytes),
    REHEARSAL_INGEST_DISK_GATE: '',
  }
  sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, 'up', '-d', '--no-deps', '--force-recreate', 'app'], env)
  const up = await waitFor(() => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000, 2000)
  if (!up) return false
  await login()
  return true
}

// ── uploads and jobs ────────────────────────────────────────────────────────────────────────────
/** POST a file with curl. The body is received into the spool before the server answers, so a text upload returns quickly. */
function upload(name: string, path: string): { status: number; body: string; jobId: string | null } {
  const out = sh('curl', [
    '-sS', '-m', '900', '-w', '\n%{http_code}', '-X', 'POST',
    '-H', `cookie: ${cookie}`, '-H', 'content-type: application/octet-stream',
    '--data-binary', `@${path}`, `${BASE}/api/upload?filename=${encodeURIComponent(name)}`,
  ])
  const parts = out.split('\n')
  const status = Number(parts.pop())
  const body = parts.join('\n')
  return { status, body, jobId: /"jobId":"([^"]+)"/.exec(body)?.[1] ?? null }
}

interface JobEvent {
  status: string
  imported?: number
  known?: number
  inFileDuplicates?: number
  skipped?: number
  phase?: string
  staged?: number
  slab?: number
  slabs?: number
  error?: string
}

/** One SSE frame for the job (a finished job answers at once; a running one pushes a frame every 2 s). */
async function jobSnapshot(jobId: string, waitMs = 4500): Promise<JobEvent> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  try {
    const res = await fetch(`${BASE}/api/upload/progress/${jobId}`, { headers: { cookie }, signal: controller.signal })
    if (res.status !== 200 || !res.body) return { status: `http-${res.status}` }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { status: 'stream-closed' }
      buffer += decoder.decode(value, { stream: true })
      const frame = /^data: (.*)$/m.exec(buffer)
      if (frame) {
        controller.abort()
        return JSON.parse(frame[1]) as JobEvent
      }
    }
  } catch {
    return { status: 'no-event' }
  } finally {
    clearTimeout(timer)
  }
}

async function waitJob(jobId: string, timeoutMs: number, onEvent?: (e: JobEvent) => void): Promise<JobEvent> {
  const end = Date.now() + timeoutMs
  let last: JobEvent = { status: 'no-event' }
  while (Date.now() < end) {
    last = await jobSnapshot(jobId)
    onEvent?.(last)
    if (last.status === 'done' || last.status === 'error') return last
    await sleep(1000)
  }
  return last
}

async function importPath(name: string, path: string, timeoutMs = 300_000, onEvent?: (e: JobEvent) => void): Promise<JobEvent> {
  const up = upload(name, path)
  if (up.status !== 200 || !up.jobId) return { status: `http-${up.status}`, error: up.body.slice(0, 200) }
  return waitJob(up.jobId, timeoutMs, onEvent)
}

const importLines = (name: string, ls: string[], timeoutMs?: number) => importPath(name, fixture(name, ls), timeoutMs)
const brief = (e: JobEvent) => JSON.stringify({ status: e.status, imported: e.imported, known: e.known, dup: e.inFileDuplicates, skipped: e.skipped, error: e.error })

async function expectIdleQueue(label: string): Promise<void> {
  const idle = await waitFor(async () => {
    const q = (await api('GET', '/api/upload/queue-status')).json?.queue
    return q?.active === 0 && q?.pending === 0
  }, 60_000, 500)
  check(`${label}: the queue slot is free again`, !!idle)
}

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────
async function basic(): Promise<void> {
  console.log('\n1. Files through the HTTP upload and the inbox')
  const A = `e2e-nov-a-${RUN}.txt`
  const B = `e2e-nov-b-${RUN}.txt`
  const C = `e2e-nov-c-${RUN}.txt`
  const D = `e2e-nov-d-${RUN}.txt`

  const a = await importLines(A, lines('A', 0, 20_000))
  check('a new file: 20000 new, none known, none repeated', a.status === 'done' && a.imported === 20_000 && a.known === 0 && a.inFileDuplicates === 0, brief(a))
  check('...all 20000 rows are in ClickHouse', rowsFor(A) === 20_000, `rows ${rowsFor(A)}`)
  check('...the file is remembered in ulp.sources with its 20000 rows', sourceLine(A) === '20000', sourceLine(A))
  check('...and no stage table is left behind', stageTableCount() === 0, `tables ${stageTableCount()}`)

  const b = await importLines(B, lines('A', 0, 20_000))
  check('the same content under another name: 0 new, 20000 already known', b.status === 'done' && b.imported === 0 && b.known === 20_000, brief(b))
  check('...nothing was stored twice', rowsFor(B) === 0 && distinctFor(A, B) === 20_000, `rows ${rowsFor(B)}, distinct ${distinctFor(A, B)}`)
  check('...the second name is remembered too, with 0 rows', sourceLine(B) === '0', `[${sourceLine(B)}]`)
  const b2 = await importLines(B, lines('A', 0, 20_000))
  check('...and uploading that name again is skipped by the same-name guard', b2.status === 'done' && b2.imported === 0 && b2.known === 0 && sourceLine(B) === '0', brief(b2))

  const c = await importLines(C, [...lines('A', 0, 10_000), ...lines('C', 0, 10_000)])
  check('a half-overlap file: 10000 new, 10000 already known', c.status === 'done' && c.imported === 10_000 && c.known === 10_000, brief(c))
  check('...only the new half was stored', rowsFor(C) === 10_000 && distinctFor(A, B, C) === 30_000, `rows ${rowsFor(C)}, distinct ${distinctFor(A, B, C)}`)

  const repeated = lines('D', 0, 5_000)
  const d = await importLines(D, [...repeated, ...repeated, ...repeated])
  check('a file of 5000 lines repeated three times: 5000 new, 10000 repeats, none known', d.status === 'done' && d.imported === 5_000 && d.inFileDuplicates === 10_000 && d.known === 0, brief(d))
  check('...5000 rows stored', rowsFor(D) === 5_000, `rows ${rowsFor(D)}`)

  const z1 = `e2e-nov-z1-${RUN}.txt`
  const z2 = `e2e-nov-z2-${RUN}.txt`
  const zipPath = join(work, `e2e-nov-${RUN}.zip`)
  sh('zip', ['-j', '-q', zipPath, fixture(z1, lines('Z', 0, 3_000)), fixture(z2, lines('A', 0, 5_000))])
  const zip = upload(`e2e-nov-${RUN}.zip`, zipPath)
  let zipJson: any = null
  try {
    zipJson = JSON.parse(zip.body)
  } catch {
    /* reported below */
  }
  check('a ZIP with a new and a known entry: 3000 new, 5000 known', zip.status === 200 && zipJson?.imported === 3_000 && zipJson?.known === 5_000, zip.body.slice(0, 200))
  check('...both entries are listed, the known one with 0 new rows',
    zipJson?.files?.length === 2 && zipJson.files.some((f: any) => f.filename === z2 && f.imported === 0 && f.known === 5_000), JSON.stringify(zipJson?.files))
  check('...and both entries are remembered', sourceLine(z1) === '3000' && sourceLine(z2) === '0', `[${sourceLine(z1)}] [${sourceLine(z2)}]`)

  const N = `e2e-nov-inbox-${RUN}.txt`
  sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${N}`], process.env, text([...lines('A', 0, 3_000), ...lines('N', 0, 5_000)]))
  const done = await waitFor(async () => {
    const status = await api('GET', '/api/inbox/status')
    return (status.json?.done_recent ?? []).find((r: any) => r.filename === N && (r.status === 'done' || r.status === 'failed'))
  }, 180_000, 2000)
  check('a file dropped in the inbox is processed: 5000 new, 3000 known in the job log', !!done && done.status === 'done' && done.imported === 5_000 && done.known === 3_000, JSON.stringify(done))
  check('...its rows are in ClickHouse once', rowsFor(N) === 5_000 && sourceLine(N) === '5000', `rows ${rowsFor(N)}`)
  const queue = await api('GET', '/api/upload/queue-status')
  check('the queue status totals the known rows', (queue.json?.totals?.rows_known ?? 0) >= 28_000, JSON.stringify(queue.json?.totals))
  check('no stage table is left after all of it', stageTableCount() === 0, `tables ${stageTableCount()}`)
}

async function telegramTags(): Promise<void> {
  console.log('\n1b. Telegram channel tags on credential lines (lib/ulp-telegram-tag.ts)')
  const T = `e2e-nov-tags-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const mailPw = `mailpw${RUN}@probe-mail.test`
  const ls = [
    `shop1.example-store.test/:tgA${RUN}@probe-mail.test:${pw('A')} https://t.me/SomeChannel`,
    `https://shop2.example-store.test/login:tgB${RUN}@probe-mail.test:${pw('B')}t.me/SomeChannel`,
    `shop3.example-store.test/:tgC${RUN}:${pw('C')}t.me/SomeChannel  You can buy dm @SomeChannel`,
    `shop4.example-store.test/login:tgD${RUN}@probe-mail.test:${pw('D')}          @best_ulp - daily | https://t.me/+AbC123`,
    `tgE${RUN}@probe-mail.test:${pw('E')} https://t.me/SomeChannel`,
    `https://shop6.example-store.test/login:tgF${RUN}@probe-mail.test:${pw('F')}`,
    // a password that is an e-mail address, the tag glued on after it: only the tag is cut off
    `shop10.example-store.test/login:tgK${RUN}@probe-mail.test:${mailPw}t.me/SomeChannel`,
    // a scheme glued on and an advert that carries a second link: the colon of its "https://" is not a field separator
    `shop11.example-store.test/login:tgL${RUN}@probe-mail.test:${pw('L')}://t.me/SomeChannel|NAME;@NAME|https://t.me/+AbC123`,
    // a banner that starts with http: it must not take the next two lines for a login and a password
    'https://t.me/+AbC123',
    `shop8.example-store.test/:tgH${RUN}:${pw('H')}`,
    `shop9.example-store.test/:tgI${RUN}:${pw('I')}`,
    // a watermark inside a field: not a credential
    `android://hash${RUN}@com.example.app:DAILY PREMIUM https://https://t.me/+AbC123 LINES:${pw('J')}`,
  ]
  const t = await importLines(T, ls)
  check('a file with channel tags: the 10 real credentials are new, none known', t.status === 'done' && t.imported === 10 && t.known === 0, brief(t))
  check('...the banner and the watermark line are skipped, only the 10 are stored', (t.skipped ?? 0) >= 2 && rowsFor(T) === 10, `skipped ${t.skipped}, rows ${rowsFor(T)}`)
  const linked = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${T}' AND (position(password, 't.me') > 0 OR position(email, 't.me') > 0)`))
  check('...no stored email or password holds a Telegram link', linked === 0, `rows with a link: ${linked}`)
  const stored = chQuery(`SELECT arrayStringConcat(arraySort(groupArray(password)), ',') FROM ulp.credentials WHERE source_file = '${T}'`)
  const expected = [...['A', 'B', 'C', 'D', 'E', 'F', 'H', 'I', 'L'].map(pw), mailPw].sort().join(',')
  check('...every stored password is the clean one: the tag and the advert are cut off (an e-mail address as a password keeps its domain)', stored === expected, `${stored} vs ${expected}`)
}

async function positionalRecords(): Promise<void> {
  console.log('\n1c. A rejected URL line does not take the next two lines for a login and a password (lib/ulp-parser.ts)')
  const P = `e2e-nov-positional-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const ls = [
    // a credential line the field split cannot take (a password with three slashes looks like a path; parser v6 reads one slash, see scenario v6):
    // it is rejected, and the two real lines after it are kept
    `https://shop1.example-store.test:posA${RUN}:Pass/${RUN}/x/y`,
    `https://shop2.example-store.test:posB${RUN}:${pw('B')}`,
    `https://shop3.example-store.test:posC${RUN}:${pw('C')}`,
    // a genuine label-free record: a bare URL, a lone login, a password
    'https://shop4.example-store.test/login',
    `posD${RUN}@probe-mail.test`,
    pw('D'),
    `https://shop5.example-store.test:posE${RUN}:${pw('E')}`,
    // a stray scheme in front of an e-mail login, no url: an e-mail:password pair
    `https://posF${RUN}@probe-mail.test:${pw('F')}`,
    // the layout login:password:url, the url last
    `posG${RUN}:${pw('G')}:https://shop7.example-store.test/login`,
    // a url, one space, then login:password
    `http://shop8.example-store.test/login posH${RUN}:${pw('H')}`,
    // a ";name=value" path parameter in the url is not a field separator
    `https://shop9.example-store.test/login;jsessionid=AB12${RUN}:posI${RUN}:${pw('I')}`,
    // an e-mail login and its password in front of a pipe, then a note
    `posJ${RUN}@probe-mail.test:${pw('J')} | Country: US`,
  ]
  const p = await importLines(P, ls)
  check('a file with a rejected URL line, a genuine block record, a stray-scheme pair, a url-last line, a url-space line, a path parameter and a pair with a note: 9 credentials are new, none known', p.status === 'done' && p.imported === 9 && p.known === 0, brief(p))
  check('...the rejected line is the only one skipped, 9 rows are stored', p.skipped === 1 && rowsFor(P) === 9, `skipped ${p.skipped}, rows ${rowsFor(P)}`)
  const stored = chQuery(`SELECT arrayStringConcat(arraySort(groupArray(email)), ',') FROM ulp.credentials WHERE source_file = '${P}'`)
  const expected = [`posB${RUN}`, `posC${RUN}`, `posD${RUN}@probe-mail.test`, `posE${RUN}`, `posF${RUN}@probe-mail.test`, `posG${RUN}`, `posH${RUN}`, `posI${RUN}`, `posJ${RUN}@probe-mail.test`].sort().join(',')
  check('...the two lines after the rejected one are their own credentials, the block record is one, the pair keeps its e-mail: no merged row', stored === expected, `${stored} vs ${expected}`)
  const noUrl = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posF${RUN}@probe-mail.test' AND url = '' AND domain = 'probe-mail.test'`))
  check('...the stray-scheme pair is stored with no url and its e-mail domain', noUrl === 1, `rows ${noUrl}`)
  const urlLast = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posG${RUN}' AND url = 'https://shop7.example-store.test/login' AND domain = 'shop7.example-store.test'`))
  check('...the url-last line is stored with its url, its login and its domain', urlLast === 1, `rows ${urlLast}`)
  const urlSpace = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posH${RUN}' AND url = 'http://shop8.example-store.test/login' AND domain = 'shop8.example-store.test'`))
  check('...the url-space line is stored with its url, its login and its domain', urlSpace === 1, `rows ${urlSpace}`)
  const urlParam = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posI${RUN}' AND url = 'https://shop9.example-store.test/login;jsessionid=AB12${RUN}'`))
  check('...the path-parameter line keeps the parameter in its url and has its own login', urlParam === 1, `rows ${urlParam}`)
  const withNote = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posJ${RUN}@probe-mail.test' AND password = '${pw('J')}'`))
  check('...the pair with a note after the pipe is stored as the pair', withNote === 1, `rows ${withNote}`)
  const merged = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND position(email, '://') > 0`))
  check('...no stored login holds a whole line', merged === 0, `rows ${merged}`)
}

async function parserV6(): Promise<void> {
  console.log('\n1d. Parser v6 (docs/superpowers/specs/2026-10-12-parser-v6-and-redo-design.md)')
  const V = `e2e-nov-v6-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const app = (n: number) => `AbCdEfGhIjKlMnOpQr${String(n).padStart(2, '0')}${RUN}==@com.example.app${n}`
  const café = `café-${RUN}`
  const ls = [
    `shopa.example-store.test : v6a${RUN}@probe-mail.test : ${pw('A')}`,                          // A: space-padded colons, no scheme
    `${app(1)}/:v6b${RUN}@probe-mail.test:${pw('B')}`,                                             // B: an Android app id without its scheme ...
    `${app(2)}/:v6b${RUN}@probe-mail.test:${pw('B')}`,                                             // ... the same account under another app id: one row
    `https://shopc1.example-store.test:v6c1${RUN}@probe-mail.test:Pa/ss-${RUN}`,                  // C: a slash in the password, e-mail login
    `https://shopc2.example-store.test:v6c2${RUN}:Pa/ss-${RUN}`,                                   // C: a slash in the password, another login
    `https://shopd.example-store.test:48213:${pw('D')}`,                                           // D: a number that is not a web port is the login
    `//shope.example-store.test/login:v6e${RUN}:${pw('E')}`,                                       // E: a protocol-relative url
    `https://shopu.example-store.test/login:v6u${RUN}@probe-mail.test:${café}`,                    // UTF-8 password
    `https://shopv.example-store.test/login:Иван${RUN}:${pw('V')}`,            // UTF-8 (Cyrillic) login
    `https://shopw.example-store.test/login:same${RUN}:same${RUN}`,                                // login == password, not an e-mail: stored
    `https://shopx.example-store.test/login:v6x${RUN}@probe-mail.test:v6x${RUN}@probe-mail.test`, // e-mail == password: skipped
    `https://shop.example-store.com.pl/login:v6p${RUN}:${pw('P')}`,                                // T3, Poland is on the keep-list: stored
    `https://shop.example-store.com.br/login:v6q${RUN}:${pw('Q')}`,                                // T3, Brazil is not: dropped
  ]
  const v = await importLines(V, ls)
  check('a file with one line per v6 rule: 10 rows are new, none known', v.status === 'done' && v.imported === 10 && v.known === 0, brief(v))
  check('...3 lines are skipped (the repeat of the Android account, the e-mail equal to its password, the Brazilian T3 line) and 10 rows are stored', v.skipped === 3 && rowsFor(V) === 10, `skipped ${v.skipped}, rows ${rowsFor(V)}`)
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${V}' AND ${where}`))
  const hex = (s: string) => `unhex('${Buffer.from(s, 'utf8').toString('hex')}')`
  check('A: the padded line is stored with its url, login and password', one(`url = 'shopa.example-store.test' AND email = 'v6a${RUN}@probe-mail.test' AND password = '${pw('A')}'`) === 1)
  check('B: the Android account is one row, with the scheme put back', one(`email = 'v6b${RUN}@probe-mail.test' AND startsWith(url, 'android://')`) === 1)
  check('C: both slash-in-password lines keep the slash and have the host as url', one(`email = 'v6c1${RUN}@probe-mail.test' AND password = 'Pa/ss-${RUN}' AND url = 'https://shopc1.example-store.test'`) === 1
    && one(`email = 'v6c2${RUN}' AND password = 'Pa/ss-${RUN}' AND url = 'https://shopc2.example-store.test'`) === 1)
  check('D: the number is the login', one(`email = '48213' AND password = '${pw('D')}' AND url = 'https://shopd.example-store.test'`) === 1)
  check('E: the protocol-relative line is a scheme-less url with its domain', one(`url = 'shope.example-store.test/login' AND email = 'v6e${RUN}' AND domain = 'shope.example-store.test'`) === 1)
  check('UTF-8: the password is stored as typed (not double-encoded) and the Cyrillic login is stored', one(`password = ${hex(café)}`) === 1 && one(`email = ${hex(`Иван${RUN}`)}`) === 1)
  check('login == password: stored for a login that is not an e-mail, skipped for an e-mail', one(`email = 'same${RUN}' AND password = 'same${RUN}'`) === 1 && one(`email = 'v6x${RUN}@probe-mail.test'`) === 0)
  check('T3: the Polish line is stored, the Brazilian one is not', one(`email = 'v6p${RUN}'`) === 1 && one(`email = 'v6q${RUN}'`) === 0)
}

async function parserV61(): Promise<void> {
  console.log('\n1e. Parser v6.1: pipes that join a url and a credential, a semicolon in the password, a path parameter without a scheme')
  const P = `e2e-nov-v61-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const app = `AbCdEfGhIjKlMnOpQr61${RUN}==@com.example.app61`
  const ls = [
    `https://| shopf1.example-store.test:v61f1${RUN}@probe-mail.test:${pw('F1')}`,                    // F: only the scheme in front of the pipe
    `https://| shopf2.example-store.test/login:v61f2${RUN}:${pw('F2')}`,                              // F: ... with a path, another login
    `Network:| shopg1.example-store.test:v61g1${RUN}:${pw('G1')}`,                                      // G: a one-word label
    `Network:| v61g2${RUN}@probe-mail.test:${pw('G2')}`,                                                // G: ... in front of an e-mail pair
    `Network:| ${app}/:v61g3${RUN}@probe-mail.test:${pw('G3')}`,                                        // G: ... in front of an Android app id without its scheme
    `https://shoph1.example-store.test/login:| v61h1${RUN}:${pw('H1')}`,                                // H: a url, a colon, the pipe
    `https://shoph2.example-store.test/login |:v61h2${RUN}@probe-mail.test:${pw('H2')}`,                // H: ... a space and the pipe in front of the colon
    `https://shoph3.example-store.test/login|v61h3${RUN}@probe-mail.test:${pw('H3')}`,                  // H: ... the pipe alone
    `https://shopi1.example-store.test:v61i1${RUN}@probe-mail.test:Sec;${pw('I1')}`,                    // I: a semicolon in the password, url:e-mail:password
    `v61i2${RUN}@probe-mail.test:Sec;${pw('I2')}`,                                                      // I: ... an e-mail and its password
    `shopj.example-store.test/app;jsessionid=AB${RUN}:v61j${RUN}:${pw('J')}`,                           // a path parameter in a url without a scheme
    // the layouts that must not move
    `https://shopk1.example-store.test|v61k1${RUN}@probe-mail.test|${pw('K1')}`,                        // url|login|password
    `v61k2${RUN}@probe-mail.test|Sec:${pw('K2')}`,                                                      // e-mail|password with a colon in the password
    `https://shopk3.example-store.test/login:v61k3${RUN}:${pw('K3')}|RU|note`,                          // a credential then notes
    `https://shopk4.example-store.test;v61k4${RUN};${pw('K4')}`,                                        // url;login;password
  ]
  const v = await importLines(P, ls)
  check('a file with one line per v6.1 rule and the layouts that must not move: 15 rows are new, none known', v.status === 'done' && v.imported === 15 && v.known === 0, brief(v))
  check('...nothing is skipped and 15 rows are stored', v.skipped === 0 && rowsFor(P) === 15, `skipped ${v.skipped}, rows ${rowsFor(P)}`)
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND ${where}`))
  check('F: the scheme in front of the pipe joins the host, and the login and password are the credential',
    one(`url = 'https://shopf1.example-store.test' AND email = 'v61f1${RUN}@probe-mail.test' AND password = '${pw('F1')}'`) === 1
    && one(`url = 'https://shopf2.example-store.test/login' AND email = 'v61f2${RUN}' AND password = '${pw('F2')}'`) === 1)
  check('G: the label is dropped (a url, an e-mail pair without a url, an Android app id with its scheme put back)',
    one(`url = 'shopg1.example-store.test' AND email = 'v61g1${RUN}' AND password = '${pw('G1')}'`) === 1
    && one(`url = '' AND email = 'v61g2${RUN}@probe-mail.test' AND password = '${pw('G2')}'`) === 1
    && one(`startsWith(url, 'android://') AND email = 'v61g3${RUN}@probe-mail.test' AND password = '${pw('G3')}'`) === 1)
  check('H: the url keeps its path and the credential behind the pipe is the login and the password',
    one(`url = 'https://shoph1.example-store.test/login' AND email = 'v61h1${RUN}' AND password = '${pw('H1')}'`) === 1
    && one(`url = 'https://shoph2.example-store.test/login' AND email = 'v61h2${RUN}@probe-mail.test' AND password = '${pw('H2')}'`) === 1
    && one(`url = 'https://shoph3.example-store.test/login' AND email = 'v61h3${RUN}@probe-mail.test' AND password = '${pw('H3')}'`) === 1)
  check('I: the semicolon is part of the password',
    one(`url = 'https://shopi1.example-store.test' AND email = 'v61i1${RUN}@probe-mail.test' AND password = 'Sec;${pw('I1')}'`) === 1
    && one(`url = '' AND email = 'v61i2${RUN}@probe-mail.test' AND password = 'Sec;${pw('I2')}'`) === 1)
  check('a path parameter in a url without a scheme stays in the url',
    one(`url = 'shopj.example-store.test/app;jsessionid=AB${RUN}' AND email = 'v61j${RUN}' AND password = '${pw('J')}'`) === 1)
  check('the layouts that must not move are stored as before',
    one(`url = 'https://shopk1.example-store.test' AND email = 'v61k1${RUN}@probe-mail.test' AND password = '${pw('K1')}'`) === 1
    && one(`url = '' AND email = 'v61k2${RUN}@probe-mail.test' AND password = 'Sec:${pw('K2')}'`) === 1
    && one(`url = 'https://shopk3.example-store.test/login' AND email = 'v61k3${RUN}' AND password = '${pw('K3')}'`) === 1
    && one(`url = 'https://shopk4.example-store.test' AND email = 'v61k4${RUN}' AND password = '${pw('K4')}'`) === 1)
  check('no row holds a scheme, a label or a url as its login', one(`(email IN ('https://', 'Network:') OR startsWith(email, 'https://'))`) === 0)
}

async function monitorScenario(): Promise<void> {
  console.log('\n2. A monitor alerts for the rows that are new to the database')
  const hook = await api('POST', '/api/monitoring/webhooks', { name: `Novelty Receiver ${RUN}`, url: `http://${RECEIVER}:9000/hook`, secret: 'rehearsal' })
  const hookId = hook.json?.data?.id as number | undefined
  if (!check('a webhook to the receiver is accepted', hook.status === 200 && !!hookId, `status ${hook.status}: ${hook.json?.error ?? ''}`)) return
  const mon = await api('POST', '/api/monitoring/monitors', {
    name: `Novelty Monitor ${RUN}`, domains: [BRAND], match_mode: 'both', webhook_ids: [hookId], rescan_mode: 'dedup', rescan_interval_hours: 1,
  })
  if (!check('a monitor on the synthetic brand domain is created', mon.status === 200 && !!mon.json?.data?.id, `status ${mon.status}`)) return

  // A row the database holds but this monitor has never seen: it did not come through the importer.
  chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file) VALUES ('https://${BRAND}/login', 'quiet-${RUN}@${BRAND}', 'Pw-quiet-Xy!', '${BRAND}', 'e2e-nov-direct-${RUN}.txt')`)
  const name = `e2e-nov-mon-${RUN}.txt`
  const ev = await importLines(name, [
    `https://${BRAND}/login:quiet-${RUN}@${BRAND}:Pw-quiet-Xy!`,
    `https://${BRAND}/login:fresh-${RUN}@${BRAND}:Pw-fresh-Xy!`,
    ...lines('M', 0, 50),
  ])
  check('the file imported: 51 new, 1 known (the row the database already held)', ev.status === 'done' && ev.imported === 51 && ev.known === 1, brief(ev))
  const alert = await waitFor(() => receiverLines().find(l => l.source_file === name), 90_000, 2000)
  check('the monitor alerted for the file', !!alert)
  check('...for the new row only (the row the database already held did not alert)',
    alert?.total_matches === 1 && alert.match_emails?.length === 1 && alert.match_emails[0] === `fresh-${RUN}@${BRAND}`, JSON.stringify(alert))
}

async function bigFile(): Promise<void> {
  console.log('\n3. A file past the old 2,000,000-entry in-file cap, in slabs of 500,000')
  scanLog('before the big file')
  if (!check('the rehearsal app restarted with 500000-row slabs', await recreateApp({ slab: '500000' }))) return
  const name = `e2e-nov-big-${RUN}.txt`
  const path = join(work, name)
  writeBig(path, 'B', 2_500_000, 100_000)
  const phases = new Set<string>()
  const ev = await importPath(name, path, 900_000, e => { if (e.phase) phases.add(e.phase) })
  check('2,500,000 new rows', ev.status === 'done' && ev.imported === 2_500_000, brief(ev))
  check('100,000 repeats of early lines were counted as repeats (the old per-file Set stopped at 2M entries)', ev.inFileDuplicates === 100_000 && ev.known === 0, brief(ev))
  check('...stored exactly once each', rowsFor(name) === 2_500_000 && distinctFor(name) === 2_500_000, `rows ${rowsFor(name)}, distinct ${distinctFor(name)}`)
  check('it was committed in 5 slabs', ev.slabs === 5, `slabs ${ev.slabs}`)
  check('the phases were visible while it ran: reading, then checking or writing', phases.has('parsing') && (phases.has('checking') || phases.has('inserting')), [...phases].join(','))
  check('no stage table is left', stageTableCount() === 0)
}

async function killMidCommit(): Promise<void> {
  console.log('\n4. The app is killed in the middle of the commit')
  scanLog('before the kill scenario')
  if (!check('the rehearsal app restarted with 1000-row slabs', await recreateApp({ slab: '1000' }))) return
  const name = `e2e-nov-kill-${RUN}.txt`
  const path = fixture(name, lines('K', 0, 120_000))
  const up = upload(name, path)
  check('the upload was accepted', up.status === 200 && !!up.jobId, `HTTP ${up.status}`)
  const midway = await waitFor(() => { const n = rowsFor(name); return n >= 3_000 && n < 100_000 ? n : 0 }, 240_000, 300)
  check('the commit was under way: some rows written, not all', !!midway, `rows ${rowsFor(name)}`)
  check('...and its stage tables exist', stageTableCount() === 2, `tables ${stageTableCount()}`)
  sh('docker', ['kill', APP])
  await sleep(10_000) // a statement the dead client left running finishes
  const before = rowsFor(name)
  info('rows written when the app was killed', before)
  check('the interrupted import wrote only part of the file', before > 0 && before < 120_000, `rows ${before}`)
  check('nothing has dropped the orphan stage tables yet', stageTableCount() === 2, `tables ${stageTableCount()}`)
  check('the file is not remembered as imported', sourceLine(name) === '', `[${sourceLine(name)}]`)

  if (!check('the app started again', await recreateApp({ slab: '1000' }))) return
  const swept = await waitFor(() => stageTableCount() === 0, 90_000, 1000)
  check('the start-up sweep dropped the orphan stage tables', !!swept, `tables ${stageTableCount()}`)
  check('the log says so', /\[ingest-stage\] dropped 2 orphan stage table/.test(appLog()))

  const again = await importPath(name, path)
  check('a retry of the same file adds exactly the rows that were missing', again.status === 'done' && again.imported === 120_000 - before, `${brief(again)} (before ${before})`)
  check('...and counts the rows that had been written as known', again.known === before, `known ${again.known}, before ${before}`)
  check('every row is there exactly once', rowsFor(name) === 120_000 && distinctFor(name) === 120_000, `rows ${rowsFor(name)}, distinct ${distinctFor(name)}`)
  check('now the file is remembered, with the rows the retry added', sourceLine(name) === String(120_000 - before), `[${sourceLine(name)}]`)
}

async function freezeDuringCommit(): Promise<void> {
  console.log('\n5. ClickHouse is frozen for 45 s in the middle of the commit (longer than the 30 s stall timeout)')
  scanLog('before the freeze scenario')
  if (!check('the rehearsal app restarted with 1000-row slabs', await recreateApp({ slab: '1000' }))) return
  const name = `e2e-nov-freeze-${RUN}.txt`
  const path = fixture(name, lines('F', 0, 60_000))
  const up = upload(name, path)
  check('the upload was accepted', up.status === 200 && !!up.jobId, `HTTP ${up.status}`)
  const midway = await waitFor(() => { const n = rowsFor(name); return n >= 2_000 && n < 50_000 ? n : 0 }, 240_000, 300)
  check('the commit was under way: some rows written, not all', !!midway, `rows ${rowsFor(name)}`)

  sh('docker', ['pause', CH])
  let during: JobEvent | null = null
  try {
    await sleep(40_000)
    during = up.jobId ? await jobSnapshot(up.jobId) : null // ClickHouse is still frozen here
    await sleep(8_000) // the kill had a bounded wait of its own (15 s) while the server was frozen
  } finally {
    sh('docker', ['unpause', CH])
  }
  await waitFor(() => chQuery('SELECT 1') === '1', 60_000, 1000)

  check('the watchdog failed the job while ClickHouse was frozen, with the stall reason', during?.status === 'error' && /stalled/.test(during.error ?? ''), JSON.stringify(during))
  await expectIdleQueue('after the stall')
  const quiet = await waitFor(() => chQuery("SELECT count() FROM system.processes WHERE query_id LIKE 'novelty-%'") === '0', 90_000, 1000)
  check('after the thaw no statement of the failed import is still running on the server', !!quiet, `running ${chQuery("SELECT count() FROM system.processes WHERE query_id LIKE 'novelty-%'")}`)
  const gone = await waitFor(() => stageTableCount() === 0, 90_000, 1000)
  check('...and its stage tables were dropped once the server answered again', !!gone, `tables ${stageTableCount()}`)
  const before = rowsFor(name)
  info('rows written before the stall settled', before)
  check('the file is not remembered as imported', sourceLine(name) === '', `[${sourceLine(name)}]`)

  const again = await importPath(name, path)
  check('a retry adds exactly the rows that were missing and counts the written ones as known', again.status === 'done' && again.known === before && again.imported === 60_000 - before, `${brief(again)} (before ${before})`)
  check('every row is there exactly once', rowsFor(name) === 60_000 && distinctFor(name) === 60_000, `rows ${rowsFor(name)}, distinct ${distinctFor(name)}`)
}

async function concurrentFiles(): Promise<void> {
  console.log('\n6. Two files at once (UPLOAD_CONCURRENCY=2) that share 30,000 rows')
  scanLog('before the concurrent scenario')
  if (!check('the rehearsal app restarted with concurrency 2', await recreateApp({ concurrency: '2' }))) return
  const shared = lines('S', 0, 30_000)
  const g = `e2e-nov-g-${RUN}.txt`
  const h = `e2e-nov-h-${RUN}.txt`
  const upG = upload(g, fixture(g, [...shared, ...lines('G', 0, 10_000)]))
  const upH = upload(h, fixture(h, [...shared, ...lines('H', 0, 10_000)]))
  const [evG, evH] = await Promise.all([waitJob(upG.jobId ?? '', 300_000), waitJob(upH.jobId ?? '', 300_000)])
  check('both imports finished', evG.status === 'done' && evH.status === 'done', `${brief(evG)} ${brief(evH)}`)
  check('together they wrote 50,000 new rows: the shared 30,000 once', (evG.imported ?? 0) + (evH.imported ?? 0) === 50_000, `${evG.imported} + ${evH.imported}`)
  check('...and one of them counted the shared rows as known', (evG.known ?? 0) + (evH.known ?? 0) === 30_000, `${evG.known} + ${evH.known}`)
  check('ClickHouse holds 50,000 rows, all distinct', rowsFor(g, h) === 50_000 && distinctFor(g, h) === 50_000, `rows ${rowsFor(g, h)}, distinct ${distinctFor(g, h)}`)
}

async function gateScenario(): Promise<boolean> {
  console.log('\n7. Free disk under the ingest floor while staging')
  scanLog('before the gate scenario')
  const start = freeBytes()
  const floor = Math.floor(((start - 2 * GiB) * 10) / 11) // the resume level (floor x 1.1) sits 2 GiB under the free space now
  const fillerBytes = start - floor + GiB
  info('free space / floor / filler', `${(start / GiB).toFixed(1)} / ${(floor / GiB).toFixed(1)} / ${(fillerBytes / GiB).toFixed(1)} GiB`)
  if (start - fillerBytes < 20 * GiB) {
    console.error('Not enough free host disk space to run the gate scenario safely (it would leave less than 20 GiB).')
    return false
  }
  if (!check('the rehearsal app restarted with the test floor', await recreateApp({ floorBytes: floor }))) return true
  try {
    const mib = Math.ceil(fillerBytes / (1024 * 1024))
    try {
      sh('docker', ['exec', CH, 'fallocate', '-l', `${mib}M`, FILLER])
    } catch {
      sh('docker', ['exec', CH, 'sh', '-c', `dd if=/dev/zero of=${FILLER} bs=1M count=${mib} 2>/dev/null`])
    }
    check('free space is now under the floor', !!(await waitFor(() => freeBytes() < floor, 60_000, 500)), `free ${freeBytes()} floor ${floor}`)
    await sleep(6_000) // the gate reuses a free-space reading younger than 5 s
    const name = `e2e-nov-gate-${RUN}.txt`
    const up = upload(name, fixture(name, lines('P', 0, 20_000)))
    check('the upload was accepted', up.status === 200 && !!up.jobId, `HTTP ${up.status}`)
    const paused = await waitFor(async () => (await api('GET', '/api/monitoring/disk')).json?.gate?.paused === true, 60_000)
    check('the gate paused the import', !!paused)
    check('...its stage tables already exist (created before the first batch)', stageTableCount() === 2, `tables ${stageTableCount()}`)
    await sleep(40_000) // longer than the rehearsal's 30 s stall timeout: only the gate's heartbeat keeps the job alive
    const during = up.jobId ? await jobSnapshot(up.jobId) : { status: 'none' }
    check('after 40 s the job is still waiting, not failed and not finished', during.status === 'running', JSON.stringify(during))
    check('nothing reached the real table meanwhile', rowsFor(name) === 0, `rows ${rowsFor(name)}`)
    try {
      sh('docker', ['exec', CH, 'rm', '-f', FILLER])
    } catch {
      /* reported by the next check */
    }
    const final = up.jobId ? await waitJob(up.jobId, 240_000) : null
    check('the filler is removed: the import finishes by itself, 20000 new rows', final?.status === 'done' && final.imported === 20_000, JSON.stringify(final))
    check('...each row exactly once', rowsFor(name) === 20_000 && distinctFor(name) === 20_000, `rows ${rowsFor(name)}`)
    check('...and the stage tables are gone', stageTableCount() === 0, `tables ${stageTableCount()}`)
  } finally {
    try {
      sh('docker', ['exec', CH, 'rm', '-f', FILLER])
    } catch {
      /* already gone */
    }
  }
  return true
}

async function directPath(): Promise<void> {
  console.log('\n8. INGEST_NOVELTY_CHECK=off keeps the direct path')
  scanLog('before the direct-path scenario')
  if (!check('the rehearsal app restarted with the novelty check off', await recreateApp({ novelty: 'off' }))) return
  const X = `e2e-nov-off-x-${RUN}.txt`
  const Y = `e2e-nov-off-y-${RUN}.txt`
  const x = await importLines(X, lines('O', 0, 2_000))
  const y = await importLines(Y, lines('O', 0, 2_000))
  check('both copies are imported in full: 2000 rows each, nothing known', x.imported === 2_000 && y.imported === 2_000 && (y.known ?? 0) === 0, `${brief(x)} ${brief(y)}`)
  check('...so the same content is stored twice, as before the feature', rowsFor(X, Y) === 4_000 && distinctFor(X, Y) === 2_000, `rows ${rowsFor(X, Y)}, distinct ${distinctFor(X, Y)}`)
  check('no stage table was created', stageTableCount() === 0)
}

// ── quality gate and archive reference ─────────────────────────────────────────
const inboxLs = (sub: string) => sh('docker', ['exec', APP, 'sh', '-c', `ls -1 /app/inbox/${sub} 2>/dev/null || true`]).split('\n').filter(Boolean)

async function qualityGate(): Promise<void> {
  console.log('\n9. The ingest quality gate holds a bad file, and Release imports it')
  scanLog('before the quality-gate scenario')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const H = `e2e-qg-held-${RUN}.txt`
  const junk = (i: number) => `https://shop${i % 500}.example-store.test/login:user${i}${RUN}@probe-mail.test:Pw://x${i}${RUN}`
  const body = [...lines('Q', 0, 22_800), ...Array.from({ length: 1_200 }, (_, i) => junk(i))]

  const held = await importLines(H, body)
  check('a file where 1 line in 20 breaks a rule ends in error with the hold message', held.status === 'error' && /Held by the quality gate/.test(held.error ?? ''), brief(held))
  check('...not one row of it was stored', rowsFor(H) === 0, `rows ${rowsFor(H)}`)
  check('...it was not remembered as imported', sourceLine(H) === '', `[${sourceLine(H)}]`)
  check('...no stage table is left behind', stageTableCount() === 0, `tables ${stageTableCount()}`)
  check('...the file waits in inbox/held', inboxLs('held').includes(H), inboxLs('held').join(','))

  const status = await api('GET', '/api/inbox/status')
  const entry = (status.json?.held ?? []).find((f: any) => f.name === H)
  check('the Inbox status lists it with the report of the hold', !!entry && entry.report?.level === 'hold' && entry.report?.junkPct >= 4.9 && entry.report?.kinds?.['password-has-scheme'] === 1_200, JSON.stringify(entry?.report ?? null).slice(0, 200))
  const health = await api('GET', '/api/monitoring/ingest-health')
  check('Ingest Health counts it', (health.json?.held?.count ?? 0) >= 1, JSON.stringify(health.json?.held))

  const released = await api('POST', '/api/inbox/release', { filename: H })
  check('Release moves the file back to the inbox', released.status === 200 && released.json?.moved?.[0] === H, JSON.stringify(released.json))
  const done = await waitFor(async () => {
    const s = await api('GET', '/api/inbox/status')
    return (s.json?.done_recent ?? []).find((j: any) => j.filename === H && j.status === 'done')
  }, 240_000, 2000)
  check('the released file is imported: 24000 new rows, none known', !!done && done.imported === 24_000 && done.known === 0, JSON.stringify(done ?? null))
  check('...with the gate verdict recorded as a hold that was released', !!done && done.gate_level === 'hold', JSON.stringify(done?.gate_level))
  check('...all 24000 rows are in ClickHouse', rowsFor(H) === 24_000, `rows ${rowsFor(H)}`)
  check('...and the file left inbox/held', !inboxLs('held').includes(H))

  const audit = await api('GET', '/api/audit-logs?action=inbox.release&limit=5')
  check('the audit log has the release', JSON.stringify(audit.json ?? {}).includes(H), JSON.stringify(audit.json ?? {}).slice(0, 160))

  const again = await importLines(H, body)
  check('the same name again is skipped by the duplicate guard, not held again', again.status === 'done' && again.imported === 0, brief(again))
  scanLog('after the quality-gate scenario')
}

async function archiveRef(): Promise<void> {
  console.log('\n10. An import from the source archive through an .archiveref')
  scanLog('before the archive-ref scenario')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const PLAIN = `e2e-ar-plain-${RUN}.txt`
  const FROM = `e2e-ar-arch-${RUN}.txt`
  const OTHER = `e2e-ar-other-${RUN}.txt`
  const DAMAGED = `e2e-ar-bad-${RUN}.txt`
  const same = lines('R', 0, 30_000)

  const plain = await importLines(PLAIN, same)
  check('the file as plain text: 30000 new', plain.status === 'done' && plain.imported === 30_000 && plain.known === 0, brief(plain))

  // The real archive tool, on the host, without ClickHouse and without --replace.
  const srcDir = join(work, 'ar-src')
  const archiveDir = join(work, 'ar-archive')
  mkdirSync(srcDir)
  mkdirSync(archiveDir)
  // The archive tool leaves a file modified in the last 10 minutes alone (it may still be downloading): make the fixtures an hour old.
  const hourAgo = new Date(Date.now() - 3_600_000)
  const putOld = (name: string, ls: string[]) => { writeFileSync(join(srcDir, name), text(ls)); utimesSync(join(srcDir, name), hourAgo, hourAgo) }
  putOld(FROM, same)
  putOld(OTHER, lines('V', 0, 30_000))
  putOld(DAMAGED, lines('T', 0, 5_000))
  sh('npx', ['tsx', 'scripts/archive-sources.ts', 'archive', '--src', srcDir, '--out', archiveDir, '--workers', '1', '--no-sources'])
  const manifest = new Map<string, any>(readFileSync(join(archiveDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).map((e: any) => [e.name, e]))
  check('the archive tool archived the three files', manifest.size === 3, String(manifest.size))

  sh('docker', ['exec', APP, 'rm', '-rf', '/archive'])
  sh('docker', ['cp', archiveDir, `${APP}:/archive`])
  const ref = (e: any) => JSON.stringify({ v: 1, id: e.id, name: e.name, size: e.size, sha256: e.sha256 }) + '\n'
  const drop = (e: any) => sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${e.name}.archiveref`], process.env, ref(e))
  const finished = (name: string) => waitFor(async () => {
    const s = await api('GET', '/api/inbox/status')
    return (s.json?.done_recent ?? []).find((j: any) => j.filename === `${name}.archiveref`)
  }, 240_000, 2000)

  drop(manifest.get(FROM))
  const a = await finished(FROM)
  check('the same content through an .archiveref: every row was already known (the archive yields the same bytes)', !!a && a.status === 'done' && a.imported === 0 && a.known === 30_000, JSON.stringify(a ?? null))
  check('...ulp.sources has the original name with the size, the sha256 and the archive id', chQuery(`SELECT concat(toString(size), '|', sha256, '|', archive_id) FROM ulp.sources WHERE filename = '${FROM}'`) === `${manifest.get(FROM).size}|${manifest.get(FROM).sha256}|${manifest.get(FROM).id}`)
  check('...the inbox holds the reference and no plaintext copy', inboxLs('done').includes(`${FROM}.archiveref`) && !inboxLs('done').includes(FROM) && !inboxLs('').includes(FROM))

  drop(manifest.get(FROM))
  const b = await waitFor(async () => {
    const s = await api('GET', '/api/inbox/status')
    return (s.json?.done_recent ?? []).filter((j: any) => j.filename === `${FROM}.archiveref`).length >= 2
  }, 120_000, 2000)
  check('the same name with the same content again is skipped', !!b)

  drop(manifest.get(OTHER))
  const o = await finished(OTHER)
  check('another file through the archive: 30000 new rows', !!o && o.status === 'done' && o.imported === 30_000 && rowsFor(OTHER) === 30_000, JSON.stringify(o ?? null))

  // A same-name file with other content is a new file: archive different content (another size, so the tool archives it again) under the first name and import it.
  putOld(FROM, lines('U', 0, 10_000))
  sh('npx', ['tsx', 'scripts/archive-sources.ts', 'archive', '--src', srcDir, '--out', archiveDir, '--workers', '1', '--no-sources', '--only', FROM])
  const changed = readFileSync(join(archiveDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((e: any) => e.name === FROM).pop()
  sh('docker', ['exec', APP, 'rm', '-rf', '/archive'])
  sh('docker', ['cp', archiveDir, `${APP}:/archive`])
  check('the changed file has another content id', changed.id !== manifest.get(FROM).id)
  const before = Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${FROM}'`))
  drop(changed)
  const c = await waitFor(async () => Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${FROM}'`)) > before, 240_000, 2000)
  check('a same-name file with other content is a new file: imported, a second row in ulp.sources', !!c && rowsFor(FROM) === 10_000, `rows ${rowsFor(FROM)}`)

  // A damaged archive fails before one row is committed.
  const bad = manifest.get(DAMAGED)
  sh('docker', ['exec', APP, 'sh', '-c', `printf '\\377' | dd of=/archive/${bad.id}.zst bs=1 seek=40 conv=notrunc 2>/dev/null`])
  drop(bad)
  const d = await finished(DAMAGED)
  check('a damaged archive fails the job', !!d && d.status === 'failed', JSON.stringify(d ?? null))
  check('...not one row of it was committed, and no stage table is left', rowsFor(DAMAGED) === 0 && stageTableCount() === 0, `rows ${rowsFor(DAMAGED)}, tables ${stageTableCount()}`)
  check('...the reference waits in inbox/failed', inboxLs('failed').includes(`${DAMAGED}.archiveref`))
  scanLog('after the archive-ref scenario')
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
async function sameName(): Promise<void> {
  console.log('\n8. A used name with another size (the same-name check compares size) and the job log')
  const N = `e2e-nov-same-${RUN}.txt`
  const first = lines('SN', 0, 1_000)
  const a = await importLines(N, first)
  check('the first file of that name: 1000 new', a.status === 'done' && a.imported === 1_000 && a.known === 0, brief(a))
  const sizeA = Buffer.byteLength(text(first))
  check('...ulp.sources remembers its name and its size', chQuery(`SELECT size FROM ulp.sources WHERE filename = '${N}'`) === String(sizeA), `[${chQuery(`SELECT size FROM ulp.sources WHERE filename = '${N}'`)}] vs ${sizeA}`)

  const again = await importLines(N, first)
  check('the same file again (same name, same size) is skipped: nothing imported, nothing read', again.status === 'done' && again.imported === 0 && again.known === 0, brief(again))
  check('...and it did not add a second ulp.sources row', Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${N}'`)) === 1)

  const more = [...first, ...lines('SN', 1_000, 1_500)]
  const b = await importLines(N, more)
  check('another file under that name (500 more lines, another size) is imported: 500 new, 1000 known', b.status === 'done' && b.imported === 500 && b.known === 1_000, brief(b))
  check('...it has its own ulp.sources row, with its own size', chQuery(`SELECT arrayStringConcat(arraySort(groupArray(toString(size))), ',') FROM ulp.sources WHERE filename = '${N}'`)
    === [sizeA, Buffer.byteLength(text(more))].sort().join(','), chQuery(`SELECT groupArray(size) FROM ulp.sources WHERE filename = '${N}'`))
  check('...and 1500 rows are stored for the name, each once', rowsFor(N) === 1_500 && distinctFor(N) === 1_500, `rows ${rowsFor(N)}, distinct ${distinctFor(N)}`)
  const b2 = await importLines(N, more)
  check('that second file is skipped when it is uploaded again', b2.status === 'done' && b2.imported === 0 && b2.known === 0, brief(b2))

  const R = `e2e-nov-repeats-${RUN}.txt`
  const rep = lines('RP', 0, 100)
  await importLines(R, [...rep, ...rep])
  const recent = ((await api('GET', '/api/upload/queue-status')).json?.recent ?? []) as Array<{ filename: string; imported: number; repeats: number | null; note: string | null }>
  const jobsOf = (name: string) => recent.filter(r => r.filename === name)
  check('the job log labels the two skips of that name "already-imported" and no import', jobsOf(N).filter(r => r.note === 'already-imported').length === 2 && jobsOf(N).filter(r => r.note === null && r.imported > 0).length === 2,
    JSON.stringify(jobsOf(N).map(r => [r.imported, r.note])))
  check('...and records the rows repeated inside a file (100 here), and 0 for a skip', jobsOf(R)[0]?.repeats === 100 && jobsOf(N).every(r => r.repeats === 0), JSON.stringify([jobsOf(R)[0]?.repeats, jobsOf(N).map(r => r.repeats)]))
  check('no stage table is left', stageTableCount() === 0)
}

/** The rows of the Inbox job list for a file, newest first. */
async function inboxJobs(name: string): Promise<Array<{ status: string; imported: number; known: number; repeats: number | null; note: string | null }>> {
  return (((await api('GET', '/api/inbox/status')).json?.done_recent ?? []) as Array<{ filename: string; status: string; imported: number; known: number; repeats: number | null; note: string | null }>)
    .filter(r => r.filename === name)
}

async function hardLinkedNames(): Promise<void> {
  console.log('\n9. A finished file put back into the inbox as a second name of itself (rename(2) between two names of one file does nothing)')
  const N = `e2e-nov-link-${RUN}.txt`
  const inApp = (cmd: string) => sh('docker', ['exec', APP, 'sh', '-c', cmd])
  sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${N}`], process.env, text(lines('LK', 0, 2_000)))
  const first = await waitFor(async () => (await inboxJobs(N))[0], 120_000, 1000)
  check('the file dropped in the inbox is imported: 2000 new', !!first && first.status === 'done' && first.imported === 2_000, JSON.stringify(first))
  check('...and it ends in done/ only', inApp(`ls /app/inbox/done/${N} 2>/dev/null; ls /app/inbox/processing /app/inbox | grep -c "${N}" || true`).split('\n').pop() === '0')

  // like an owner who moves a finished file back with a hard link: done/ keeps the file, the inbox gets a second name of the same file
  inApp(`ln /app/inbox/done/${N} /app/inbox/${N}`)
  const second = await waitFor(async () => ((await inboxJobs(N)).length >= 2 ? (await inboxJobs(N))[0] : null), 120_000, 1000)
  check('the second pass is skipped by the same-name check and labelled', !!second && second.status === 'done' && second.imported === 0 && second.note === 'already-imported', JSON.stringify(second))
  const left = inApp(`ls /app/inbox/processing | grep -c "${N}" || true`)
  const inbox = inApp(`ls /app/inbox | grep -c "${N}" || true`)
  const links = inApp(`stat -c %h /app/inbox/done/${N}`)
  check('nothing is left in processing/ or in the inbox, and done/ holds the file under one name', left === '0' && inbox === '0' && links === '1', `processing ${left}, inbox ${inbox}, links ${links}`)
  check('...and the rows are still in ClickHouse once', rowsFor(N) === 2_000, `rows ${rowsFor(N)}`)
}

interface CardSample { poll: number; t: number; filename: string; phase: string | null; pct: number | null; bytes_read: number | null; file_size_bytes: number; est_total_rows: number | null; eta_ms: number | null; rows_staged: number }

async function progressCards(): Promise<void> {
  console.log('\n10. The progress cards of two inbox files imported at once (UPLOAD_CONCURRENCY=2), short lines and long ones')
  scanLog('before the progress scenario')
  if (!check('the rehearsal app restarted with concurrency 2', await recreateApp({ concurrency: '2' }))) return
  const SHORT = `e2e-nov-prog-short-${RUN}.txt`
  const LONG = `e2e-nov-prog-long-${RUN}.txt`
  const ROWS = 500_000
  const pad = 'x'.repeat(90)
  const shortLines = Array.from({ length: ROWS }, (_, i) => `https://s.test/:Ps${RUN}x${i}@m.test:Pw-${RUN}x${i}`)
  const longLines = Array.from({ length: ROWS }, (_, i) => `https://shop${i % 500}.example-store.test/account/login/${pad}:Pl${RUN}x${i}@probe-mail.test:Pw-${RUN}x${i}-Xy!`)
  // Both files are written first (next to the inbox, on the same volume) and then moved in together, so the watcher finds them in the same scan and the two imports overlap.
  const stage = (name: string, ls: string[]) => sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/done/.tmp-${name}`], process.env, text(ls))
  stage(SHORT, shortLines)
  stage(LONG, longLines)
  sh('docker', ['exec', APP, 'sh', '-c', `mv /app/inbox/done/.tmp-${SHORT} /app/inbox/${SHORT} && mv /app/inbox/done/.tmp-${LONG} /app/inbox/${LONG}`])

  const samples: CardSample[] = []
  const end = Date.now() + 240_000
  let finished = false
  let poll = 0
  while (Date.now() < end && !finished) {
    const json = (await api('GET', '/api/inbox/status')).json
    poll++
    for (const c of (json?.jobs_progress ?? []) as Array<Record<string, any>>) {
      samples.push({ poll, t: Date.now(), filename: c.filename, phase: c.phase, pct: c.pct, bytes_read: c.bytes_read, file_size_bytes: c.file_size_bytes, est_total_rows: c.est_total_rows, eta_ms: c.eta_ms, rows_staged: c.rows_staged })
    }
    const done = ((json?.done_recent ?? []) as Array<{ filename: string; status: string }>).filter(r => [SHORT, LONG].includes(r.filename) && r.status === 'done').length
    finished = done >= 2
    if (!finished) await sleep(200)
  }
  check('both files were imported', finished)
  const by = (name: string) => samples.filter(x => x.filename === name)
  const together = new Map<number, Set<string>>()
  for (const x of samples) together.set(x.poll, (together.get(x.poll) ?? new Set()).add(x.filename))
  check('the status endpoint listed both files in flight in the same answer', [...together.values()].some(set => set.size === 2), `samples ${samples.length}`)
  check('...and every line of both files was imported (500000 rows each)', rowsFor(SHORT) === ROWS && rowsFor(LONG) === ROWS, `short ${rowsFor(SHORT)}, long ${rowsFor(LONG)}`)
  for (const [label, name] of [['short', SHORT], ['long', LONG]] as const) {
    const reading = by(name).filter(x => x.phase === 'parsing' && x.bytes_read !== null && x.bytes_read > 0)
    check(`${label} lines: the card showed the bytes read while the file was read (${reading.length} samples)`, reading.length >= 3)
    const inside = reading.filter(x => x.pct !== null && x.pct > 0 && x.pct < 99)
    check(`${label} lines: the share read in the card follows the bytes read (within a point)`,
      inside.length >= 2 && inside.every(x => Math.abs((x.pct as number) - Math.floor((x.bytes_read as number) / x.file_size_bytes * 100)) <= 1), JSON.stringify(inside.slice(0, 3)))
    check(`${label} lines: the share read never goes back`, reading.every((x, i) => i === 0 || (x.pct ?? 0) >= (reading[i - 1].pct ?? 0)))
    // The rows staged trail the bytes read by the batches in flight: the parser works one batch ahead of the insert (UPLOAD_BATCH_SIZE, 100,000 rows each), so
    // rows_staged is between (share read x rows) - 2 batches and (share read x rows), and the estimate rows_staged / share read is between rows - 2 batches / share
    // and rows. For the 5 batches of these files that is a lot (it is why this holds the estimate to its design, not to a percentage); for a 74-million-row file
    // 2 batches / 40% is 0.7%.
    const BATCH = 100_000
    const real = rowsFor(name)
    const late = reading.filter(x => (x.pct ?? 0) >= 40 && x.est_total_rows)
    const share = (x: CardSample) => (x.bytes_read as number) / x.file_size_bytes
    const worst = late.reduce((m, x) => Math.max(m, Math.abs((x.est_total_rows as number) - real) / real), 0)
    const guess = reading[0] ? Math.abs(Math.round(reading[0].file_size_bytes / 80) - real) / real : NaN   // what the old card assumed, for the report
    check(`${label} lines: past 40% read the estimated total never exceeds the real ${real} rows and trails it by at most the batches in flight`,
      late.length >= 1 && late.every(x => (x.est_total_rows as number) <= real * 1.02 && (x.est_total_rows as number) >= real - (2.2 * BATCH) / share(x)),
      `samples ${late.length}, worst ${(worst * 100).toFixed(1)}%`)
    info(`${label} lines: the estimate was off by at most ${(worst * 100).toFixed(0)}% on this ${(real / BATCH).toFixed(0)}-batch file; the old 80-bytes-a-line estimate would have been off by`, `${(guess * 100).toFixed(0)}%`)
    const etas = late.filter(x => x.eta_ms !== null)
    check(`${label} lines: past 40% read the time left is never negative and does not grow (${etas.length} samples)`,
      etas.length >= 2 && etas.every(x => (x.eta_ms as number) >= 0) && (etas[etas.length - 1].eta_ms as number) <= (etas[0].eta_ms as number))
  }
  const lastShort = Math.max(...by(SHORT).map(x => x.t), 0)
  const lastLong = Math.max(...by(LONG).map(x => x.t), 0)
  const earlier = lastShort < lastLong ? SHORT : LONG
  const later = earlier === SHORT ? LONG : SHORT
  const afterEarlier = by(later).filter(x => x.t > Math.max(...by(earlier).map(y => y.t)))
  check(`when ${earlier === SHORT ? 'the short' : 'the long'} file finished the other kept its card (${afterEarlier.length} samples after)`, afterEarlier.length >= 1)
  const idle = (await api('GET', '/api/inbox/status')).json
  check('...and when both are done the endpoint lists no file in flight', (idle?.jobs_progress ?? []).length === 0 && idle?.current_progress === null)
  check('no stage table is left', stageTableCount() === 0)
}

async function doneRetention(): Promise<void> {
  console.log('\n11. inbox/done is pruned at start-up by the age of the import, and only for files the source archive holds')
  scanLog('before the retention scenario')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const OLD_ARCH = `e2e-ret-old-archived-${RUN}.txt`
  const OLD_PLAIN = `e2e-ret-old-unarchived-${RUN}.txt`
  const NEW_ARCH = `e2e-ret-new-archived-${RUN}.txt`
  const VIA_REF = `e2e-ret-ref-${RUN}.txt`
  const NO_JOB = `e2e-ret-nojob-${RUN}.txt`
  const body = (tag: string) => text(lines(tag, 0, 200))

  // The real archive tool, on the host, for every file but OLD_PLAIN. (It leaves a file modified in the last 10 minutes alone: the fixtures are an hour old.)
  const srcDir = join(work, 'ret-src')
  const archiveDir = join(work, 'ret-archive')
  mkdirSync(srcDir)
  mkdirSync(archiveDir)
  const hourAgo = new Date(Date.now() - 3_600_000)
  const bodies = new Map<string, string>()
  for (const [name, tag] of [[OLD_ARCH, 'Ra'], [NEW_ARCH, 'Rb'], [VIA_REF, 'Rc'], [NO_JOB, 'Rd'], [OLD_PLAIN, 'Re']] as const) {
    bodies.set(name, body(tag))
    if (name === OLD_PLAIN) continue
    writeFileSync(join(srcDir, name), bodies.get(name) as string)
    utimesSync(join(srcDir, name), hourAgo, hourAgo)
  }
  sh('npx', ['tsx', 'scripts/archive-sources.ts', 'archive', '--src', srcDir, '--out', archiveDir, '--workers', '1', '--no-sources'])
  const manifest = new Map<string, any>(readFileSync(join(archiveDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).map((e: any) => [e.name, e]))
  check('the archive tool archived four of the five files', manifest.size === 4 && !manifest.has(OLD_PLAIN), String(manifest.size))
  sh('docker', ['exec', APP, 'rm', '-rf', '/archive'])
  sh('docker', ['cp', archiveDir, `${APP}:/archive`]) // /archive lives in the container's own layer: it survives `docker restart`, not a recreate

  // Inside the container: the files in done/ with their own date 40 days back, and the job log rows (UTC) of an import 8 days ago, or yesterday, or none.
  const ref = (e: any) => JSON.stringify({ v: 1, id: e.id, name: e.name, size: e.size, sha256: e.sha256 }) + '\n'
  const spec = [
    { name: OLD_ARCH, text: bodies.get(OLD_ARCH), jobDaysAgo: 8 },
    { name: OLD_PLAIN, text: bodies.get(OLD_PLAIN), jobDaysAgo: 8 },
    { name: NEW_ARCH, text: bodies.get(NEW_ARCH), jobDaysAgo: 1 },
    { name: `${VIA_REF}.archiveref`, text: ref(manifest.get(VIA_REF)), jobDaysAgo: 8 },
    { name: NO_JOB, text: bodies.get(NO_JOB), jobDaysAgo: null },
  ]
  sh('docker', ['exec', '-i', APP, 'node', '-e', `
    const fs = require('fs'); const Database = require('better-sqlite3');
    const spec = JSON.parse(fs.readFileSync(0, 'utf8'));
    const db = new Database('/app/data/ulp.db');
    const old = new Date(Date.now() - 40 * 86400000);
    for (const f of spec) {
      const p = '/app/inbox/done/' + f.name;
      fs.writeFileSync(p, f.text); fs.utimesSync(p, old, old);
      if (f.jobDaysAgo !== null) db.prepare("INSERT INTO processing_jobs (source, filename, status, imported, skipped, duration_ms, created_at) VALUES ('inbox', ?, 'done', 1, 0, 1, datetime('now', ?))").run(f.name, '-' + f.jobDaysAgo + ' days');
    }
    db.close();`], process.env, JSON.stringify(spec))
  check('five files sit in done/, every one with its own date 40 days back', spec.every(f => inboxLs('done').includes(f.name)))

  sh('docker', ['restart', APP])
  const up = await waitFor(() => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000, 2000)
  if (!check('the app restarted', !!up)) return
  await login()
  const left = inboxLs('done')
  check('an archived file imported 8 days ago is gone', !left.includes(OLD_ARCH), left.join(', '))
  check('...so is an .archiveref imported 8 days ago whose archive file exists', !left.includes(`${VIA_REF}.archiveref`))
  check('a file imported 8 days ago that the archive does NOT hold stays (the only copy)', left.includes(OLD_PLAIN))
  check('an archived file imported yesterday stays although the file itself is 40 days old', left.includes(NEW_ARCH))
  check('a file the job log never imported stays', left.includes(NO_JOB))
  const log = appLog()
  check('the app log says what was deleted', log.includes(`cleanup: deleted ${OLD_ARCH} from done/`))
  check('...and how many files wait for the archive', /cleanup: kept \d+ file\(s\), [\d.]+ GiB, in done\/ that were imported over 7 days ago but are not in the source archive/.test(log))
  check('...and it did not delete the unarchived file or the one imported yesterday', !log.includes(`deleted ${OLD_PLAIN}`) && !log.includes(`deleted ${NEW_ARCH}`))

  // leave the stack as the other scenarios expect it
  sh('docker', ['exec', APP, 'sh', '-c', `rm -rf /archive; rm -f ${[OLD_ARCH, OLD_PLAIN, NEW_ARCH, `${VIA_REF}.archiveref`, NO_JOB].map(n => `'/app/inbox/done/${n}'`).join(' ')}`])
  scanLog('after the retention scenario')
}

async function run(): Promise<number> {
  // The receiver runs the app image's node with its own entrypoint, so the image's health check (port 3000) always calls it
  // unhealthy: for it, running is what matters.
  const ready: Array<[string, string, string]> = [
    [APP, '{{.State.Health.Status}}', 'healthy'],
    [CH, '{{.State.Health.Status}}', 'healthy'],
    [RECEIVER, '{{.State.Running}}', 'true'],
  ]
  for (const [container, format, want] of ready) {
    let state = ''
    try {
      state = sh('docker', ['inspect', '-f', format, container])
    } catch {
      /* missing */
    }
    if (state !== want) {
      console.error(`${container} is not ready (${state || 'missing'}). Start the rehearsal stack first:\n  npx tsx scripts/e2e-alert-rehearsal.ts --keep`)
      return 2
    }
  }
  secrets = {
    jwt: sh('docker', ['exec', APP, 'printenv', 'JWT_SECRET']),
    email: sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL']),
    password: sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD']),
  }
  scanLog('at the start')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return 1
  const probe = await api('GET', '/api/inbox/status')
  if (!check('the inbox status endpoint answers (the image is current: `docker compose build app`)', probe.status === 200, `HTTP ${probe.status}`)) return 2

  if (want('basic')) await basic()
  if (want('tags')) await telegramTags()
  if (want('positional')) await positionalRecords()
  if (want('v6')) await parserV6()
  if (want('pipes')) await parserV61()
  if (want('monitor')) await monitorScenario()
  if (want('big')) await bigFile()
  if (want('kill')) await killMidCommit()
  if (want('freeze')) await freezeDuringCommit()
  if (want('concurrent')) await concurrentFiles()
  if (want('gate') && !skipGate && !(await gateScenario())) return 2
  if (want('off')) await directPath()
  if (want('quality-gate')) await qualityGate()
  if (want('archive-ref')) await archiveRef()
  if (want('same-name')) await sameName()
  if (want('link')) await hardLinkedNames()
  if (want('progress')) await progressCards()
  if (want('retention')) await doneRetention()

  scanLog('at the end')
  await recreateApp() // leave the stack on the production defaults
  return 0
}

async function main(): Promise<number> {
  process.on('SIGINT', () => {
    try {
      sh('docker', ['exec', CH, 'rm', '-f', FILLER])
    } catch {
      /* nothing to remove */
    }
    process.exit(130)
  })
  let code = 1
  try {
    code = await run()
  } catch (err) {
    check('the scenarios ran without an unexpected error', false, err instanceof Error ? err.message : String(err))
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(dockerCfg, { recursive: true, force: true })
  }
  if (code === 2) return 2
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  return failed.length === 0 && code === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(2)
  },
)
