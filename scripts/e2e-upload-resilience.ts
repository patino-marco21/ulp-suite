/**
 * End-to-end resilience scenarios for the upload pipeline, against the ISOLATED rehearsal stack
 * (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * Why it exists: on 2026-10-02 four ways to wedge the HTTP upload route were reproduced (an importer that stops reading for
 * 5 s or more, an upload queued behind a busy slot, the 300 s request timeout, a client that disconnects). Each left a job
 * that never finished and held a slot of the shared queue, which also stopped the inbox. The routes now receive the whole
 * file into a spool before they answer (lib/upload-spool.ts) and every import runs under a stall watchdog
 * (lib/import-runner.ts). This script keeps those cases from coming back.
 *
 * The clients are raw sockets, like a browser or curl. Node's own http client (and undici's fetch) stop sending the body once
 * the server has replied, which makes any test written with them look like a server hang.
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-upload-resilience.ts         # about 6 minutes; --slow adds the 300 s slow-client case (+7 minutes)
 *                                                    # (--only-slow runs just that case)
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Needs the `zip` command. Exit 0 when every check passes, 1 when one fails, 2 when the stack is not ready.
 */
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const HOST = '127.0.0.1'
const PORT = 3101
const BASE = `http://${HOST}:${PORT}`
// --only=queue-wait,cut-fin runs just those scenarios (keys: happy cut-fin cut-rst zip-cut queue-wait freeze-8s freeze-stall slow);
// --slow adds the 300 s slow-client case to a full run; --only-slow is --only=slow.
const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length).split(',')
const only = process.argv.includes('--only-slow') ? ['slow'] : onlyArg
const slow = process.argv.includes('--slow')

if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || PORT !== 3101) {
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

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

// --async_insert=0: the default profile buffers inserts, and this script reads what was written straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
const rowsFor = (source: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${source}'`))
const spoolCount = () => Number(sh('docker', ['exec', APP, 'sh', '-c', 'ls /tmp/ulp-spool 2>/dev/null | wc -l']))

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 250): Promise<T | null> {
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

// ── login and the app's own view of a job / the queue ─────────────────────────────────────────────────────────────────────────
let cookie = ''

async function login(): Promise<void> {
  const email = sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL'])
  const password = sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD'])
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function queue(): Promise<{ active: number; pending: number; current_file: string | null }> {
  const res = await fetch(`${BASE}/api/upload/queue-status`, { headers: { cookie } })
  return ((await res.json()) as { queue: { active: number; pending: number; current_file: string | null } }).queue
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

async function expectIdleQueue(label: string): Promise<void> {
  const idle = await waitFor(async () => {
    const q = await queue()
    return q.active === 0 && q.pending === 0
  }, 30_000, 500)
  check(`${label}: the queue slot is free again`, !!idle, JSON.stringify(await queue()))
}

// ── fixtures and the raw-socket client ────────────────────────────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'e2e-upload-'))
// Source names are unique per run: the importer skips a filename it has already imported, so a re-run on the same stack
// with fixed names would pass vacuously.
const RUN = Date.now().toString(36)
const fixture = (name: string, text: string) => {
  const path = join(work, name)
  writeFileSync(path, text)
  return path
}
const genLines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `https://shop${i % 500}.example-store.test/login:${tag}${i}@probe-mail.test:Pw-${tag}${i}-Xy!`).join('\n') + '\n'

interface RawUpload {
  readonly size: number
  /** Body bytes the client has written so far. */
  sent: number
  status: number | null
  jobId: string | null
  queuePosition: number | null
  /** Body bytes the client had written when the first byte of the reply arrived. */
  sentAtReply: number | null
  closed: boolean
  cut(how: 'fin' | 'rst'): void
}

/** POST a file the way a browser or curl does: headers, then the body, whatever the server answers meanwhile. */
function rawUpload(filename: string, file: string, opts: { bytesPerSec?: number } = {}): RawUpload {
  const size = statSync(file).size
  const head =
    `POST /api/upload?filename=${encodeURIComponent(filename)} HTTP/1.1\r\n` +
    `Host: ${HOST}:${PORT}\r\nCookie: ${cookie}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${size}\r\n\r\n`
  const sock = net.connect(PORT, HOST)
  sock.setNoDelay(true)
  let reply = ''
  const rs = createReadStream(file, { highWaterMark: opts.bytesPerSec ? Math.max(1024, Math.floor(opts.bytesPerSec / 20)) : 64 * 1024 })
  const up: RawUpload = {
    size, sent: 0, status: null, jobId: null, queuePosition: null, sentAtReply: null, closed: false,
    cut(how) {
      if (how === 'rst') sock.resetAndDestroy()
      else sock.destroy()
      rs.destroy()
    },
  }
  sock.on('data', data => {
    if (reply.length >= 4000) return
    reply += data.toString('latin1')
    if (up.status === null) {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(reply)
      if (status) {
        up.status = Number(status[1])
        up.sentAtReply = up.sent
      }
    }
    const id = /"jobId":"([^"]+)"/.exec(reply)
    if (id) up.jobId = id[1]
    const position = /"queue_position":(\d+)/.exec(reply)
    if (position) up.queuePosition = Number(position[1])
  })
  sock.on('error', () => { /* a cut, or the server closing the connection, surfaces through 'close' */ })
  sock.on('close', () => { up.closed = true })
  sock.write(head)
  rs.on('data', chunk => {
    up.sent += chunk.length
    const accepted = sock.write(chunk)
    if (opts.bytesPerSec) {
      // Throttled: a short pause between chunks is the whole flow control (the socket buffer never fills at these rates).
      rs.pause()
      setTimeout(() => rs.resume(), 50)
    } else if (!accepted) {
      rs.pause()
      sock.once('drain', () => rs.resume())
    }
  })
  rs.on('error', () => {})
  return up
}

async function followUpImports(name: string): Promise<boolean> {
  const up = rawUpload(name, fixture(name, genLines(50, 'fu')))
  const id = await waitFor(() => up.jobId, 30_000)
  const final = id ? await waitJob(id, 30_000) : null
  up.cut('fin')
  return final?.status === 'done' && rowsFor(name) === 50
}

// ── scenarios ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function happyPath(): Promise<void> {
  console.log('\n1. A browser-like client uploads 300,000 lines')
  const name = `e2e-happy-${RUN}.txt`
  const up = rawUpload(name, fixture(name, genLines(300_000, 'hp')))
  const id = await waitFor(() => up.jobId, 120_000)
  check('the server answered with a job id', !!id)
  check('...and only after it had received the whole file', up.sentAtReply === up.size, `the client had written ${up.sentAtReply} of ${up.size} bytes when the reply arrived`)
  const final = id ? await waitJob(id, 120_000) : null
  check('the import finished with status done', final?.status === 'done', JSON.stringify(final))
  check('all 300000 rows are in ClickHouse', rowsFor(name) === 300_000, `rows ${rowsFor(name)}`)
  check('the spool file is gone', spoolCount() === 0)
  up.cut('fin')
  await expectIdleQueue('happy path')
}

