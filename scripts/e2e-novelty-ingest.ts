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
 *               in that order, and "http://url login:password" (one space) is read as url, login, password
 *   monitor     a monitor alerts for rows that are new to the database, not for a row the database already held
 *   big         2.5M distinct lines + 100k repeats of early lines (past the old 2M in-file cap): exact, in 5 slabs, phases visible
 *   kill        the app is killed in the middle of the commit; after the restart the orphan stage tables are gone and a retry
 *               adds exactly the rows that were missing (no duplicates)
 *   freeze      ClickHouse is frozen for 45 s in the middle of the commit (longer than the 30 s stall timeout): the watchdog fails
 *               the job, nothing of the failed import is left running on the server, the queue is free, and a retry adds only the rest
 *   concurrent  UPLOAD_CONCURRENCY=2, two files that share 30,000 rows: written once
 *   gate        free disk under the ingest floor while staging: the import waits (its stage exists), resumes, writes each row once
 *   off         INGEST_NOVELTY_CHECK=off: the direct path, no stage tables, rows stored again as before
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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    // a credential line the field split cannot take (a "/" in the password): it is rejected, and the two real lines after it are kept
    `https://shop1.example-store.test:posA${RUN}:Pass/${RUN}`,
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
  ]
  const p = await importLines(P, ls)
  check('a file with a rejected URL line, a genuine block record, a stray-scheme pair, a url-last line and a url-space line: 7 credentials are new, none known', p.status === 'done' && p.imported === 7 && p.known === 0, brief(p))
  check('...the rejected line is the only one skipped, 7 rows are stored', p.skipped === 1 && rowsFor(P) === 7, `skipped ${p.skipped}, rows ${rowsFor(P)}`)
  const stored = chQuery(`SELECT arrayStringConcat(arraySort(groupArray(email)), ',') FROM ulp.credentials WHERE source_file = '${P}'`)
  const expected = [`posB${RUN}`, `posC${RUN}`, `posD${RUN}@probe-mail.test`, `posE${RUN}`, `posF${RUN}@probe-mail.test`, `posG${RUN}`, `posH${RUN}`].sort().join(',')
  check('...the two lines after the rejected one are their own credentials, the block record is one, the pair keeps its e-mail: no merged row', stored === expected, `${stored} vs ${expected}`)
  const noUrl = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posF${RUN}@probe-mail.test' AND url = '' AND domain = 'probe-mail.test'`))
  check('...the stray-scheme pair is stored with no url and its e-mail domain', noUrl === 1, `rows ${noUrl}`)
  const urlLast = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posG${RUN}' AND url = 'https://shop7.example-store.test/login' AND domain = 'shop7.example-store.test'`))
  check('...the url-last line is stored with its url, its login and its domain', urlLast === 1, `rows ${urlLast}`)
  const urlSpace = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND email = 'posH${RUN}' AND url = 'http://shop8.example-store.test/login' AND domain = 'shop8.example-store.test'`))
  check('...the url-space line is stored with its url, its login and its domain', urlSpace === 1, `rows ${urlSpace}`)
  const merged = Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND position(email, '://') > 0`))
  check('...no stored login holds a whole line', merged === 0, `rows ${merged}`)
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

// ── main ────────────────────────────────────────────────────────────────────────────────────────
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
  if (want('monitor')) await monitorScenario()
  if (want('big')) await bigFile()
  if (want('kill')) await killMidCommit()
  if (want('freeze')) await freezeDuringCommit()
  if (want('concurrent')) await concurrentFiles()
  if (want('gate') && !skipGate && !(await gateScenario())) return 2
  if (want('off')) await directPath()

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
