/**
 * The source archive tool (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md). It never prints a line of a file.
 *
 *   tsx scripts/archive-sources.ts archive --src <dir> [--out <archive dir>] [--workers 8] [--only a.txt,b.txt] [--replace] [--include-unimported] [--no-sources] [--dry-run]
 *   tsx scripts/archive-sources.ts status [--out <archive dir>]
 *   tsx scripts/archive-sources.ts verify [--out <archive dir>] [--all | --sample 3]
 *   tsx scripts/archive-sources.ts restore <name|id> --to <path> [--out <archive dir>]
 *   tsx scripts/archive-sources.ts sources-sync [--out <archive dir>]
 *
 * Run it from the repository root. Environment: ULP_ARCHIVE_DIR (default ~/ulp-archive; the directory must exist, the tool never creates it), ULP_REPO (the checkout
 * whose ./inbox --replace looks at; default the current directory), CH_CONTAINER (ulpsuite_clickhouse).
 *
 * --replace removes an original, and the inbox/done names that are hardlinks of it, only after the archive was decoded again and matched the original, and never
 * while a file is in flight in the inbox. A file modified in the last 10 minutes is skipped (it may still be downloading).
 */
import { fork, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createWriteStream, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  appendManifest, archiveFile, defaultArchiveDir, latestByName, openSource, readManifest, removeStaleParts, sourcesSyncSql, verifyEntry, type ManifestEntry,
} from '@/lib/source-archive'
import { FREE_MARGIN_BYTES, MIN_AGE_MS, inboxIsBusy, replaceOriginal, replaceRefusals, spaceRefusal } from '@/lib/archive-replace'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
const die = (message: string, code = 2): never => { console.error(message); process.exit(code) }

const ARCHIVE = defaultArchiveDir(flag('out') ? { ...process.env, ULP_ARCHIVE_DIR: flag('out') } : process.env)
const REPO = process.env.ULP_REPO ?? process.cwd()
const INBOX = join(REPO, 'inbox')
const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const GiB = 1024 ** 3
/** Free space that must remain besides the work itself (10 GiB); ULP_ARCHIVE_FREE_MARGIN_BYTES lowers it for tests and small CI runners. */
const MARGIN = process.env.ULP_ARCHIVE_FREE_MARGIN_BYTES !== undefined ? Number(process.env.ULP_ARCHIVE_FREE_MARGIN_BYTES) : FREE_MARGIN_BYTES

// ── ClickHouse through docker exec, like scripts/pile/*.sh ──────────────────────────────────────────

