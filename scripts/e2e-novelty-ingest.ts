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
 *   v62         parser v6.2: a colon in front of the scheme, "login;password:url" (the url last, with a ':' or a ';' before it), a labelled pair behind a pipe ("host/|Username:login:Password:pass"),
 *               a url inside a url, lines that carry no credential (a banner, a divider, a bare url with one field) and the layouts that must not move
 *   v63         parser v6.3: a CRLF file with a blank line after every record, three of the records signed with a promotional tail (stored with the real password, the tail cut), two bare urls
 *               that a blank line closes (counted as skipped: every line of the file is in a counter), and a file of 0 bytes dropped in the inbox (recorded with the note "empty-file")
 *   v64         parser v6.4: "login:password url" (the credential first, one or more spaces, the url last), with an e-mail login, no path, a port and a url inside a url; the url-first mirror
 *               that the parser already read, the lines that stay rejected (a login with a slash, a label before a Telegram link, an empty password, a password with a space, a scheme
 *               other than http and https) and the layouts that must not move
 *   groups      INGEST_NOVELTY_CHECK_GROUP: two files at once, 14 slabs each (3,000-row slabs), share 30,000 rows; the grouped check (4) and the check slab by slab (1) write the same rows
 *               (the shared ones once), and ClickHouse's query log shows the grouped check sent 4 fills per file instead of 14
 *   v65         parser v6.5: "url:(copy of the site):login:password" (a parenthesised copy of the url's host between the url and the credential), with a scheme and www., an e-mail login and a
 *               colon in the password; the shapes that stay as they were (a number in parentheses, a label that is not the host, no copy)
 *   v66         parser v6.6: an Android app id behind a stray "https://" (a username login, an e-mail login, repeats of one account under two app ids), a host written with its trailing
 *               dot, an underscore in a label in front of the last one; the shapes that stay rejected (an Android package name or a file name as a host, a host without a dot)
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
 *                 once, and the audit row exists; a file where 1 line in 9 is a banner or a divider is NOT held (those lines cannot hold a credential); a file past 8 MiB
 *                 that breaks a rule on 1 line in 10 is held by the sample check before the import starts (report phase "sample"); a file where 1 line in 9 cannot be split is held and its
 *                 report lists the masked shape of those lines (no value in it). (The disk gate's scenario is called "gate".)
 *   archive-ref   a file imported from the source archive through an .archiveref: same counts as the plain import, identity in ulp.sources, a same-name file with other
 *                 content is a new file, a damaged archive fails before one row is committed, and no plaintext copy of the file appears in the inbox
 *   ledger        the file ledger (docs/superpowers/specs/2026-11-07-file-ledger-design.md): DDL v31 has parser_revision; a file is hashed and recorded with its hash, size and revision at once; the
 *                 same bytes under another name are skipped (job note "same-content", no row, no credential) while the parser that imported them is current; a name with "refeed" in it, and
 *                 bytes an older parser imported, are imported again (known, not skipped) and recorded at the current revision, after which a further copy is skipped; a file that yields no
 *                 credential is remembered with 0 lines (a re-drop is skipped by name, a copy by content); the inbox watcher labels the skip; the plain-text copy (scripts/ledger-export.ts)
 *                 lists the rows; scripts/ledger-backfill.ts sets revision 0 rows by the time they were written, in a dry run first
 *   same-name     the same-name check compares size (and the content hash, once ulp.sources holds one for the name): the same file again is skipped (and the job log says so), another file under that name is imported and gets its
 *                 own ulp.sources row; the job log records the rows repeated inside a file
 *   link          a finished file put back into the inbox as a second hard-linked name of itself: the second pass is skipped and labelled, and nothing is stranded in
 *                 processing/ (rename(2) between two names of one file does nothing), on the real inbox volume
 *   progress      two inbox files at once (UPLOAD_CONCURRENCY=2), one with short lines and one with long ones: the status endpoint lists both, each share read
 *                 follows the bytes read and not an assumed line length, the estimated total converges on the real one, and one file finishing leaves the other's card
 *   retention     inbox/done at start-up: a file imported over 7 days ago is removed only when the source archive holds it (a real archive, an .archiveref, a restart); a
 *                 file the archive does not hold, one imported yesterday although its own date is 40 days old, and one the job log never imported all stay
 *   golden        the normalised key on the edge cases of docs/superpowers/specs/2026-11-01-near-duplicates-design.md, computed by ClickHouse itself: the host part and the rest of 13
 *                 URLs, and how many distinct keys five spellings of one credential and six different credentials give (the exact key tells the five apart)
 *   lookalikes    look-alikes (www., scheme, host case, slashes, login case) against the exact key (INGEST_NORM_KEY=off: all stored) and the normalised key (known, not stored);
 *                 look-alikes inside one file count as repeats; a path or a password that differs stays a different credential; the monitor alerts with the row that was stored;
 *                 each job records its key; the per-file recount (scripts/pile/verify-file.ts) agrees with the job for both keys
 *   norm-not-ready  the column dropped and added again (existing parts lack it): the import keeps the exact key and says so; after MATERIALIZE COLUMN the next one matches on the normalised key
 *   workers       INGEST_PARSE_WORKERS=2: a small file is staged on the importer's thread and a big one (over 16 MiB) by a worker thread, with the counts the construction gives
 *                 (new, known, repeats inside the file, skipped); a big file whose first 52,000 lines break a rule is held by the worker's early check (nothing stored, no stage table);
 *                 and with the workers off, the same content under another name finds every row already known and counts the same repeats and skipped lines
 *   retry         a file the run lost goes back to the inbox once, on its own (lib/inbox-auto-retry.ts): ClickHouse frozen past the stall timeout in the middle of an inbox file's commit,
 *                 the job is logged as failed with the retry note, the file waits in failed/ and returns after about 2 minutes, and the retry adds exactly the missing rows; a
 *                 second loss of the same file stays in failed/ (waited out for longer than the delay) until the owner retries it; an app killed in the middle of an inbox
 *                 file's commit finds the file in processing/ at start-up and sends it back once
 *
 *   docker compose build app                   # or REHEARSAL_APP_IMAGE=<tag> for a candidate: export it for the alert rehearsal AND for this script (the script stops with exit 2 when they differ)
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-novelty-ingest.ts            # about 15 minutes; --only=kill,off runs just those; --skip-gate leaves out the filler
 *   REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x \
 *     docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v   # the compose file wants these set even to stop the stack
 *
 * Needs `zip` and `curl`, and about 40 GiB of free host disk for the gate scenario. Exit 0 when every check passes, 1 when one
 * fails, 2 when the stack is not ready or there is not enough room to run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NORM_CONTENT_KEY, exactKeySql, normHostSql, normKeySql, normRestSql } from '../lib/url-content-key'
import { assertRehearsalImage } from './rehearsal-image'

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
const distinctNormFor = (...names: string[]) => Number(chQuery(`SELECT uniqExact(norm_key_hash) FROM ulp.credentials WHERE source_file IN (${inList(names)})`))
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

interface AppSettings { concurrency?: string; novelty?: string; slab?: string; group?: string; normKey?: string; floorBytes?: number; workers?: string; earlyLines?: string }

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
    REHEARSAL_INGEST_NOVELTY_CHECK_GROUP: s.group ?? '',
    REHEARSAL_INGEST_NORM_KEY: s.normKey ?? '',
    REHEARSAL_INGEST_PARSE_WORKERS: s.workers ?? '',
    REHEARSAL_INGEST_QUALITY_GATE_EARLY_LINES: s.earlyLines ?? '',
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
  const B = `e2e-nov-b-${RUN} (refeed).txt`   // the same bytes as A on purpose: a name without "refeed" in it would be skipped by the content check (scenario "ledger")
  const C = `e2e-nov-c-${RUN}.txt`
  const D = `e2e-nov-d-${RUN}.txt`

  const a = await importLines(A, lines('A', 0, 20_000))
  check('a new file: 20000 new, none known, none repeated', a.status === 'done' && a.imported === 20_000 && a.known === 0 && a.inFileDuplicates === 0, brief(a))
  check('...all 20000 rows are in ClickHouse', rowsFor(A) === 20_000, `rows ${rowsFor(A)}`)
  check('...the file is remembered in ulp.sources with its 20000 rows', sourceLine(A) === '20000', sourceLine(A))
  check('...and no stage table is left behind', stageTableCount() === 0, `tables ${stageTableCount()}`)

  const b = await importLines(B, lines('A', 0, 20_000))
  check('the same content under a re-feed name: 0 new, 20000 already known', b.status === 'done' && b.imported === 0 && b.known === 20_000, brief(b))
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

async function parserV62(): Promise<void> {
  console.log('\n1f. Parser v6.2: a colon in front of the scheme, a url last behind a semicolon, a labelled pair behind a pipe, a url inside a url')
  const P = `e2e-nov-v62-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const ls = [
    `:https://shopj1.example-store.test/login:v62j1${RUN}@probe-mail.test:${pw('J1')}`,                      // J: a colon in front of the scheme
    `:https://shopj2.example-store.test:8443/login:v62j2${RUN}:${pw('J2')}`,                                  // J: ... a port, a login that is not an e-mail
    `v62k1${RUN};${pw('K1')}:https://shopk1.example-store.test/login`,                                        // K: login;password:url
    `v62k2${RUN}@probe-mail.test;${pw('K2')};https://shopk2.example-store.test:8443/login`,                    // K: ... a ';' before the url, an e-mail login, a port
    `shopl1.example-store.test/|Username:v62l1${RUN}:Password:${pw('L1')}`,                                   // L: host/|Label:login:Label:password
    `https://shopl2.example-store.test/|Login:v62l2${RUN}@probe-mail.test:Password:${pw('L2')}`,              // L: ... with a scheme, an e-mail login
    `https://sso.example-store.test/x?next=https://shopm1.example-store.test/y:v62m1${RUN}:${pw('M1')}`,      // M: a url inside a url
    `https://sso.example-store.test/x?next=https://shopm2.example-store.test:8443/y:v62m2${RUN}:${pw('M2')}`, // M: ... with a port on the inner host
    // lines that carry no credential: rejected
    '\u{1F4B8} Premium access ➜ $50 \u{1F4B0}',
    '█'.repeat(24),
    `https://shopn.example-store.test/login:${pw('N')}`,
    `https://shopo1.example-store.test/login::`,                                                               // a url and an empty field
    `https://shopo2.example-store.test/login::${pw('O2')}`,                                                    // a url, an empty field and one field
    // the layouts that must not move
    `https://shopz1.example-store.test/login:v62z1${RUN}:${pw('Z1')}`,
    `https://shopz2.example-store.test;v62z2${RUN};${pw('Z2')}`,
    `v62z3${RUN}@probe-mail.test:${pw('Z3')}`,
  ]
  const v = await importLines(P, ls)
  check('a file with one line per v6.2 rule, five lines that carry no credential and the layouts that must not move: 11 rows are new, none known', v.status === 'done' && v.imported === 11 && v.known === 0, brief(v))
  check('...the 5 lines without a credential are the only ones skipped, and 11 rows are stored', v.skipped === 5 && rowsFor(P) === 11, `skipped ${v.skipped}, rows ${rowsFor(P)}`)
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND ${where}`))
  check('J: the colon in front of the scheme is gone, and url_scheme and url_host are those of the url',
    one(`url = 'https://shopj1.example-store.test/login' AND email = 'v62j1${RUN}@probe-mail.test' AND password = '${pw('J1')}' AND url_scheme = 'https' AND url_host = 'shopj1.example-store.test'`) === 1
    && one(`url = 'https://shopj2.example-store.test:8443/login' AND email = 'v62j2${RUN}' AND password = '${pw('J2')}' AND url_scheme = 'https'`) === 1)
  check('K: the url that came last is the url, the field in front of the ";" is the login and the next one the password',
    one(`url = 'https://shopk1.example-store.test/login' AND email = 'v62k1${RUN}' AND password = '${pw('K1')}'`) === 1
    && one(`url = 'https://shopk2.example-store.test:8443/login' AND email = 'v62k2${RUN}@probe-mail.test' AND password = '${pw('K2')}'`) === 1)
  check('L: the host (or url) is the url, and the labels are gone from the login and the password',
    one(`url = 'shopl1.example-store.test/' AND email = 'v62l1${RUN}' AND password = '${pw('L1')}'`) === 1
    && one(`url = 'https://shopl2.example-store.test/' AND email = 'v62l2${RUN}@probe-mail.test' AND password = '${pw('L2')}'`) === 1)
  check('M: the url inside the url stays in the url, and the login and the password are the two fields behind it',
    one(`url = 'https://sso.example-store.test/x?next=https://shopm1.example-store.test/y' AND email = 'v62m1${RUN}' AND password = '${pw('M1')}'`) === 1
    && one(`url = 'https://sso.example-store.test/x?next=https://shopm2.example-store.test:8443/y' AND email = 'v62m2${RUN}' AND password = '${pw('M2')}'`) === 1)
  check('the layouts that must not move are stored as before',
    one(`url = 'https://shopz1.example-store.test/login' AND email = 'v62z1${RUN}' AND password = '${pw('Z1')}'`) === 1
    && one(`url = 'https://shopz2.example-store.test' AND email = 'v62z2${RUN}' AND password = '${pw('Z2')}'`) === 1
    && one(`url = '' AND email = 'v62z3${RUN}@probe-mail.test' AND password = '${pw('Z3')}'`) === 1)
  check('no row has a url that starts with a colon, a login that holds a slash or a scheme, or a label as its login',
    one(`(startsWith(url, ':') OR position(email, '/') > 0 OR position(email, '://') > 0 OR email IN ('Username', 'Login'))`) === 0)
}

async function parserV63(): Promise<void> {
  console.log('\n1g. Parser v6.3: a promotional signature at the end of a line, a record that was opened and never finished, a file of 0 bytes')
  const P = `e2e-nov-v63-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const SIG = ' ┃ @probe_channel promo words / more'
  // The shape of the files that showed the defect: CRLF line ends and a blank line after every record.
  const records = [
    `https://shopa1.example-store.test:v63a1${RUN}@probe-mail.test:${pw('A1')}${SIG}`,       // signed, no path: the field split refused such a line
    `https://shopa2.example-store.test/login:v63a2${RUN}@probe-mail.test:${pw('A2')}${SIG}`, // signed, a path: it parsed, with the tail inside the password
    `https://shopa3.example-store.test:8443:v63a3${RUN}:${pw('A3')}${SIG}`,                  // signed, a port and a login that is not an e-mail
    `https://shopb1.example-store.test:v63b1${RUN}@probe-mail.test:${pw('B1')}`,             // not signed: as before
    'https://shopc1.example-store.test/login',                                               // a bare url that the blank line after it closes: counted now
    'https://shopc2.example-store.test/login',
  ]
  const path = join(work, P)
  writeFileSync(path, records.join('\r\n\r\n') + '\r\n\r\n')
  const v = await importPath(P, path)
  check('a CRLF file with a blank line after each of 6 records (3 signed, 1 plain, 2 bare urls): 4 rows are new, none known', v.status === 'done' && v.imported === 4 && v.known === 0, brief(v))
  check('...every line is in a counter: 4 new + 8 skipped (2 bare urls, 6 blank lines) = the 12 lines of the file', v.skipped === 8 && rowsFor(P) === 4, `skipped ${v.skipped}, rows ${rowsFor(P)}`)
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND ${where}`))
  check('...the passwords are the real ones, with no tail, on all four rows',
    one(`password = '${pw('A1')}'`) === 1 && one(`password = '${pw('A2')}'`) === 1 && one(`password = '${pw('A3')}'`) === 1 && one(`password = '${pw('B1')}'`) === 1)
  check('...and no stored row holds the bar or the handle', one(`(position(password, '┃') > 0 OR position(password, '@probe_channel') > 0)`) === 0)

  // A file of 0 bytes dropped in the inbox, as a failed copy leaves one.
  const E = `e2e-nov-empty-${RUN}.txt`
  sh('docker', ['exec', APP, 'sh', '-c', `: > /app/inbox/${E}`])
  const empty = await waitFor(async () => (await inboxJobs(E))[0], 120_000, 1000)
  check('a file of 0 bytes dropped in the inbox is recorded as done with the note "empty-file", not as an import that found nothing', !!empty && empty.status === 'done' && empty.imported === 0 && empty.note === 'empty-file', JSON.stringify(empty))
  check('...nothing is stored or remembered for it, and no stage table is left', rowsFor(E) === 0 && sourceLine(E) === '' && stageTableCount() === 0, `rows ${rowsFor(E)}, source [${sourceLine(E)}]`)
}

async function parserV64(): Promise<void> {
  console.log('\n1h. Parser v6.4: login:password, a space, then the url')
  const P = `e2e-nov-v64-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const ls = [
    `v64a1${RUN}:${pw('A1')} https://shopa1.example-store.test/login`,                                              // a path
    `v64a2${RUN}@probe-mail.test:${pw('A2')}   http://shopa2.example-store.test`,                                   // an e-mail login, several spaces, no path
    `v64a3${RUN}:${pw('A3')} https://shopa3.example-store.test:8443/login?next=https://other.example-store.test/home`, // a port, a url inside the url
    // the mirror the parser already read
    `https://shopb1.example-store.test/login v64b1${RUN}:${pw('B1')}`,
    // still rejected
    `v64x1${RUN}/p:${pw('X1')} https://shopx1.example-store.test/login`,                                           // a login that holds a slash
    `Login: https://t.me/probe_channel`,                                                                            // a label in front of a Telegram link
    `v64x3${RUN}: https://shopx3.example-store.test/login`,                                                         // an empty password
    `v64x4${RUN}:${pw('X4')} extra https://shopx4.example-store.test/login`,                                        // a word between the password and the url
    `v64x5${RUN}:${pw('X5')} ftp://files.example-store.test/`,                                                      // a scheme other than http and https
    // the layouts that must not move
    `https://shopz1.example-store.test/login:v64z1${RUN}:${pw('Z1')}`,
    `v64z2${RUN}@probe-mail.test:${pw('Z2')}`,
  ]
  const v = await importLines(P, ls)
  check('a file with three credential-first lines, the url-first mirror, five lines that stay rejected and two layouts that must not move: 6 rows are new, none known', v.status === 'done' && v.imported === 6 && v.known === 0, brief(v))
  check('...the 5 rejected lines are the only ones skipped, and 6 rows are stored', v.skipped === 5 && rowsFor(P) === 6, `skipped ${v.skipped}, rows ${rowsFor(P)}`)
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND ${where}`))
  check('the url that came last is the url, the field in front of the first colon is the login and the rest of the first token the password',
    one(`url = 'https://shopa1.example-store.test/login' AND email = 'v64a1${RUN}' AND password = '${pw('A1')}' AND url_scheme = 'https' AND url_host = 'shopa1.example-store.test'`) === 1
    && one(`url = 'http://shopa2.example-store.test' AND email = 'v64a2${RUN}@probe-mail.test' AND password = '${pw('A2')}'`) === 1
    && one(`url = 'https://shopa3.example-store.test:8443/login?next=https://other.example-store.test/home' AND email = 'v64a3${RUN}' AND password = '${pw('A3')}'`) === 1)
  check('the url-first mirror and the other layouts are stored as before',
    one(`url = 'https://shopb1.example-store.test/login' AND email = 'v64b1${RUN}' AND password = '${pw('B1')}'`) === 1
    && one(`url = 'https://shopz1.example-store.test/login' AND email = 'v64z1${RUN}' AND password = '${pw('Z1')}'`) === 1
    && one(`url = '' AND email = 'v64z2${RUN}@probe-mail.test' AND password = '${pw('Z2')}'`) === 1)
  check('no row has a login that holds a slash, a Telegram link as its url, or a space in any field',
    one(`(position(email, '/') > 0 OR position(url, 't.me') > 0 OR position(email, ' ') > 0 OR position(password, ' ') > 0)`) === 0)
}

async function checkGroups(): Promise<void> {
  console.log('\n6b. Grouped existence check: slabs of one file share one scan of the table (INGEST_NOVELTY_CHECK_GROUP)')
  scanLog('before the groups scenario')
  const fills = (since: string) => {
    chQuery('SYSTEM FLUSH LOGS')
    return Number(chQuery(`SELECT count() FROM system.query_log WHERE type = 'QueryFinish' AND event_time >= toDateTime('${since}') AND query LIKE 'INSERT INTO ulp.zz_import_known_%'`))
  }
  const run = async (label: string, tag: string, group: string | undefined): Promise<{ since: string; names: [string, string] } | null> => {
    if (!check(`the rehearsal app restarted with 3,000-row slabs, concurrency 2 and ${label}`, await recreateApp({ concurrency: '2', slab: '3000', ...(group ? { group } : {}) }))) return null
    const since = chQuery('SELECT toString(now())')
    const shared = lines(`${tag}S`, 0, 30_000)
    const a = `e2e-nov-${tag}a-${RUN}.txt`
    const b = `e2e-nov-${tag}b-${RUN}.txt`
    const upA = upload(a, fixture(a, [...shared, ...lines(`${tag}A`, 0, 10_000)]))
    const upB = upload(b, fixture(b, [...shared, ...lines(`${tag}B`, 0, 10_000)]))
    const [evA, evB] = await Promise.all([waitJob(upA.jobId ?? '', 300_000), waitJob(upB.jobId ?? '', 300_000)])
    check(`${label}: both imports finished`, evA.status === 'done' && evB.status === 'done', `${brief(evA)} ${brief(evB)}`)
    check(`${label}: together they wrote 50,000 new rows, the shared 30,000 once`, (evA.imported ?? 0) + (evB.imported ?? 0) === 50_000, `${evA.imported} + ${evB.imported}`)
    check(`${label}: ...and one of them counted the shared rows as known`, (evA.known ?? 0) + (evB.known ?? 0) === 30_000, `${evA.known} + ${evB.known}`)
    check(`${label}: ClickHouse holds 50,000 rows, all distinct`, rowsFor(a, b) === 50_000 && distinctFor(a, b) === 50_000, `rows ${rowsFor(a, b)}, distinct ${distinctFor(a, b)}`)
    return { since, names: [a, b] }
  }
  const grouped = await run('the default group of 4', 'gr', undefined)
  if (!grouped) return
  const groupedFills = fills(grouped.since)
  const slabbed = await run('a group of 1 (slab by slab)', 'sl', '1')
  if (!slabbed) return
  const slabFills = fills(slabbed.since)
  info('existence-check fills', `grouped ${groupedFills}, slab by slab ${slabFills}`)
  check('the grouped check sent far fewer fills than slab by slab (14 slabs per file: 4 groups against 14)', groupedFills > 0 && groupedFills <= 12 && slabFills >= 24 && slabFills > 2 * groupedFills, `grouped ${groupedFills}, slab by slab ${slabFills}`)
  // The same content under new names finds every row known in every slab of every group: the per-slab counts of a group must add up to the file's distinct rows.
  if (!check('the rehearsal app restarted with the default group again', await recreateApp({ concurrency: '2', slab: '3000' }))) return
  const c = `e2e-nov-grc-${RUN} (refeed).txt`   // the same bytes as an earlier file of this scenario on purpose: a name without "refeed" would be skipped by the content check
  const again = upload(c, fixture(c, [...lines('grS', 0, 30_000), ...lines('grA', 0, 10_000)]))
  const evC = await waitJob(again.jobId ?? '', 300_000)
  check('the same 40,000 credentials under a new name are all known: nothing new, 40,000 known', evC.status === 'done' && evC.imported === 0 && evC.known === 40_000, brief(evC))
  check('...and nothing was stored for it', rowsFor(c) === 0, `rows ${rowsFor(c)}`)
}

async function parserV65(): Promise<void> {
  console.log('\n1i. Parser v6.5: a parenthesised copy of the site between the url and the credential')
  const P = `e2e-nov-v65-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const host = (k: string) => `shop${k}.example-store.test`
  const ls = [
    `${host('a1')}/login:(${host('a1')}/login):v65a1${RUN}:${pw('A1')}`,                            // no scheme
    `https://www.${host('a2')}/login:(${host('a2')}/login):v65a2${RUN}@probe-mail.test:${pw('A2')}`, // a scheme, www. only in the url, an e-mail login
    `${host('a3')}/login:(${host('a3')}/login):v65a3${RUN}:pa:ss-${RUN}`,                           // a colon in the password: the first colon ends the login
    // as before
    `${host('b1')}/login:(123):v65b1${RUN}:${pw('B1')}`,                                             // a number in parentheses
    `${host('b2')}/login:(ShopApp):v65b2${RUN}:${pw('B2')}`,                                         // a label that is not the host
    `${host('b3')}/login:v65b3${RUN}:${pw('B3')}`,                                                   // no copy at all
  ]
  const v = await importLines(P, ls)
  check('a file with three lines that carry a copy of the site and three that do not: 6 rows are new, none known, none skipped', v.status === 'done' && v.imported === 6 && v.known === 0 && v.skipped === 0 && rowsFor(P) === 6, brief(v))
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND ${where}`))
  check('the url is kept, the login and the password are the fields after the copy',
    one(`url = '${host('a1')}/login' AND email = 'v65a1${RUN}' AND password = '${pw('A1')}'`) === 1
    && one(`url = 'https://www.${host('a2')}/login' AND email = 'v65a2${RUN}@probe-mail.test' AND password = '${pw('A2')}'`) === 1
    && one(`url = '${host('a3')}/login' AND email = 'v65a3${RUN}' AND password = 'pa:ss-${RUN}'`) === 1)
  check('the shapes that are not a copy of the host are stored as they were',
    one(`email = '(123)' AND password = 'v65b1${RUN}:${pw('B1')}'`) === 1
    && one(`email = '(ShopApp)' AND password = 'v65b2${RUN}:${pw('B2')}'`) === 1
    && one(`email = 'v65b3${RUN}' AND password = '${pw('B3')}'`) === 1)
  check('no row has a parenthesised copy of a host as its login', one(`startsWith(email, '(') AND position(email, 'example-store') > 0`) === 0)
}

async function parserV66(): Promise<void> {
  console.log('\n1j. Parser v6.6: an app id behind a stray https://, a host with a trailing dot, an underscore in a host')
  const P = `e2e-nov-v66-${RUN}.txt`
  const pw = (k: string) => `Pw-${RUN}-${k}`
  const app = (k: string) => `AbCdEfGhIjKlMnOp${k}Qr==@com.example.app${k}`
  const ls = [
    `https://android://${app('1')}/:v66a1${RUN}:${pw('A1')}`,                                 // a username login
    `https://android://${app('2')}/:v66a2${RUN}@probe-mail.test:${pw('A2')}`,                 // an e-mail login (it used to be stored without its url)
    `https://android://${app('3')}/:v66a3${RUN}:${pw('A3')}`,                                 // the same account under two app ids: one row
    `https://android://${app('4')}/:v66a3${RUN}:${pw('A3')}`,
    `https://portal-b1.example-store.test./login:v66b1${RUN}:${pw('B1')}`,                    // a trailing dot
    `https://shop_c1.example-store.test/login:v66c1${RUN}:${pw('C1')}`,                       // an underscore in a label
    // still rejected as a bad host
    `https://com.bank.app_name/:v66x1${RUN}:${pw('X1')}`,                                     // an Android package name
    `https://main_login.asp:v66x2${RUN}:${pw('X2')}`,                                         // a file name
    `https://localhost:3000/:v66x3${RUN}:${pw('X3')}`,                                        // no dot
    // as before
    `https://shop-d1.example-store.test/login:v66d1${RUN}:${pw('D1')}`,
  ]
  const v = await importLines(P, ls)
  check('a file with 6 lines that v6.6 reads (one a repeat), 3 that stay rejected and 1 ordinary: 6 rows are new, none known', v.status === 'done' && v.imported === 6 && v.known === 0 && rowsFor(P) === 6, brief(v))
  const one = (where: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${P}' AND ${where}`))
  check('the app ids are stored as app-id lines, the e-mail login with its url, the repeated account once',
    one(`url = 'android://${app('1')}/' AND email = 'v66a1${RUN}' AND password = '${pw('A1')}' AND domain = 'com.example.app1'`) === 1
    && one(`url = 'android://${app('2')}/' AND email = 'v66a2${RUN}@probe-mail.test' AND password = '${pw('A2')}'`) === 1
    && one(`email = 'v66a3${RUN}' AND password = '${pw('A3')}'`) === 1)
  check('no row keeps the web scheme in front of an app id', one(`startsWith(url, 'https://android://')`) === 0)
  check('the trailing-dot host is kept in the url and stored without the dot as the domain',
    one(`url = 'https://portal-b1.example-store.test./login' AND email = 'v66b1${RUN}' AND domain = 'portal-b1.example-store.test'`) === 1)
  check('the host with an underscore is stored', one(`url = 'https://shop_c1.example-store.test/login' AND email = 'v66c1${RUN}' AND password = '${pw('C1')}'`) === 1)
  check('a package name, a file name and a host without a dot are not stored', one(`email IN ('v66x1${RUN}', 'v66x2${RUN}', 'v66x3${RUN}')`) === 0)
  check('an ordinary host is stored as before', one(`url = 'https://shop-d1.example-store.test/login' AND email = 'v66d1${RUN}'`) === 1)
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
  const Y = `e2e-nov-off-y-${RUN} (refeed).txt`   // the same bytes as X on purpose (a re-feed name: the content check lets it through)
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

  // Lines that cannot hold a credential (a banner, a divider) are not "unsplit": 1 line in 9 of this file is one (11%, over twice the 5% hold limit when they were counted)
  const NOISE = `e2e-qg-noise-${RUN}.txt`
  const banner = (i: number) => (i % 2 === 0 ? `\u{1F4B8} Fresh logs every day \u279C ${i} \u{1F4B0}` : '\u2588'.repeat(30 + (i % 5)))
  const noisy: string[] = []
  lines('Q', 30_000, 54_000).forEach((l, i) => { noisy.push(l); if (i % 8 === 7) noisy.push(banner(i)) })
  const noise = await importLines(NOISE, noisy)
  check('a file where 1 line in 9 is a banner or a divider is imported, not held: 24000 new rows', noise.status === 'done' && noise.imported === 24_000 && noise.known === 0, brief(noise))
  check('...the 3000 banners and dividers are skipped, 24000 rows are stored, and the file is not in inbox/held', noise.skipped === 3_000 && rowsFor(NOISE) === 24_000 && !inboxLs('held').includes(NOISE), `skipped ${noise.skipped}, rows ${rowsFor(NOISE)}`)

  // The sample check: past 8 MiB the file is read in slices before the import starts, so a file that breaks a rule on 1 line in 10 is held without a stage table
  const SAMPLE = `e2e-qg-sample-${RUN}.txt`
  const sampleJunk = (i: number) => `https://shop${i % 500}.example-store.test/login:smp${i}${RUN}@probe-mail.test:Pw://z${i}${RUN}` // its own rows: no other scenario holds them
  const sampleBody = Array.from({ length: 110_000 }, (_, i) => (i % 10 === 9 ? sampleJunk(i) : line('SC', i)))
  const sampled = await importLines(SAMPLE, sampleBody, 600_000)
  check('a file past 8 MiB where 1 line in 10 breaks a rule ends in error with the hold message', sampled.status === 'error' && /Held by the quality gate/.test(sampled.error ?? ''), brief(sampled))
  check('...not one row of it was stored, no stage table is left, and it waits in inbox/held', rowsFor(SAMPLE) === 0 && stageTableCount() === 0 && inboxLs('held').includes(SAMPLE), `rows ${rowsFor(SAMPLE)}, tables ${stageTableCount()}`)
  const sampledEntry = ((await api('GET', '/api/inbox/status')).json?.held ?? []).find((f: any) => f.name === SAMPLE)
  check('the report of the hold says it came from the sample, with the rule-breaking rows counted', sampledEntry?.report?.phase === 'sample' && sampledEntry?.report?.level === 'hold'
    && sampledEntry?.report?.junkPct >= 9 && (sampledEntry?.report?.kinds?.['password-has-scheme'] ?? 0) > 0, JSON.stringify(sampledEntry?.report ?? null).slice(0, 220))
  const sampleRelease = await api('POST', '/api/inbox/release', { filename: SAMPLE })
  check('Release moves it back', sampleRelease.status === 200, JSON.stringify(sampleRelease.json))
  const sampleDone = await waitFor(async () => {
    const st = await api('GET', '/api/inbox/status')
    return (st.json?.done_recent ?? []).find((j: any) => j.filename === SAMPLE && j.status === 'done')
  }, 300_000, 2000)
  check('the released file is imported without the sample check holding it again: 110000 rows', !!sampleDone && sampleDone.imported === 110_000 && rowsFor(SAMPLE) === 110_000, JSON.stringify(sampleDone ?? null))
  // What the unsplit lines look like: 1 line in 9 of this file has words and no separator, so it cannot be split but could be a credential. The hold report lists their masked shape.
  const UNSPLIT = `e2e-qg-unsplit-${RUN}.txt`
  const unsplitBody: string[] = []
  lines('QU', 0, 24_000).forEach((l, i) => { unsplitBody.push(l); if (i % 8 === 7) unsplitBody.push(`unsplit probe words ${i}${RUN}`) })
  const unsplit = await importLines(UNSPLIT, unsplitBody)
  check('a file where 1 line in 9 cannot be split ends in error with the hold message, and none of it was stored', unsplit.status === 'error' && /Held by the quality gate/.test(unsplit.error ?? '') && rowsFor(UNSPLIT) === 0, brief(unsplit))
  const unsplitEntry = ((await api('GET', '/api/inbox/status')).json?.held ?? []).find((f: any) => f.name === UNSPLIT)
  const top = unsplitEntry?.report?.unsplitShapes?.[0]
  check('the report lists the shape of the unsplit lines: one shape, 3000 lines, words only as w', top?.shape === 'w w w w' && top?.count === 3_000 && unsplitEntry.report.unsplitShapes.length === 1, JSON.stringify(unsplitEntry?.report?.unsplitShapes ?? null))
  check('...and no value of the file is in the report', !/probe|words/i.test(JSON.stringify(unsplitEntry?.report ?? {})) && !JSON.stringify(unsplitEntry?.report ?? {}).includes(RUN), JSON.stringify(unsplitEntry?.report ?? {}).slice(0, 200))
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
const sourceRowOf = (name: string): { size: number; sha256: string; line_count: number; parser_revision: number } | null => {
  const out = chQuery(`SELECT size, sha256, line_count, parser_revision FROM ulp.sources WHERE filename = '${name}' ORDER BY imported_at DESC LIMIT 1 FORMAT JSONEachRow`)
  if (!out) return null
  const r = JSON.parse(out)
  return { size: Number(r.size), sha256: r.sha256, line_count: Number(r.line_count), parser_revision: Number(r.parser_revision) }
}
const sourceRowCount = (name: string) => Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${name}'`))
const queueJobs = async (name: string) => (((await api('GET', '/api/upload/queue-status')).json?.recent ?? []) as Array<{ filename: string; imported: number; known: number; note: string | null }>).filter(r => r.filename === name)

async function fileLedger(): Promise<void> {
  console.log('\n11. The file ledger: every file hashed and recorded, the same bytes under another name skipped, re-feeds and a changed parser let through')
  const CURRENT = 65   // lib/parser-version.ts PARSER_REVISION
  check('ulp.sources has the parser_revision column (DDL v31)', chQuery("SELECT count() FROM system.columns WHERE database = 'ulp' AND table = 'sources' AND name = 'parser_revision'") === '1')

  const O = `e2e-led-orig-${RUN}.txt`
  const body = lines('LG', 0, 1_000)
  const sha = createHash('sha256').update(text(body)).digest('hex')
  const o = await importLines(O, body)
  check('a new file: 1000 new', o.status === 'done' && o.imported === 1_000 && o.known === 0, brief(o))
  const row = sourceRowOf(O)
  check('...its ulp.sources row has the size, the sha256 and the parser revision at once (the archive timer is not needed)',
    !!row && row.size === Buffer.byteLength(text(body)) && row.sha256 === sha && row.parser_revision === CURRENT && row.line_count === 1_000, JSON.stringify(row))

  const copy = `e2e-led-orig-${RUN} (2).txt`
  const c = await importLines(copy, body)
  check('the same bytes under a new name are skipped: nothing imported, nothing known', c.status === 'done' && c.imported === 0 && c.known === 0, brief(c))
  check('...no ulp.sources row for the copy, no credential row, and no stage table', sourceRowCount(copy) === 0 && rowsFor(copy) === 0 && stageTableCount() === 0, `rows ${sourceRowCount(copy)}/${rowsFor(copy)}/${stageTableCount()}`)
  check('...the job log labels it "same-content"', (await queueJobs(copy)).some(j => j.note === 'same-content'), JSON.stringify(await queueJobs(copy)))
  check('...and the original is untouched: 1000 rows, one ledger row', rowsFor(O) === 1_000 && sourceRowCount(O) === 1)

  const refeed = `e2e-led-orig-${RUN} (refeed v6.5).txt`
  const r = await importLines(refeed, body)
  check('a name with "refeed" in it is imported although the bytes are known: 0 new, 1000 known (read, not skipped)', r.status === 'done' && r.imported === 0 && r.known === 1_000, brief(r))
  check('...and it is recorded, with the hash and 0 lines', sourceRowOf(refeed)?.sha256 === sha && sourceRowOf(refeed)?.line_count === 0 && sourceRowOf(refeed)?.parser_revision === CURRENT, JSON.stringify(sourceRowOf(refeed)))

  // The parser "changes": the rows that hold these bytes are put back to an older revision, as a deploy of revision 66 would leave them.
  chQuery(`ALTER TABLE ulp.sources UPDATE parser_revision = 60 WHERE sha256 = '${sha}' SETTINGS mutations_sync = 1`)
  const third = `e2e-led-orig-${RUN} (3).txt`
  const t = await importLines(third, body)
  check('bytes an older parser imported are imported again under a new name: 0 new, 1000 known (read, not skipped)', t.status === 'done' && t.imported === 0 && t.known === 1_000, brief(t))
  check('...and the new row carries the current revision', sourceRowOf(third)?.parser_revision === CURRENT, JSON.stringify(sourceRowOf(third)))
  const fourth = `e2e-led-orig-${RUN} (4).txt`
  const f = await importLines(fourth, body)
  check('...after which a further copy is skipped again', f.status === 'done' && f.imported === 0 && f.known === 0 && sourceRowCount(fourth) === 0, brief(f))
  check('...with the same label', (await queueJobs(fourth)).some(j => j.note === 'same-content'))

  // a file that yields no credential
  const Z = `e2e-led-list-${RUN}.txt`
  const noCredential = Array.from({ length: 300 }, (_, i) => `card list ${RUN} ${i}: 4111 1111 1111 ${1000 + i} | holder ${i}`)
  const shaZ = createHash('sha256').update(text(noCredential)).digest('hex')
  const z = await importLines(Z, noCredential)
  check('a file that yields no credential: done, 0 imported, nothing held', z.status === 'done' && z.imported === 0 && z.known === 0, brief(z))
  check('...it is remembered with its hash and 0 lines', sourceRowOf(Z)?.sha256 === shaZ && sourceRowOf(Z)?.line_count === 0 && sourceRowOf(Z)?.parser_revision === CURRENT, JSON.stringify(sourceRowOf(Z)))
  const z2 = await importLines(Z, noCredential)
  check('...its re-drop is skipped by name', z2.status === 'done' && z2.imported === 0 && z2.known === 0 && sourceRowCount(Z) === 1, brief(z2))
  check('...and the job log says "already-imported"', (await queueJobs(Z)).filter(j => j.note === 'already-imported').length === 1, JSON.stringify(await queueJobs(Z)))
  const zCopy = `e2e-led-list-${RUN} copy.txt`
  const z3 = await importLines(zCopy, noCredential)
  check('...and a copy under another name is skipped by content', z3.status === 'done' && sourceRowCount(zCopy) === 0 && (await queueJobs(zCopy)).some(j => j.note === 'same-content'), brief(z3))

  // a name reused for another file: not blocked (the hash and the size decide)
  const other = await importLines(O, [...body, ...lines('LH', 0, 200)])
  check('the same name with other content is imported: 200 new, 1000 known', other.status === 'done' && other.imported === 200 && other.known === 1_000, brief(other))

  // the inbox watcher
  const N = `e2e-led-inbox-${RUN}.txt`
  dropInInbox(N, text(body))
  const j = await waitFor(async () => (await inboxJobs(N))[0], 120_000, 1000)
  check('a copy dropped in the inbox is skipped, labelled "same-content", and ends in done/', !!j && j.status === 'done' && j.imported === 0 && j.note === 'same-content' && inboxFolderHas('done', N), JSON.stringify(j))

  // the plain-text copy
  const ledgerFile = join(work, 'ledger.tsv')
  const env = { ...process.env, CH_CONTAINER: CH, APP_CONTAINER: APP, ULP_LEDGER_FILE: ledgerFile }
  const out = sh('npx', ['tsx', 'scripts/ledger-export.ts'], env)
  const copyText = readFileSync(ledgerFile, 'utf8')
  const lineOf = (name: string) => copyText.split('\n').find(l => l.split('\t')[1] === name && l.split('\t')[0] === 'ledger')
  const oLine = lineOf(O)
  const thirdLine = lineOf(third)
  check('the plain-text ledger lists a row with its size, hash, lines and revision (the original is at the rewound revision 60)',
    !!oLine && oLine.split('\t')[2] === String(Buffer.byteLength(text(body))) && oLine.split('\t')[3] === sha && oLine.split('\t')[4] === '1000' && oLine.split('\t')[5] === '60', `${out} | ${oLine}`)
  check('...and the re-import by the "newer" parser at the current revision', !!thirdLine && thirdLine.split('\t')[3] === sha && thirdLine.split('\t')[5] === String(CURRENT), String(thirdLine))
  check('...and not the copies that were skipped', !copyText.includes(`${copy}\t`) && !copyText.includes(`${fourth}\t`))

  // the revision backfill
  chQuery(`ALTER TABLE ulp.sources UPDATE parser_revision = 0 WHERE filename = '${Z}' SETTINGS mutations_sync = 1`)
  const dry = sh('npx', ['tsx', 'scripts/ledger-backfill.ts', 'revisions'], env)
  check('the backfill dry run lists the rows at 0 and changes nothing', dry.includes('dry run') && sourceRowOf(Z)?.parser_revision === 0, dry.split('\n').slice(-3).join(' | '))
  sh('npx', ['tsx', 'scripts/ledger-backfill.ts', 'revisions', '--apply'], env)
  check('...--apply sets the row by the time it was written, and leaves the others', sourceRowOf(Z)?.parser_revision === CURRENT && sourceRowOf(O)?.parser_revision === CURRENT, JSON.stringify([sourceRowOf(Z), sourceRowOf(O)]))
  const again = sh('npx', ['tsx', 'scripts/ledger-backfill.ts', 'revisions', '--apply'], env)
  check('...and a second run finds nothing at 0', /\(no rows\)/.test(again), again.split('\n').slice(0, 2).join(' | '))
  check('no stage table is left', stageTableCount() === 0)
}

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

  // Content as well as size: once ulp.sources holds a hash for the name (scripts/archive-sources.ts fills it for an archived name), a plain file of the same name and
  // the same size but other content is another file, not a re-drop.
  const C = `e2e-nov-content-${RUN}.txt`
  const original = lines('CT', 0, 1_000)
  const c1 = await importLines(C, original)
  check('a file whose name will carry a hash: 1000 new', c1.status === 'done' && c1.imported === 1_000, brief(c1))
  const sha = createHash('sha256').update(text(original)).digest('hex')
  chQuery(`ALTER TABLE ulp.sources UPDATE sha256 = '${sha}' WHERE filename = '${C}' SETTINGS mutations_sync = 1`)
  const c2 = await importLines(C, original)
  check('the identical file again is skipped: its hash is the one on record', c2.status === 'done' && c2.imported === 0 && c2.known === 0, brief(c2))
  const other = lines('CU', 0, 1_000)   // the same name, the same number of bytes, other content
  check('(the second file really has the same size)', Buffer.byteLength(text(other)) === Buffer.byteLength(text(original)))
  const c3 = await importLines(C, other)
  check('the same name and size with other content is imported: 1000 new, 0 known', c3.status === 'done' && c3.imported === 1_000 && c3.known === 0, brief(c3))
  check('...it has its own ulp.sources row, with its own hash', Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${C}'`)) === 2
    && chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${C}' AND sha256 = '${createHash('sha256').update(text(other)).digest('hex')}'`) === '1',
    chQuery(`SELECT groupArray(substring(sha256, 1, 8)) FROM ulp.sources WHERE filename = '${C}'`))
  check('...and 2000 rows are stored for the name', rowsFor(C) === 2_000, `rows ${rowsFor(C)}`)
  check('no stage table is left', stageTableCount() === 0)
}