async function cutMidBody(how: 'fin' | 'rst'): Promise<void> {
  console.log(`\n2. The client disconnects (${how.toUpperCase()}) while the file is still arriving`)
  const name = `e2e-cut-${how}-${RUN}.txt`
  const up = rawUpload(name, fixture(name, genLines(250_000, `c${how[0]}`)), { bytesPerSec: 2_000_000 })
  await waitFor(() => up.sent >= up.size * 0.4, 60_000, 100)
  up.cut(how)
  await sleep(3000)
  check('no job was created: the server never replied', up.jobId === null && up.status === null)
  check('nothing was imported', rowsFor(name) === 0)
  check('no spool file is left', spoolCount() === 0)
  await expectIdleQueue(`cut ${how}`)
  check('a following upload imports normally', await followUpImports(`e2e-after-cut-${how}-${RUN}.txt`))
}

async function zipCutMidBody(): Promise<void> {
  console.log('\n3. The client disconnects while a .zip archive is still arriving')
  const name = `e2e-cut-${RUN}.zip`
  const entry = `e2e-zip-entry-${RUN}.txt`
  fixture(entry, genLines(900_000, 'zc'))
  sh('zip', ['-q', '-j', join(work, name), join(work, entry)])
  const up = rawUpload(name, join(work, name), { bytesPerSec: 1_500_000 })
  await waitFor(() => up.sent >= up.size * 0.4, 60_000, 100)
  up.cut('fin')
  await sleep(3000)
  check('nothing was imported from the cut archive', rowsFor(entry) === 0)
  check('no spool file is left', spoolCount() === 0)
  await expectIdleQueue('cut zip')
}

async function queuedBehindABusySlot(): Promise<void> {
  console.log('\n4. A second upload arrives while the first is importing (the only queue slot is busy)')
  const a = `e2e-queue-a-${RUN}.txt`
  const b = `e2e-queue-b-${RUN}.txt`
  const fileB = fixture(b, genLines(250_000, 'qb')) // written before A starts, so B's upload begins the moment A is importing
  const upA = rawUpload(a, fixture(a, genLines(700_000, 'qa')))
  const tA = Date.now()
  await waitFor(() => rowsFor(a) >= 100_000, 120_000)
  info('A reached 100000 rows after', `${Date.now() - tA} ms`)
  const tB = Date.now()
  const upB = rawUpload(b, fileB)
  const idB = await waitFor(() => upB.jobId, 60_000, 100)
  const replyMs = Date.now() - tB
  const rowsOfAAtReply = rowsFor(a)
  info('B was answered after', `${replyMs} ms, when A had ${rowsOfAAtReply} rows`)
  check('B was accepted while A was still importing', !!idB && rowsOfAAtReply < 700_000, `A had ${rowsOfAAtReply} rows when B was accepted`)
  check('B was told it is queued', (upB.queuePosition ?? 0) >= 1, `queue_position ${upB.queuePosition}`)
  const finalA = upA.jobId ? await waitJob(upA.jobId, 180_000) : null
  const finalB = idB ? await waitJob(idB, 180_000) : null
  check('A finished (status done) with all 700000 rows', finalA?.status === 'done' && rowsFor(a) === 700_000, `${JSON.stringify(finalA)} rows ${rowsFor(a)}`)
  check('B finished (status done) with all 250000 rows', finalB?.status === 'done' && rowsFor(b) === 250_000, `${JSON.stringify(finalB)} rows ${rowsFor(b)}`)
  upA.cut('fin')
  upB.cut('fin')
  await expectIdleQueue('queue wait')
}

