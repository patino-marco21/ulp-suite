/**
 * What UPLOAD_CONCURRENCY buys: memory, CPU and time of the REHEARSAL app at 1, 2, 4 ... upload lanes (docs/superpowers/specs/2026-10-21-ingest-hardening-design.md,
 * "Follow-up"). It drives the isolated rehearsal stack only, never the real one.
 *
 *   docker compose build app                          # or REHEARSAL_APP_IMAGE=<tag> to measure another image
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep     # brings the stack up and leaves it running
 *   node scripts/measure-upload-lanes.mjs 1 2 4       # about 3 minutes per value; LANES_FILES (default 4) and LANES_LINES (default 2000000) size the load
 *
 * For each value it recreates the rehearsal app with that UPLOAD_CONCURRENCY (fresh counters), writes the synthetic files inside the container, moves them into the
 * inbox together and samples the container's cgroup (memory every 500 ms, CPU at the start and the end) until every file is in ulp.sources. The rehearsal app's
 * 30 s stall watchdog (made for the freeze scenario) is raised to the production 20 minutes for the run, because lanes that wait for the commit lock make no progress.
 * The rehearsal ClickHouse is capped at 4 GB and holds almost no data: its commit is cheaper than the live one, so read the time as a shape, not as a forecast.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const PROJECT = 'ulp-rehearsal'
const COMPOSE = 'docker-compose.rehearsal.yml'
if (![APP, CH].every(n => n.startsWith('ulprehearsal_'))) throw new Error('refusing to run: this script only drives the isolated rehearsal stack')

const FILES = Number(process.env.LANES_FILES ?? 4)
const LINES = Number(process.env.LANES_LINES ?? 2_000_000)
const MiB = 1024 * 1024
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sh = (cmd, args, env = process.env, input) =>
  execFileSync(cmd, args, { encoding: 'utf8', env, input, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const secrets = {
  jwt: sh('docker', ['exec', APP, 'printenv', 'JWT_SECRET']),
  email: sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL']),
  password: sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD']),
}
const dockerCfg = mkdtempSync(join(tmpdir(), 'lanes-docker-'))
writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop\'s global Docker config has a broken credsStore
const override = join(dockerCfg, 'stall-limit.yml')
writeFileSync(override, 'services:\n  app:\n    environment:\n      IMPORT_STALL_TIMEOUT_MS: "1200000"\n')

async function recreate(concurrency) {
  const env = {
    ...process.env, DOCKER_CONFIG: dockerCfg,
    REHEARSAL_JWT_SECRET: secrets.jwt, REHEARSAL_ADMIN_EMAIL: secrets.email, REHEARSAL_ADMIN_PASSWORD: secrets.password, REHEARSAL_WEBHOOK_SECRET: 'unused-here',
    REHEARSAL_UPLOAD_CONCURRENCY: String(concurrency),
    REHEARSAL_INGEST_NOVELTY_CHECK: '', REHEARSAL_INGEST_NOVELTY_SLAB_ROWS: '', REHEARSAL_INGEST_MIN_FREE_BYTES: '', REHEARSAL_INGEST_DISK_GATE: '',
  }
  sh('docker', ['compose', '-f', COMPOSE, '-f', override, '-p', PROJECT, 'up', '-d', '--no-deps', '--force-recreate', 'app'], env)
  for (let i = 0; i < 150; i++) {
    if (sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy') return
    await sleep(2000)
  }
  throw new Error('the rehearsal app did not become healthy')
}

const cgroupOf = name => `/sys/fs/cgroup/system.slice/docker-${sh('docker', ['inspect', '--format', '{{.Id}}', name])}.scope`
const readNum = path => Number(readFileSync(path, 'utf8').trim())
const cpuUsec = path => Number(/^usage_usec (\d+)$/m.exec(readFileSync(join(path, 'cpu.stat'), 'utf8'))[1])
const anonOf = path => Number(/^anon (\d+)$/m.exec(readFileSync(join(path, 'memory.stat'), 'utf8'))[1])

const GEN = `
const fs = require('fs'); const [path, tag, n] = process.argv.slice(1); const total = +n;
const out = fs.createWriteStream(path); let i = 0;
(function write() {
  let ok = true;
  while (i < total && ok) {
    let s = '';
    for (let k = 0; k < 10000 && i < total; k++, i++) s += 'https://shop' + (i % 500) + '.example-store.test/login:' + tag + 'x' + i + '@probe-mail.test:Pw-' + tag + 'x' + i + '-Xy!\\n';
    ok = out.write(s);
  }
  if (i < total) out.once('drain', write); else out.end();
})();`

async function run(lanes) {
  console.log(`\n=== ${lanes} lane(s): ${FILES} files x ${LINES.toLocaleString()} lines`)
  await recreate(lanes)
  const run = Date.now().toString(36)
  const names = Array.from({ length: FILES }, (_, k) => `lanes-${lanes}-${run}-${k}.txt`)
  names.forEach((name, k) => sh('docker', ['exec', APP, 'node', '-e', GEN, `/app/inbox/done/.tmp-${name}`, `L${lanes}${run}f${k}`, String(LINES)]))
  const cg = cgroupOf(APP)
  const chCg = cgroupOf(CH)
  const base = { anon: anonOf(cg), cur: readNum(join(cg, 'memory.current')) }
  const moves = names.map(n => `mv /app/inbox/done/.tmp-${n} /app/inbox/${n}`).join(' && ')
  const cpu0 = { app: cpuUsec(cg), ch: cpuUsec(chCg) }
  const t0 = Date.now()
  sh('docker', ['exec', APP, 'sh', '-c', moves])
  let peakAnon = 0, peakCur = 0, chPeak = 0
  const inList = names.map(n => `'${n}'`).join(', ')
  let finishedAt = null
  let lastCheck = 0
  while (Date.now() - t0 < 900_000) {
    peakAnon = Math.max(peakAnon, anonOf(cg))
    peakCur = Math.max(peakCur, readNum(join(cg, 'memory.current')))
    chPeak = Math.max(chPeak, readNum(join(chCg, 'memory.current')))
    if (Date.now() - lastCheck > 2000) {
      lastCheck = Date.now()
      const done = Number(sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', `SELECT count() FROM ulp.sources WHERE filename IN (${inList})`]))
      if (done >= FILES) { finishedAt = Date.now(); break }
    }
    await sleep(500)
  }
  if (!finishedAt) throw new Error('the files were not all imported within 15 minutes')
  const wall = (finishedAt - t0) / 1000
  const cpu1 = { app: cpuUsec(cg), ch: cpuUsec(chCg) }
  const cores = { app: (cpu1.app - cpu0.app) / 1e6 / wall, ch: (cpu1.ch - cpu0.ch) / 1e6 / wall }
  const rows = Number(sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', `SELECT count() FROM ulp.credentials WHERE source_file IN (${inList})`]))
  const peakFile = readNum(join(cg, 'memory.peak'))
  console.log(`lanes=${lanes}  wall=${wall.toFixed(1)} s  rows=${rows.toLocaleString()} (expected ${(FILES * LINES).toLocaleString()})`)
  console.log(`app memory: idle anon ${(base.anon / MiB).toFixed(0)} MiB; peak anon ${(peakAnon / MiB).toFixed(0)} MiB; peak memory.current ${(peakCur / MiB).toFixed(0)} MiB; cgroup memory.peak ${(peakFile / MiB).toFixed(0)} MiB (limit 2048)`)
  console.log(`cpu over the run: app ${cores.app.toFixed(2)} cores, clickhouse ${cores.ch.toFixed(2)} cores; ${(FILES * LINES / wall / 1000).toFixed(0)}k lines/s end to end`)
  console.log(`clickhouse memory.current peak ${(chPeak / MiB).toFixed(0)} MiB`)
  try {
    const jobs = sh('docker', ['exec', '-i', APP, 'node', '-e', `
      const fs = require('fs'); const Database = require('better-sqlite3');
      const names = JSON.parse(fs.readFileSync(0, 'utf8'));
      const db = new Database('/app/data/ulp.db', { readonly: true });
      const rows = db.prepare('SELECT filename, status, imported, duration_ms FROM processing_jobs WHERE filename IN (' + names.map(() => '?').join(',') + ') ORDER BY id').all(...names);
      console.log(JSON.stringify(rows));`], process.env, JSON.stringify(names))
    for (const j of JSON.parse(jobs)) console.log(`  ${j.filename}  ${j.status}  imported=${j.imported}  ${(j.duration_ms / 1000).toFixed(1)} s`)
  } catch (err) { console.log('  (job rows not read: ' + String(err.message).split('\n')[0] + ')') }
  return { lanes, wall, peakAnon, peakCur, peakFile, rows, cores }
}

const levels = process.argv.slice(2).map(Number).filter(n => n >= 1)
const results = []
try {
  for (const lanes of levels) results.push(await run(lanes))
} finally {
  rmSync(dockerCfg, { recursive: true, force: true })
}
console.log('\nSUMMARY')
for (const r of results) console.log(`lanes ${r.lanes}: wall ${r.wall.toFixed(1)} s, app ${r.cores.app.toFixed(2)} cores, ch ${r.cores.ch.toFixed(2)} cores, peak anon ${(r.peakAnon / MiB).toFixed(0)} MiB, peak current ${(r.peakCur / MiB).toFixed(0)} MiB, memory.peak ${(r.peakFile / MiB).toFixed(0)} MiB`)