/** The rows of the Inbox job list for a file, newest first. */
type InboxJob = { filename: string; status: string; imported: number; known: number; repeats: number | null; note: string | null; error_message: string | null }
async function inboxJobs(name: string): Promise<InboxJob[]> {
  return (((await api('GET', '/api/inbox/status')).json?.done_recent ?? []) as InboxJob[]).filter(r => r.filename === name)
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

// ── near-duplicates: docs/superpowers/specs/2026-11-01-near-duplicates-design.md ──────────────────────────

/** The match_key the newest job row of a file recorded: 'missing' when there is no row yet, 'null' when the column is empty. Read from SQLite inside the app container. */
function matchKeyOf(name: string): string {
  return sh('docker', ['exec', '-i', APP, 'node', '-e', `
    const Database = require('better-sqlite3');
    const name = require('fs').readFileSync(0, 'utf8');
    const db = new Database('/app/data/ulp.db', { readonly: true });
    const row = db.prepare('SELECT match_key FROM processing_jobs WHERE filename = ? ORDER BY id DESC LIMIT 1').get(name);
    process.stdout.write(row === undefined ? 'missing' : String(row.match_key));
    db.close();`], process.env, name)
}

/** Waits for the job row (it is written just after the job's last event) and returns its match_key. */
const jobMatchKey = (name: string) => waitFor(() => { const k = matchKeyOf(name); return k === 'missing' ? null : k }, 20_000, 1000)

async function goldenKey(): Promise<void> {
  console.log("\n12. The normalised key on the design's edge cases, computed by ClickHouse itself")
  // [url, host part, rest]: the table of "The rule" in the design, checked on ClickHouse 26.3.17.4.
  const cases: Array<[string, string, string]> = [
    ['https://www.Example.COM/Path/', 'example.com', '/Path'],
    ['http://example.com/Path', 'example.com', '/Path'],
    ['HTTPS://WWW.example.com', 'example.com', ''],
    ['https://example.com:8443/a//', 'example.com:8443', '/a'],
    ['HTTP://www.Example.com:80/a/', 'example.com:80', '/a'],
    ['https://example.com/a#frag', 'example.com', '/a#frag'],
    ['https://example.com/?x=1/', 'example.com', '/?x=1'],
    ['https://www.www.example.com/', 'www.example.com', ''],
    ['https://user:Pw@Host.com/x', 'user:pw@host.com', '/x'],
    ['ftp://www.x.com/a', 'ftp:', '//www.x.com/a'],
    ['android://abcDEF@com.app.name/', 'android:', '//abcDEF@com.app.name'],
    ['https://www.com', 'com', ''],
    ['', '', ''],
  ]
  const urls = cases.map(([u]) => `'${u}'`).join(', ')
  const out = chQuery(`SELECT url, ${normHostSql('url')} AS host, ${normRestSql('url')} AS rest FROM (SELECT arrayJoin([${urls}]) AS url) FORMAT JSONEachRow`)
  const got = new Map((out.split('\n').map(l => JSON.parse(l)) as Array<{ url: string; host: string; rest: string }>).map(r => [r.url, r]))
  for (const [url, host, rest] of cases) {
    const g = got.get(url)
    check(`${JSON.stringify(url)}: host ${JSON.stringify(host)}, rest ${JSON.stringify(rest)}`, g?.host === host && g?.rest === rest, JSON.stringify(g))
  }

  // How many distinct keys a set of spellings gives. Rows are [url, login, password].
  const distinctKeys = (key: (c: { url: string; email: string; password: string }) => string, rows: Array<[string, string, string]>) =>
    Number(chQuery(`SELECT uniqExact(${key({ url: 't.1', email: 't.2', password: 't.3' })}) FROM (SELECT arrayJoin([${rows.map(r => `('${r[0]}', '${r[1]}', '${r[2]}')`).join(', ')}]) AS t)`))
  const oneCredential: Array<[string, string, string]> = [
    ['https://www.Shop.example/login/', 'Sam@Mail.example', 'pw-1'],
    ['http://shop.example/login', 'sam@mail.example', 'pw-1'],
    ['HTTPS://SHOP.EXAMPLE/login//', 'SAM@MAIL.EXAMPLE', 'pw-1'],
    ['shop.example/login', 'sam@mail.EXAMPLE', 'pw-1'],
    ['https://WWW.shop.example/login///', 'Sam@mail.example', 'pw-1'],
  ]
  const differentCredentials: Array<[string, string, string]> = [
    ['https://shop.example/login', 'sam@mail.example', 'pw-1'],
    ['https://shop.example/Login', 'sam@mail.example', 'pw-1'], // path case
    ['https://shop.example/login2', 'sam@mail.example', 'pw-1'], // another path
    ['https://shop.example:8443/login', 'sam@mail.example', 'pw-1'], // a port
    ['https://shop.example/login', 'sam@mail.example', 'PW-1'], // password case
    ['https://shop.example/login?x=1', 'sam@mail.example', 'pw-1'], // a query
  ]
  check('five spellings of one credential give one normalised key', distinctKeys(normKeySql, oneCredential) === 1, String(distinctKeys(normKeySql, oneCredential)))
  check('...and five exact keys: the old key cannot see that they are one', distinctKeys(exactKeySql, oneCredential) === 5, String(distinctKeys(exactKeySql, oneCredential)))
  check('six credentials that differ by path, path case, port, query or password give six normalised keys', distinctKeys(normKeySql, differentCredentials) === 6, String(distinctKeys(normKeySql, differentCredentials)))
  // The stored column against the TypeScript text, on two look-alikes written straight into the table: one stored value for both, equal to the expression.
  const G = `e2e-nov-golden-${RUN}.txt`
  chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file) VALUES
    ('https://www.Golden.example/x/', 'G@x.example', 'pw', 'golden.example', '${G}'), ('http://golden.example/x', 'g@x.example', 'pw', 'golden.example', '${G}')`)
  const stored = chQuery(`SELECT uniqExact(norm_key_hash), countIf(norm_key_hash != ${NORM_CONTENT_KEY}) FROM ulp.credentials WHERE source_file = '${G}'`)
  check('the column ClickHouse stores equals the TypeScript expression, and two look-alikes share one value', stored === '1\t0', stored)
}

async function lookAlikes(): Promise<void> {
  console.log('\n13. Look-alikes are one credential: the exact key stores them, the normalised key counts them as known')
  scanLog('before the look-alike scenario')
  const since = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19) // SQLite stamps jobs in UTC
  const partition = new Date().toISOString().slice(0, 7).replace('-', '')
  const site = (tag: string) => `lk-${tag}-${RUN}.example-store.test`
  // The first file stores three credentials. The second brings look-alikes of two of them (B1 and B2) and two credentials that are different (B3, B4).
  const first = (tag: string) => [
    `https://www.${site(tag)}/login/:Sam${RUN}@probe-mail.test:Pw-${tag}-one`, // A1
    `https://${site(tag)}/Shop:user${RUN}@probe-mail.test:Pw-${tag}-two`, // A2
    `https://${site(tag)}/cart:cart${RUN}@probe-mail.test:Pw-${tag}-three`, // A3
  ]
  const second = (tag: string) => [
    `http://${site(tag)}/login:sam${RUN}@probe-mail.test:Pw-${tag}-one`, // B1: A1 without www., on http, no trailing slash, a lower-case login
    `https://${site(tag).toUpperCase()}/Shop//:USER${RUN}@probe-mail.test:Pw-${tag}-two`, // B2: A2 in another host case, with extra slashes and login case
    `https://${site(tag)}/shop:user${RUN}@probe-mail.test:Pw-${tag}-two`, // B3: another path case, so another credential
    `https://${site(tag)}/cart:cart${RUN}@probe-mail.test:Pw-${tag}-THREE`, // B4: another password case, so another credential
  ]

  // 1. The exact key: every line is a new row, which also proves the fixtures really are different to the old key.
  const X1 = `e2e-nov-lk-x1-${RUN}.txt`
  const X2 = `e2e-nov-lk-x2-${RUN}.txt`
  if (!check('the rehearsal app restarted with INGEST_NORM_KEY=off', await recreateApp({ normKey: 'off' }))) return
  const x1 = await importLines(X1, first('x'))
  const x2 = await importLines(X2, second('x'))
  check('under the exact key every look-alike is a new row: 3 + 4 stored, none known', x1.imported === 3 && x2.imported === 4 && (x2.known ?? 0) === 0, `${brief(x1)} ${brief(x2)}`)
  check('...the exact key tells all 7 rows apart, the normalised one sees B1 and B2 as the copies they are (5 distinct)',
    distinctFor(X1, X2) === 7 && distinctNormFor(X1, X2) === 5, `exact ${distinctFor(X1, X2)}, norm ${distinctNormFor(X1, X2)}`)
  check('...and both jobs recorded the exact key', (await jobMatchKey(X1)) === 'exact' && (await jobMatchKey(X2)) === 'exact')

  // 2. The normalised key (the production default; a fresh stack has the column complete).
  const Y1 = `e2e-nov-lk-y1-${RUN}.txt`
  const Y2 = `e2e-nov-lk-y2-${RUN}.txt`
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const y1 = await importLines(Y1, first('y'))
  const y2 = await importLines(Y2, second('y'))
  check('the first file stores its 3 rows', y1.imported === 3 && (y1.known ?? 0) === 0, brief(y1))
  check('the second file: the 2 look-alikes are known, the 2 different credentials are new', y2.imported === 2 && y2.known === 2 && y2.inFileDuplicates === 0, brief(y2))
  check('...only those 2 were stored, and the table holds 5 distinct credentials of the two files', rowsFor(Y2) === 2 && distinctNormFor(Y1, Y2) === 5, `rows ${rowsFor(Y2)}, norm ${distinctNormFor(Y1, Y2)}`)
  check('...and both jobs recorded the normalised key', (await jobMatchKey(Y1)) === 'norm' && (await jobMatchKey(Y2)) === 'norm')

  // 3. Look-alikes inside one file.
  const Z = `e2e-nov-lk-z-${RUN}.txt`
  const z = await importLines(Z, [
    `https://www.${site('z')}/login:Zed${RUN}@probe-mail.test:Pw-z-one`,
    `https://${site('z')}/login/:zed${RUN}@probe-mail.test:Pw-z-one`,
    `https://${site('z')}/login:other${RUN}@probe-mail.test:Pw-z-two`,
  ])
  check('inside one file the pair is one stored row and one repeat', z.imported === 2 && z.inFileDuplicates === 1 && (z.known ?? 0) === 0 && rowsFor(Z) === 2, brief(z))

  // 4. The monitor reports the row that was stored.
  const BRAND2 = `lookalike-brand-${RUN}.test`
  const hook = await api('POST', '/api/monitoring/webhooks', { name: `Look-alike Receiver ${RUN}`, url: `http://${RECEIVER}:9000/hook`, secret: 'rehearsal' })
  const hookId = hook.json?.data?.id as number | undefined
  if (check('a webhook to the receiver is accepted', hook.status === 200 && !!hookId, `status ${hook.status}: ${hook.json?.error ?? ''}`)) {
    const mon = await api('POST', '/api/monitoring/monitors', {
      name: `Look-alike Monitor ${RUN}`, domains: [BRAND2], match_mode: 'both', webhook_ids: [hookId], rescan_mode: 'dedup', rescan_interval_hours: 1,
    })
    if (check('a monitor on the look-alike brand domain is created', mon.status === 200 && !!mon.json?.data?.id, `status ${mon.status}`)) {
      const M = `e2e-nov-lk-mon-${RUN}.txt`
      const m = await importLines(M, [
        `https://${BRAND2}/login:pick${RUN}@${BRAND2}:Pw-pick-Xy!`, // the lower-case login comes first in the file...
        `https://${BRAND2}/login:Pick${RUN}@${BRAND2}:Pw-pick-Xy!`, // ...and the capital P sorts before the lower-case p
        ...lines('LMON', 0, 20), // its own tag: the link scenario stores lines('LK', 0, 2000) earlier in a full run, which would make these known
      ])
      check('the pair is one stored row and one repeat; the 20 other rows are new', m.imported === 21 && m.inFileDuplicates === 1, brief(m))
      const stored = chQuery(`SELECT email FROM ulp.credentials WHERE source_file = '${M}' AND lower(email) = 'pick${RUN}@${BRAND2}'`)
      check('the stored spelling is the first by (url, email), not the first in the file', stored === `Pick${RUN}@${BRAND2}`, stored)
      const alert = await waitFor(() => receiverLines().find(l => l.source_file === M), 90_000, 2000)
      check('the monitor alerted once, with the spelling that was stored', !!alert && alert.total_matches === 1 && alert.match_emails?.[0] === stored, JSON.stringify(alert))
    }
  }

  // 5. The per-file recount agrees with the job, for the normalised key and for the exact one.
  const data = mkdtempSync(join(tmpdir(), 'e2e-nov-data-'))
  try {
    sh('docker', ['cp', `${APP}:/app/data/.`, data])
    const recount = (name: string) => spawnSync('npx', ['tsx', 'scripts/pile/verify-file.ts', data, since, name], {
      env: { ...process.env, PILE_DIR: work, CH_CONTAINER: CH, PARTITION: partition }, encoding: 'utf8', maxBuffer: 64 << 20,
    })
    const vy = recount(Y2)
    check('the recount of the second file on the normalised key agrees with its job', vy.status === 0 && /recounted on the normalised key/.test(vy.stdout) && /ALL CHECKS PASSED/.test(vy.stdout), (vy.stdout + vy.stderr).slice(-500))
    const vx = recount(X2)
    check('the recount of the exact-key file agrees with its job', vx.status === 0 && /recounted on the exact key/.test(vx.stdout) && /ALL CHECKS PASSED/.test(vx.stdout), (vx.stdout + vx.stderr).slice(-500))
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
  scanLog('after the look-alike scenario')
}