function clickhouse(sql: string): string {
  const r = spawnSync('docker', ['exec', CH, 'clickhouse-client', '-q', sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`clickhouse-client failed: ${(r.stderr ?? '').slice(0, 300)}`)
  return r.stdout
}

function clickhouseScript(script: string): void {
  const r = spawnSync('docker', ['exec', '-i', CH, 'clickhouse-client', '-n'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`clickhouse-client failed: ${(r.stderr ?? '').slice(0, 300)}`)
}

function listSourceNames(): Set<string> {
  const out = clickhouse('SELECT filename FROM ulp.sources FORMAT JSONEachRow')
  return new Set(out.split('\n').filter(l => l.trim() !== '').map(l => (JSON.parse(l) as { filename: string }).filename))
}

// ── the worker: one file at a time ──────────────────────────────────────────────────────────────────

interface Job { src: string; name: string; size: number; mtimeMs: number; replace: boolean; entry?: ManifestEntry }
interface Done { name: string; ok: boolean; fresh: boolean; entry?: ManifestEntry; problems: string[]; error?: string }

function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(8 << 20)
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function runJob(job: Job): Done {
  try {
    if (job.entry) {
      // archived by an earlier run: decode it again, and for --replace prove that the original still equals it
      const v = verifyEntry(ARCHIVE, job.entry)
      const problems = [...v.problems]
      if (job.replace && v.ok && sha256File(job.src) !== job.entry.sha256) problems.push('the original no longer matches its archive')
      return { name: job.name, ok: problems.length === 0, fresh: false, entry: job.entry, problems }
    }
    const entry = archiveFile(job.src, {
      archiveDir: ARCHIVE,
      name: job.name,
      lookupById: id => [...readManifest(ARCHIVE)].reverse().find(e => e.id === id),
    })
    const v = verifyEntry(ARCHIVE, entry)
    return { name: job.name, ok: v.ok, fresh: true, entry, problems: v.problems }
  } catch (err) {
    return { name: job.name, ok: false, fresh: false, problems: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function runPool(jobs: Job[], workers: number, canContinue: () => boolean, onDone: (job: Job, done: Done) => void): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, () => new Promise<void>(resolve => {
    const w = fork(process.argv[1], ['--worker'], { execArgv: process.execArgv, env: { ...process.env, ULP_ARCHIVE_DIR: ARCHIVE } })
    let current: Job | null = null
    w.on('exit', code => {
      if (current) onDone(current, { name: current.name, ok: false, fresh: false, problems: [], error: `worker exited (${code})` })
      current = null
      resolve()
    })
    const feed = () => {
      if (next >= jobs.length || !canContinue()) { w.kill(); return }
      current = jobs[next++]
      w.send(current)
    }
    w.on('message', (done: Done) => { const job = current as Job; current = null; onDone(job, done); feed() })
    feed()
  })))
}

// ── commands ────────────────────────────────────────────────────────────────────────────────────────

async function cmdArchive(): Promise<void> {
  const src = flag('src')
  if (!src) die('usage: archive --src <dir> [--out <dir>] [--workers 8] [--only a,b] [--replace] [--include-unimported] [--no-sources] [--dry-run]')
  if (!existsSync(ARCHIVE)) die(`the archive directory does not exist: ${ARCHIVE} (create it yourself; the tool never creates it)`)
  const stale = removeStaleParts(ARCHIVE)
  if (stale.length > 0) console.log(`removed ${stale.length} leftover .part file(s) of an interrupted run`)
  const replace = has('replace')
  const includeUnimported = has('include-unimported')
  const dry = has('dry-run')
  const only = flag('only')?.split(',')

  let inSources = new Set<string>()
  if (replace) {
    try { inSources = listSourceNames() } catch (e) { die(`--replace needs ulp.sources and ClickHouse did not answer: ${(e as Error).message}`) }
  }

  const latest = latestByName(readManifest(ARCHIVE))
  const now = Date.now()
  const jobs: Job[] = []
  const young: string[] = []
  let already = 0
  const names = readdirSync(src).filter(n => n.toLowerCase().endsWith('.txt') && (!only || only.includes(n))).sort()
  for (const name of names) {
    const path = join(src, name)
    const st = statSync(path)
    if (now - st.mtimeMs < MIN_AGE_MS) { young.push(name); continue }
    const prev = latest.get(name)
    const archivedBefore = !!prev && prev.size === st.size && existsSync(join(ARCHIVE, `${prev.id}.zst`))
    if (archivedBefore && !replace) { already++; continue }
    jobs.push({ src: path, name, size: st.size, mtimeMs: st.mtimeMs, replace, entry: archivedBefore ? prev : undefined })
  }

  const free = () => { const s = statfsSync(ARCHIVE); return Number(s.bavail) * Number(s.bsize) }
  const largest = jobs.reduce((m, j) => Math.max(m, j.entry ? 0 : j.size), 0)
  const space = largest > 0 ? spaceRefusal(free(), largest, MARGIN) : null
  if (space) die(`not starting: ${space}`)

  if (dry) {
    const busy = inboxIsBusy(INBOX)
    const wouldKeep = replace ? jobs.filter(j => replaceRefusals({ nowMs: now, mtimeMs: j.mtimeMs, inboxBusy: busy, inSources: inSources.has(j.name), includeUnimported }).length > 0).length : 0
    console.log(`dry run: ${jobs.length} to archive or confirm, ${already} already archived, ${young.length} too young${replace ? `, ${wouldKeep} would be kept` : ''}; nothing was written`)
    return
  }

  const stats = { archived: 0, replaced: 0, kept: 0, failed: 0, plain: 0 }
  const keep = (name: string, why: string) => { stats.kept++; console.log(`kept ${name}: ${why}`) }
  let halted = ''
  await runPool(jobs, Math.max(1, Number(flag('workers') ?? '8')), () => {
    const p = spaceRefusal(free(), 0, MARGIN)
    if (p) halted = p
    return !p
  }, (job, done) => {
    if (!done.ok || !done.entry) { stats.failed++; console.log(`FAILED ${job.name}: ${done.error ?? done.problems.join('; ')}`); return }
    if (done.fresh) { appendManifest(ARCHIVE, done.entry); stats.archived++ }
    stats.plain += done.entry.size
    if (!replace) return
    const why = replaceRefusals({ nowMs: Date.now(), mtimeMs: job.mtimeMs, inboxBusy: inboxIsBusy(INBOX), inSources: inSources.has(job.name), includeUnimported })
    if (why.length > 0) { keep(job.name, why.join('; ')); return }
    try {
      replaceOriginal(job.src, [join(INBOX, 'done')], { size: job.size, mtimeMs: job.mtimeMs })
      appendManifest(ARCHIVE, { ...done.entry, replaced_at: new Date().toISOString() })
      stats.replaced++
    } catch (e) {
      keep(job.name, (e as Error).message)
    }
  })

  if (halted) console.log(`stopped early: ${halted}`)
  console.log(`archived ${stats.archived}, already archived ${already}, too young ${young.length}, replaced ${stats.replaced}, kept ${stats.kept}, failed ${stats.failed}; plaintext ${(stats.plain / GiB).toFixed(2)} GiB`)
  if (!has('no-sources')) {
    try {
      clickhouseScript(sourcesSyncSql([...latestByName(readManifest(ARCHIVE)).values()]))
    } catch (e) {
      console.log(`ulp.sources was not updated (${(e as Error).message}); run sources-sync later`)
    }
  }
  process.exit(stats.failed > 0 ? 1 : 0)
}

function cmdStatus(): void {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  const plain = entries.reduce((a, e) => a + e.size, 0)
  const unique = new Map(entries.map(e => [e.id, e.archive_bytes]))
  const comp = [...unique.values()].reduce((a, b) => a + b, 0)
  console.log(`archive ${ARCHIVE}`)
  console.log(
    `names ${entries.length} (${entries.filter(e => e.replaced_at).length} replaced), archives ${unique.size}, plaintext ${(plain / GiB).toFixed(2)} GiB, ` +
    `archive ${(comp / GiB).toFixed(2)} GiB${comp > 0 ? `, ratio ${(plain / comp).toFixed(2)}x` : ''}`,
  )
  try {
    const names = listSourceNames()
    const have = new Set(entries.map(e => e.name))
    console.log(`in ulp.sources: ${names.size}, without an archive: ${[...names].filter(n => !have.has(n)).length}`)
  } catch {
    console.log('ulp.sources: not readable (no ClickHouse)')
  }
}

function cmdVerify(): void {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  const count = has('all') ? entries.length : Math.min(entries.length, Number(flag('sample') ?? '3'))
  const picked = has('all') ? entries : [...entries].sort(() => Math.random() - 0.5).slice(0, count)
  let bad = 0
  picked.forEach((e, i) => {
    const v = verifyEntry(ARCHIVE, e)
    if (v.ok) console.log(`ok   ${i + 1}/${picked.length} ${e.id.slice(0, 8)}`)
    else { bad++; console.log(`FAIL ${i + 1}/${picked.length} ${e.name}: ${v.problems.join('; ')}`) }
  })
  console.log(`verified ${picked.length}, failed ${bad}`)
  process.exit(bad > 0 ? 1 : 0)
}

async function cmdRestore(): Promise<void> {
  const ref = argv[1]
  const to = flag('to')
  if (!ref || ref.startsWith('--') || !to) die('usage: restore <name|id> --to <path> [--out <dir>]')
  if (existsSync(to)) die(`refusing to overwrite ${to}`)
  const s = openSource(ref, { archiveDir: ARCHIVE })
  if (s.origin.kind !== 'archive' || !s.entry) die(`${ref} is a plain file, not an archived name`)
  const entry = s.entry as ManifestEntry
  const part = `${to}.part`
  const hash = createHash('sha256')
  const source = s.stream()
  source.on('data', (c: Buffer) => hash.update(c))
  try {
    await pipeline(source, createWriteStream(part, { flags: 'wx' }))
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
  if (hash.digest('hex') !== entry.sha256) {
    rmSync(part, { force: true })
    die('the restored bytes do not match the manifest; nothing was written', 1)
  }
  renameSync(part, to)
  console.log(`restored ${entry.size} bytes to ${to} (sha256 matches the manifest)`)
}

function cmdSourcesSync(): void {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  clickhouseScript(sourcesSyncSql(entries))
  console.log(`ulp.sources: identity columns ensured, ${entries.length} archived name(s) mapped`)
}

async function main(): Promise<void> {
  if (argv[0] === '--worker') {
    process.on('message', (job: Job) => process.send?.(runJob(job)))
    return
  }
  switch (argv[0]) {
    case 'archive': return cmdArchive()
    case 'status': return cmdStatus()
    case 'verify': return cmdVerify()
    case 'restore': return cmdRestore()
    case 'sources-sync': return cmdSourcesSync()
    default: die('usage: archive-sources.ts archive|status|verify|restore|sources-sync (see the header of this file)')
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
