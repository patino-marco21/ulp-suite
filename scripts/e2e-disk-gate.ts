/**
 * End-to-end check of the ingest disk gate (lib/ingest-disk-gate.ts) on the production image, against the ISOLATED rehearsal
 * stack (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * It recreates the rehearsal app with a floor derived from the host's real free space, then proves that an import
 *   1. goes straight through while free space is above the floor,
 *   2. waits once a filler file pushes free space under the floor, without failing (the stall watchdog is fed by the gate's
 *      heartbeat) and without inserting anything, while the banner endpoint and Ingest Health say so,
 *   3. carries on by itself when the filler is removed, importing every row exactly once,
 *   4. is not held at all with INGEST_DISK_GATE=off.
 * The floor is (free - 2 GiB) / 1.1, so the resume level (floor x 1.1) sits 2 GiB under the starting free space; the filler is
 * start free - floor + 1 GiB (about 13 GiB on a 120 GiB-free disk). It lives inside the rehearsal ClickHouse volume and is
 * removed in a `finally`; `docker compose down -v` removes it too.
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-disk-gate.ts                 # about 5 minutes; needs about 40 GiB of free host disk
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Exit 0 when every check passes, 1 when one fails, 2 when the stack is not ready or there is not enough room to run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const GiB = 1024 ** 3
const FILLER = '/var/lib/clickhouse/zz_disk_gate_filler'

if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_')) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

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
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-4).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

// --async_insert=0: the default profile buffers inserts, and this script reads what was written straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
const rowsFor = (source: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${source}'`))
const freeBytes = () => Number(chQuery("SELECT unreserved_space FROM system.disks WHERE name = 'default'"))
/** The app's log, stdout and stderr (the gate logs with console.warn, which goes to stderr). */
const appLog = () => {
  const r = spawnSync('docker', ['logs', APP], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 1000): Promise<T | null> {
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
  console.log(`  ... gave up waiting for: ${label}`)
  return null
}

const RUN = Date.now().toString(36)
const work = mkdtempSync(join(tmpdir(), 'e2e-diskgate-'))
const dockerCfg = mkdtempSync(join(tmpdir(), 'e2e-diskgate-docker-'))
writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore

const genLines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `https://shop${i % 500}.example-store.test/login:${tag}${i}@probe-mail.test:Pw-${tag}${i}-Xy!`).join('\n') + '\n'

// ── the filler ──────────────────────────────────────────────────────────────────────────────
function fillDisk(bytes: number): void {
  const mib = Math.ceil(bytes / (1024 * 1024))
  try {
    sh('docker', ['exec', CH, 'fallocate', '-l', `${mib}M`, FILLER])
  } catch {
    sh('docker', ['exec', CH, 'sh', '-c', `dd if=/dev/zero of=${FILLER} bs=1M count=${mib} 2>/dev/null`])
  }
}

function removeFiller(): void {
  try {
    sh('docker', ['exec', CH, 'rm', '-f', FILLER])
  } catch {
    /* already gone, or the container is */
  }
}

// ── the app: recreate with the settings under test, log in, call it ────────────────────────────
let cookie = ''

const appEnv = (name: string) => sh('docker', ['exec', APP, 'printenv', name])

/** Recreates only the rehearsal app, keeping its data volume and its secrets, with the gate settings under test. */
async function recreateApp(settings: { floorBytes: number; gate: string }): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerCfg,
    REHEARSAL_JWT_SECRET: appEnv('JWT_SECRET'),
    REHEARSAL_ADMIN_EMAIL: appEnv('ADMIN_EMAIL'),
    REHEARSAL_ADMIN_PASSWORD: appEnv('ADMIN_PASSWORD'),
    REHEARSAL_WEBHOOK_SECRET: 'unused-here', // the compose file interpolates it; the receiver is not touched
    REHEARSAL_INGEST_MIN_FREE_BYTES: String(settings.floorBytes),
    REHEARSAL_INGEST_DISK_GATE: settings.gate,
  }
  sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, 'up', '-d', '--no-deps', '--force-recreate', 'app'], env)
  const up = await waitFor('app healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000, 2000)
  if (!up) return false
  await login()
  return true
}

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: appEnv('ADMIN_EMAIL'), password: appEnv('ADMIN_PASSWORD') }),
  })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}

const gate = async () => (await getJson('/api/monitoring/disk')).json?.gate

/** POST a small file with curl (the body is received into the spool before the server answers, so this returns quickly). */
function upload(name: string, text: string): { status: number; jobId: string | null } {
  const path = join(work, name)
  writeFileSync(path, text)
  const out = sh('curl', [
    '-sS', '-m', '120', '-w', '\n%{http_code}', '-X', 'POST',
    '-H', `cookie: ${cookie}`, '-H', 'content-type: application/octet-stream',
    '--data-binary', `@${path}`, `${BASE}/api/upload?filename=${encodeURIComponent(name)}`,
  ])
  const lines = out.split('\n')
  const status = Number(lines.pop())
  return { status, jobId: /"jobId":"([^"]+)"/.exec(lines.join('\n'))?.[1] ?? null }
}

type JobEvent = { status: string; imported?: number; error?: string }

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

async function waitJob(jobId: string, timeoutMs: number): Promise<JobEvent> {
  const end = Date.now() + timeoutMs
  let last: JobEvent = { status: 'no-event' }
  while (Date.now() < end) {
    last = await jobSnapshot(jobId)
    if (last.status === 'done' || last.status === 'error') return last
    await sleep(1000)
  }
  return last
}