async function parseWorkers(): Promise<void> {
  console.log('\n24. Parse workers (INGEST_PARSE_WORKERS=2): a big plain file is staged by a worker, with the rows and counts the importer\'s own thread gives')
  scanLog('before the workers scenario')
  if (!check('the rehearsal app restarted with 2 parse workers and an early check at 50,000 lines', await recreateApp({ workers: '2', concurrency: '2', earlyLines: '50000' }))) return

  // A small file first: under 16 MiB it is staged on the importer's thread, and it leaves 50,000 rows for the big file to find known.
  const SMALL = `e2e-pw-small-${RUN}.txt`
  const small = await importLines(SMALL, lines('W', 0, 50_000))
  check('a small file is imported: 50000 new rows', small.status === 'done' && small.imported === 50_000 && small.known === 0, brief(small))

  // The big file: 200,000 distinct lines (50,000 already known), 20,000 repeats of lines inside it, 2,000 lines that are not credentials.
  const BIG = `e2e-pw-big-${RUN}.txt`
  const noise = Array.from({ length: 2_000 }, (_, i) => `plain words with no credential in them, number ${i}`)
  const body = [...lines('W', 0, 200_000), ...lines('W', 100_000, 120_000), ...noise]
  const big = await importLines(BIG, body, 600_000)
  check('the big file is imported: 150000 new, 50000 known, 20000 repeats inside the file, 2000 skipped',
    big.status === 'done' && big.imported === 150_000 && big.known === 50_000 && big.inFileDuplicates === 20_000 && big.skipped === 2_000, brief(big))
  check('...all 150000 rows are in ClickHouse, all distinct', rowsFor(BIG) === 150_000 && distinctFor(BIG) === 150_000, `rows ${rowsFor(BIG)}, distinct ${distinctFor(BIG)}`)
  check('...no stage table is left, and the queue slot is free', stageTableCount() === 0)
  await expectIdleQueue('after the big file')
  const log = appLog()
  check('the app log shows a parse worker staged the big file, and not the small one',
    log.includes(`[upload-processor] ${BIG}: staged in a parse worker`) && !log.includes(`[upload-processor] ${SMALL}: staged in a parse worker`), log.split('\n').filter(l => l.includes('parse worker')).join(' | ').slice(0, 200))

  // The worker's own early check: the first 52,000 lines break a rule on 1 line in 10; a sample of the file (5 slices) stays under the sample check's limit, so it is the worker that holds it.
  const HELD = `e2e-pw-held-${RUN}.txt`
  const junk = (i: number) => `https://shop${i % 500}.example-store.test/login:pwj${i}${RUN}@probe-mail.test:Pw://j${i}${RUN}`
  const heldBody = [...Array.from({ length: 52_000 }, (_, i) => (i % 10 === 9 ? junk(i) : line('WH', i))), ...lines('WH', 52_000, 200_000)]
  const held = await importLines(HELD, heldBody, 600_000)
  check('a big file whose first lines break a rule ends in error with the hold message', held.status === 'error' && /Held by the quality gate/.test(held.error ?? ''), brief(held))
  check('...not one row was stored, no stage table is left, and it waits in inbox/held', rowsFor(HELD) === 0 && stageTableCount() === 0 && inboxLs('held').includes(HELD), `rows ${rowsFor(HELD)}, tables ${stageTableCount()}, held ${inboxLs('held').join(',')}`)
  const heldEntry = ((await api('GET', '/api/inbox/status')).json?.held ?? []).find((f: any) => f.name === HELD)
  check('...the report of the hold comes from the early check, with the rule-breaking rows counted', heldEntry?.report?.phase === 'early' && heldEntry?.report?.level === 'hold' && (heldEntry?.report?.kinds?.['password-has-scheme'] ?? 0) > 0, JSON.stringify(heldEntry?.report ?? null).slice(0, 200))
  check('...and the app log carries the verdict', appLog().includes(`[quality-gate] ${HELD}`))
  scanLog('after the workers scenario, with workers')

  // The same content as the big file under another name, staged on the importer's thread: it must find every row already known and count the same repeats and skipped lines.
  if (!check('the rehearsal app restarted with the workers off', await recreateApp({ concurrency: '2' }))) return
  const REPLAY = `e2e-pw-replay-${RUN} (refeed).txt`   // the same bytes as BIG on purpose
  const replay = await importLines(REPLAY, body, 600_000)
  check('the same content staged on the importer\'s thread: nothing new, 200000 known, the same 20000 repeats and 2000 skipped',
    replay.status === 'done' && replay.imported === 0 && replay.known === 200_000 && replay.inFileDuplicates === 20_000 && replay.skipped === 2_000, brief(replay))
  check('...it wrote no row', rowsFor(REPLAY) === 0, `rows ${rowsFor(REPLAY)}`)
  scanLog('after the workers scenario')
}