async function clickHouseFrozen(o: { name: string; tag: string; freezeSeconds: number; expectStall: boolean }): Promise<void> {
  const { name, tag, freezeSeconds, expectStall } = o
  console.log(`\n${expectStall ? '6' : '5'}. ClickHouse is frozen for ${freezeSeconds} s in the middle of an import${expectStall ? ' (longer than the 30 s stall timeout)' : ''}`)
  const up = rawUpload(name, fixture(name, genLines(600_000, tag)))
  const id = await waitFor(() => up.jobId, 60_000)
  await waitFor(() => rowsFor(name) >= 100_000, 120_000)
  sh('docker', ['pause', CH])
  let during: JobEvent | null = null
  try {
    if (expectStall) {
      await sleep(40_000)
      during = id ? await jobSnapshot(id) : null // ClickHouse is still frozen here
      await sleep(Math.max(0, freezeSeconds * 1000 - 40_000))
    } else {
      await sleep(freezeSeconds * 1000)
    }
  } finally {
    sh('docker', ['unpause', CH])
  }
  await waitFor(() => chQuery('SELECT 1') === '1', 60_000, 1000)
  up.cut('fin')

  if (expectStall) {
    check('the watchdog failed the job while ClickHouse was still frozen', during?.status === 'error', JSON.stringify(during))
    check('...with the stall reason', /stalled/.test(during?.error ?? ''), during?.error ?? '')
    check('no spool file is left', spoolCount() === 0)
    await expectIdleQueue('after the stall')
    check('the next upload imports normally', await followUpImports(`e2e-after-stall-${RUN}.txt`))
  } else {
    const final = id ? await waitJob(id, 180_000) : null
    check(`the import survived a ${freezeSeconds} s freeze (status done)`, final?.status === 'done', JSON.stringify(final))
    check('...and every row arrived exactly once', rowsFor(name) === 600_000, `rows ${rowsFor(name)}`)
    check('no spool file is left', spoolCount() === 0)
    await expectIdleQueue('after the freeze')
  }
}

async function slowClient(): Promise<void> {
  console.log('\n7. A client so slow that the body cannot arrive within Node\'s 300 s request timeout (--slow, about 7 minutes)')
  const name = `e2e-slow-${RUN}.txt`
  const up = rawUpload(name, fixture(name, genLines(300_000, 'sl')), { bytesPerSec: 70_000 })
  const cutByServer = await waitFor(() => up.closed, 420_000, 1000)
  check('the server cut the connection at its request timeout', !!cutByServer)
  up.cut('fin')
  check('no job was created', up.jobId === null)
  check('nothing was imported', rowsFor(name) === 0)
  check('no spool file is left', spoolCount() === 0)
  await expectIdleQueue('slow client')
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
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
  try {
    sh('zip', ['-v'])
  } catch {
    console.error('The `zip` command is required (apt install zip).')
    return 2
  }
  let stallMs = ''
  try {
    stallMs = sh('docker', ['exec', APP, 'printenv', 'IMPORT_STALL_TIMEOUT_MS'])
  } catch {
    /* unset */
  }
  if (stallMs !== '30000') {
    console.error('The rehearsal app was not started with IMPORT_STALL_TIMEOUT_MS=30000 (docker-compose.rehearsal.yml). Recreate the stack with the current compose file.')
    return 2
  }

  try {
    await login()
    const scenarios: Array<{ key: string; slowOnly?: boolean; run: () => Promise<void> }> = [
      { key: 'happy', run: happyPath },
      { key: 'cut-fin', run: () => cutMidBody('fin') },
      { key: 'cut-rst', run: () => cutMidBody('rst') },
      { key: 'zip-cut', run: zipCutMidBody },
      { key: 'queue-wait', run: queuedBehindABusySlot },
      { key: 'freeze-8s', run: () => clickHouseFrozen({ name: `e2e-freeze-8s-${RUN}.txt`, tag: 'f8', freezeSeconds: 8, expectStall: false }) },
      { key: 'freeze-stall', run: () => clickHouseFrozen({ name: `e2e-freeze-stall-${RUN}.txt`, tag: 'fs', freezeSeconds: 45, expectStall: true }) },
      { key: 'slow', slowOnly: true, run: slowClient },
    ]
    for (const scenario of scenarios) {
      const selected = only ? only.includes(scenario.key) : scenario.slowOnly ? slow : true
      if (selected) await scenario.run()
    }
  } catch (err) {
    check('the scenarios ran without an unexpected error', false, err instanceof Error ? err.message : String(err))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  return failed.length === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(2)
  },
)