// ── scenarios ───────────────────────────────────────────────────────────────────────────────
async function run(): Promise<number> {
  for (const container of [APP, CH]) {
    let health = ''
    try {
      health = sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', container])
    } catch {
      /* missing */
    }
    if (health !== 'healthy') {
      console.error(`${container} is not running and healthy. Start the rehearsal stack first:\n  npx tsx scripts/e2e-alert-rehearsal.ts --keep`)
      return 2
    }
  }

  const start = freeBytes()
  const floor = Math.floor(((start - 2 * GiB) * 10) / 11)
  const resume = floor + Math.floor(floor / 10)
  const fillerBytes = start - floor + GiB
  info('free space at the start', `${(start / GiB).toFixed(1)} GiB`)
  info('floor / resume level', `${(floor / GiB).toFixed(1)} GiB / ${(resume / GiB).toFixed(1)} GiB`)
  info('filler', `${(fillerBytes / GiB).toFixed(1)} GiB`)
  if (start - fillerBytes < 20 * GiB) {
    console.error('Not enough free host disk space to run this safely: it would leave less than 20 GiB with the filler in place.')
    return 2
  }

  console.log('\n1. Free space above the floor: an upload goes straight through')
  if (!check('the rehearsal app restarted with the test floor', await recreateApp({ floorBytes: floor, gate: '' }))) return 1
  const probe = await getJson('/api/monitoring/disk')
  if (!check('the disk endpoint exists in this image (rebuild it with `docker compose build app` if not)', probe.status === 200, `HTTP ${probe.status}`)) return 2
  const nameA = `e2e-gate-a-${RUN}.txt`
  const a = upload(nameA, genLines(20_000, 'ga'))
  check('the upload was accepted', a.status === 200 && !!a.jobId, `HTTP ${a.status}`)
  const finalA = a.jobId ? await waitJob(a.jobId, 120_000) : null
  check('...and imported (status done)', finalA?.status === 'done', JSON.stringify(finalA))
  check('all 20000 rows are in ClickHouse', rowsFor(nameA) === 20_000, `rows ${rowsFor(nameA)}`)
  const g1 = await gate()
  check('the gate is idle and reports the configured floor and resume level', g1?.paused === false && g1?.floorBytes === floor && g1?.resumeBytes === resume, JSON.stringify(g1))

  console.log('\n2. A filler pushes free space under the floor: the next upload waits')
  fillDisk(fillerBytes)
  const low = await waitFor('free space under the floor', () => freeBytes() < floor, 60_000, 500)
  check('free space is now under the floor', !!low, `free ${freeBytes()} floor ${floor}`)
  // The gate reuses a free-space reading younger than 5 s (a batch every few seconds would otherwise cost a query each). Wait that
  // out, or the next job's first batch could be waved through on the reading taken before the filler existed.
  await sleep(6_000)
  const nameB = `e2e-gate-b-${RUN}.txt`
  const b = upload(nameB, genLines(30_000, 'gb'))
  check('the upload was accepted (the file is received into the spool first)', b.status === 200 && !!b.jobId, `HTTP ${b.status}`)
  const paused = await waitFor('the gate to pause', async () => (await gate())?.paused === true, 60_000)
  check('the disk endpoint reports the gate paused', !!paused)
  const health = await getJson('/api/monitoring/ingest-health')
  check('Ingest Health reports it too', health.json?.ingestGate?.paused === true, JSON.stringify(health.json?.ingestGate))
  await sleep(45_000) // longer than the rehearsal's 30 s stall timeout: only the gate's heartbeat keeps the job alive
  const during = b.jobId ? await jobSnapshot(b.jobId) : null
  check('after 45 s the job is still waiting: not failed by the stall watchdog, not finished', during !== null && during.status !== 'error' && during.status !== 'done', JSON.stringify(during))
  check('nothing was imported meanwhile', rowsFor(nameB) === 0, `rows ${rowsFor(nameB)}`)
  check('the log has a "pausing imports" line', /pausing imports/.test(appLog()))

  console.log('\n3. The filler is removed: the same upload finishes by itself')
  removeFiller()
  const resumed = await waitFor('the gate to resume', async () => (await gate())?.paused === false, 90_000)
  check('the gate resumed by itself', !!resumed)
  const finalB = b.jobId ? await waitJob(b.jobId, 120_000) : null
  check('the import finished (status done)', finalB?.status === 'done', JSON.stringify(finalB))
  check('every row arrived exactly once (30000)', rowsFor(nameB) === 30_000, `rows ${rowsFor(nameB)}`)
  check('the log has a "resuming imports" line', /resuming imports/.test(appLog()))

  console.log('\n4. INGEST_DISK_GATE=off: a floor above the free space holds nothing back')
  if (!check('the rehearsal app restarted with the gate off', await recreateApp({ floorBytes: freeBytes() + 10 * GiB, gate: 'off' }))) return 1
  const nameD = `e2e-gate-d-${RUN}.txt`
  const d = upload(nameD, genLines(10_000, 'gd'))
  const finalD = d.jobId ? await waitJob(d.jobId, 120_000) : null
  check('the import finished although free space is under the (ignored) floor', finalD?.status === 'done' && rowsFor(nameD) === 10_000, JSON.stringify(finalD))
  check('the disk endpoint reports no pause', (await gate())?.paused === false)
  return 0
}

async function main(): Promise<number> {
  process.on('SIGINT', () => {
    removeFiller()
    process.exit(130)
  })
  let code = 1
  try {
    code = await run()
  } catch (err) {
    check('the scenarios ran without an unexpected error', false, err instanceof Error ? err.message : String(err))
  } finally {
    removeFiller()
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