async function normNotReady(): Promise<void> {
  console.log('\n14. The normalised key is used only when every part holds the column')
  chQuery('ALTER TABLE ulp.credentials DROP COLUMN norm_key_hash')
  chQuery(`ALTER TABLE ulp.credentials ADD COLUMN norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}`)
  const partsNow = () => Number(chQuery("SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active"))
  const withColumn = () => Number(chQuery("SELECT uniqExact(name) FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND column = 'norm_key_hash'"))
  check('after the column was dropped and added again the existing parts lack it (the upgrade state)', partsNow() > 0 && withColumn() < partsNow(), `parts ${partsNow()}, with the column ${withColumn()}`)
  if (!check('the rehearsal app restarted (its readiness answer is cold)', await recreateApp())) return
  const site = `lk-nr-${RUN}.example-store.test`
  const N = (n: string) => `e2e-nov-nr-${n}-${RUN}.txt`
  const a = await importLines(N('a'), [`https://www.${site}/login:Nina${RUN}@probe-mail.test:Pw-nr`])
  const b = await importLines(N('b'), [`http://${site}/login/:nina${RUN}@probe-mail.test:Pw-nr`])
  check('while the column is incomplete the import matches on the exact key: the look-alike is a new row', a.imported === 1 && b.imported === 1 && (b.known ?? 0) === 0, `${brief(a)} ${brief(b)}`)
  check('...and both jobs say so', (await jobMatchKey(N('a'))) === 'exact' && (await jobMatchKey(N('b'))) === 'exact')
  chQuery('ALTER TABLE ulp.credentials MATERIALIZE COLUMN norm_key_hash SETTINGS mutations_sync = 2')
  check('MATERIALIZE COLUMN completed the column in every part', withColumn() === partsNow(), `parts ${partsNow()}, with the column ${withColumn()}`)
  await sleep(6_000) // a not-ready answer is remembered for 5 s
  const c = await importLines(N('c'), [`https://WWW.${site}/login//:NINA${RUN}@probe-mail.test:Pw-nr`])
  check('once it is complete the next import matches on the normalised key: the third spelling is known', c.imported === 0 && c.known === 1, brief(c))
  check('...and the job says so', (await jobMatchKey(N('c'))) === 'norm')
}

/** Drops a file in the rehearsal inbox the way an owner copies one in, and says whether a file of that name is in one of the inbox folders ('' is the inbox itself). */
const dropInInbox = (name: string, body: string) => sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${name}`], process.env, body)
const inboxFolderHas = (folder: string, name: string) => sh('docker', ['exec', APP, 'sh', '-c', `ls /app/inbox/${folder} 2>/dev/null | grep -c -x "${name}" || true`]) === '1'

async function autoRetry(): Promise<void> {
  console.log('\n10. A file the run lost goes back to the inbox once, on its own')
  scanLog('before the retry scenario')
  if (!check('the rehearsal app restarted with 1000-row slabs', await recreateApp({ slab: '1000' }))) return
  const TOTAL = 120_000

  /** ClickHouse frozen for 48 s once `name` has between `low` and `high` rows stored: longer than the 30 s stall timeout, plus the kill's bounded wait. */
  const freezeWhileImporting = async (name: string, low: number, high: number, label: string): Promise<number> => {
    const midway = await waitFor(() => { const n = rowsFor(name); return n >= low && n < high ? n : 0 }, 300_000, 300)
    check(`${label}: the commit was under way: some rows written, not all`, !!midway, `rows ${rowsFor(name)}`)
    sh('docker', ['pause', CH])
    try { await sleep(48_000) } finally { sh('docker', ['unpause', CH]) }
    await waitFor(() => chQuery('SELECT 1') === '1', 60_000, 1000)
    await waitFor(() => chQuery("SELECT count() FROM system.processes WHERE query_id LIKE 'novelty-%'") === '0' && stageTableCount() === 0, 120_000, 1000)
    return rowsFor(name)
  }
  const failedRows = async (name: string) => (await inboxJobs(name)).filter(r => r.status === 'failed')

  // A. a stall: the file comes back by itself and the totals are those of an uninterrupted run
  const A = `e2e-nov-retry-a-${RUN}.txt`
  dropInInbox(A, text(lines('RA', 0, TOTAL)))
  const beforeA = await freezeWhileImporting(A, 2_000, 80_000, 'a stall')
  info('rows written before the stall settled', beforeA)
  const failedA = await waitFor(async () => (await failedRows(A))[0], 90_000, 1000)
  const failedAt = Date.now()
  check('the job is logged as failed, with the stall reason and the retry note', !!failedA && failedA.note === 'auto-retry' && /stalled/.test(failedA.error_message ?? '')
    && /retrying automatically/.test(failedA.error_message ?? ''), JSON.stringify(failedA))
  check('...and the file waits in failed/', inboxFolderHas('failed', A))
  await expectIdleQueue('after the stall')
  const doneA = await waitFor(async () => (await inboxJobs(A)).find(r => r.status === 'done'), 420_000, 2000)
  const backAfter = Math.round((Date.now() - failedAt) / 1000)
  info('seconds from the failure to the finished retry', backAfter)
  check('the file came back on its own and finished: the rows already written count as known, the rest are new', !!doneA && doneA.imported === TOTAL - beforeA && doneA.known === beforeA, JSON.stringify(doneA))
  // measured from when this script saw the failure, which is up to 20 s after the failure itself (the freeze is still running 18 s after the watchdog fired)
  check('...not at once: it waited for the delay (2 minutes from the failure)', backAfter >= 60, `${backAfter} s`)
  check('the totals are those of an uninterrupted run: every row once, one ulp.sources row', rowsFor(A) === TOTAL && distinctFor(A) === TOTAL
    && Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${A}'`)) === 1, `rows ${rowsFor(A)}, distinct ${distinctFor(A)}`)
  check('...and the file ends in done/ only', inboxFolderHas('done', A) && !inboxFolderHas('failed', A) && !inboxFolderHas('', A) && !inboxFolderHas('processing', A))
  check('the log says it went back automatically', appLog().includes(`retrying automatically after an interruption: ${A}`))

  // B. the second loss of the same file: no second retry
  const B = `e2e-nov-retry-b-${RUN}.txt`
  dropInInbox(B, text(lines('RB', 0, TOTAL)))
  const afterFirst = await freezeWhileImporting(B, 2_000, 80_000, 'the first loss')
  const first = await waitFor(async () => (await failedRows(B))[0], 90_000, 1000)
  check('the first loss is logged with the retry note', !!first && first.note === 'auto-retry', JSON.stringify(first))
  const backInProcessing = await waitFor(() => inboxFolderHas('processing', B), 300_000, 1000)
  check('the file went back into the import by itself', !!backInProcessing)
  await freezeWhileImporting(B, afterFirst + 1_000, TOTAL - 5_000, 'the second loss')
  const both = await waitFor(async () => ((await failedRows(B)).length >= 2 ? await failedRows(B) : null), 90_000, 1000)
  check('the second loss is logged as failed, with the stall reason and without the retry note', !!both && both[0].note === null && /stalled/.test(both[0].error_message ?? '') && !/retrying automatically/.test(both[0].error_message ?? ''), JSON.stringify(both?.[0]))
  info('waiting longer than the retry delay to see that nothing comes back', '150 s')
  await sleep(150_000)
  check('the file stays in failed/: not in the inbox, not in processing/, not in done/', inboxFolderHas('failed', B) && !inboxFolderHas('', B) && !inboxFolderHas('processing', B) && !inboxFolderHas('done', B))
  check('...there was one automatic retry in the log and no more job rows than the two losses', (appLog().match(new RegExp(`retrying automatically after an interruption: ${B}`, 'g')) ?? []).length === 1 && (await inboxJobs(B)).length === 2,
    `${(await inboxJobs(B)).length} rows`)
  const manual = await api('POST', '/api/inbox/retry', { filename: B })
  check('the owner\'s Retry puts it back', manual.status === 200 && (manual.json?.moved ?? []).includes(B), JSON.stringify(manual.json))
  const doneB = await waitFor(async () => (await inboxJobs(B)).find(r => r.status === 'done'), 420_000, 2000)
  check('...and it finishes: every row once', !!doneB && rowsFor(B) === TOTAL && distinctFor(B) === TOTAL, `${JSON.stringify(doneB)} rows ${rowsFor(B)}`)

  // C. the app is killed in the middle of an inbox file: the start-up sweep sends the file back once
  const C = `e2e-nov-retry-c-${RUN}.txt`
  dropInInbox(C, text(lines('RC', 0, TOTAL)))
  const midC = await waitFor(() => { const n = rowsFor(C); return n >= 3_000 && n < 100_000 ? n : 0 }, 300_000, 300)
  check('a kill: the commit was under way', !!midC, `rows ${rowsFor(C)}`)
  sh('docker', ['kill', APP])
  await sleep(10_000)
  const beforeC = rowsFor(C)
  info('rows written when the app was killed', beforeC)
  if (!check('the app started again', await recreateApp({ slab: '1000' }))) return
  const doneC = await waitFor(async () => (await inboxJobs(C)).find(r => r.status === 'done'), 420_000, 2000)
  const failedC = (await failedRows(C))[0]
  check('the start-up sweep logged the interruption with the retry note', !!failedC && failedC.note === 'auto-retry' && /Retrying automatically once/.test(failedC.error_message ?? ''), JSON.stringify(failedC))
  check('...the file went back and finished: written rows known, the rest new', !!doneC && doneC.known === beforeC && doneC.imported === TOTAL - beforeC, JSON.stringify(doneC))
  check('...every row once, and the file ends in done/ only', rowsFor(C) === TOTAL && distinctFor(C) === TOTAL && inboxFolderHas('done', C) && !inboxFolderHas('failed', C) && !inboxFolderHas('processing', C))
  check('no stage table is left', stageTableCount() === 0)
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
  if (want('v62')) await parserV62()
  if (want('v63')) await parserV63()
  if (want('v64')) await parserV64()
  if (want('v65')) await parserV65()
  if (want('v66')) await parserV66()
  if (want('monitor')) await monitorScenario()
  if (want('big')) await bigFile()
  if (want('kill')) await killMidCommit()
  if (want('freeze')) await freezeDuringCommit()
  if (want('concurrent')) await concurrentFiles()
  if (want('groups')) await checkGroups()
  if (want('gate') && !skipGate && !(await gateScenario())) return 2
  if (want('off')) await directPath()
  if (want('quality-gate')) await qualityGate()
  if (want('archive-ref')) await archiveRef()
  if (want('ledger')) await fileLedger()
  if (want('same-name')) await sameName()
  if (want('link')) await hardLinkedNames()
  if (want('progress')) await progressCards()
  if (want('retention')) await doneRetention()
  if (want('golden')) await goldenKey()
  if (want('lookalikes')) await lookAlikes()
  if (want('norm-not-ready')) await normNotReady()
  if (want('workers')) await parseWorkers()
  if (want('retry')) await autoRetry()

  scanLog('at the end')
  await recreateApp() // leave the stack on the production defaults
  return 0
}

async function main(): Promise<number> {
  const imageProblem = assertRehearsalImage(APP)
  if (imageProblem) {
    console.error(imageProblem)
    return 2
  }
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
