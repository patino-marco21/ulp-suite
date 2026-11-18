/**
 * The reduced archive, shadow mode (docs/superpowers/plans/2026-11-15-reduced-archive.md, stage B). For an archived, imported file it writes a second, smaller entry beside
 * the whole-file one, in `<archive>/reduced/`: only the lines that added something, proven by importing that entry again and comparing it with the rows the database holds
 * for the file. `run` removes nothing, replaces nothing and changes nothing the other archive tools read; `swap --apply` (stage D, below) is the one command that removes a whole-file entry. It never prints a line of a file.
 *
 *   tsx scripts/reduce-archive.ts run [--limit 20] [--pilot 50] [--pilot-max-gib 2] [--only a.txt,b.txt] [--only-sha 1a2b3c,...] [--recompact-over 50] [--retry-failed] [--floor-gib 80] [--max-minutes 90] [--workers 1] [--inbox <dir>] [--out <archive dir>]
 *   tsx scripts/reduce-archive.ts status [--out <archive dir>]
 *   tsx scripts/reduce-archive.ts verify [--sample 3 | --all] [--out <archive dir>]
 *   tsx scripts/reduce-archive.ts report [--no-verify] [--out <archive dir>]
 *   tsx scripts/reduce-archive.ts swap [--apply] [--limit N] [--only a.txt,b.txt] [--batch-gib G] [--out <archive dir>]
 *
 * Stage D (docs/superpowers/plans/2026-11-16-reduced-archive-stage-d.md): `report` prints, in numbers, what swapping the whole-file entries for their reduced entries would free and the
 * go/no-go lines; it changes nothing. `swap` is a dry run unless `--apply`; with it, it swaps the smallest eligible entries first (an entry is eligible when its reduced entry is exact and at least
 * 10% smaller on disk), stops at the first failure, and checks each swap it made. It takes the same lock as `run`, so it never runs beside a reduction, and with `--apply` the archive timer's lock too, so that run never finds a whole file missing; nothing calls it on a timer: it is
 * run by hand, after the owner's yes.
 *
 * `run` takes the files archived since the shadow began (oldest first), up to --limit; --pilot N takes N older files instead (a seeded pick, none over --pilot-max-gib, default 2); --only names
 * files, whatever their age (--only-sha names them by the start of their sha256, for a name with a comma in it); --recompact-over N makes the reduced entry again of the files whose
 * entry was written before the compaction and kept N percent or more of the file, the biggest entry first. A file whose last attempt failed waits for --retry-failed. Nothing starts with less than --floor-gib free on the archive's filesystem, and the
 * run stops starting files after --max-minutes, and, with --inbox, as soon as a file is waiting or in flight there (the import comes first). Every result is a line in `reduced/shadow-log.jsonl`; `status` reads it and counts the exact results in a row (the gate).
 *
 * --workers N (1 to 8, default 1) starts N copies of this command as workers on the same archive. The coordinator keeps the one lock; each worker takes a file by creating a claim for it
 * (lib/reduced-claims.ts), has a work directory of its own and its own scratch tables, and looks again at the files and the log after it has the claim, so no file is done twice. The
 * coordinator drops the scratch tables and the claims a killed run left behind when it starts, prints the summed `reduced N, failed M`, and stops its workers when it is stopped; a worker
 * stops by itself when its coordinator is gone. `touch <archive>/reduced/.stop` asks every worker to finish the file it has and start no other. Measured: one worker uses one core for
 * two thirds of its time (the parse is one thread) and the machine's other cores are idle.
 *
 * Environment: ULP_ARCHIVE_DIR (default ~/ulp-archive; must exist), CH_CONTAINER (ulpsuite_clickhouse). Exit 0 when nothing failed, 1 when a file failed, 2 on a usage or
 * setup problem.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { dockerCh } from '@/lib/clickhouse-cli'
import { inboxIsBusy } from '@/lib/archive-replace'
import { readReduced, reduceSource, reducedDir } from '@/lib/reduced-archive'
import { runSwap, standInsLosingRestore, swapCandidates, swapReport } from '@/lib/archive-swap'
import { defaultLedgerFile, standInRegistryFile } from '@/lib/ledger-export'
import { chReduceDb } from '@/lib/reduced-archive-ch'
import { claimKey, claimsDir, clearClaims, isAlive, releaseClaim, tryClaim, workerArgs } from '@/lib/reduced-claims'
import {
  GATE_FILES, appendShadowLog, consecutiveExact, pickCandidates, readShadowLog, readShadowStart, summarize, type ShadowLine, SKIP_REASON,
} from '@/lib/reduced-shadow'
import { defaultArchiveDir, latestByName, readManifest, removeStaleParts, verifyEntry, type ManifestEntry } from '@/lib/source-archive'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
function die(message: string, code = 2): never { console.error(message); process.exit(code) }

const ARCHIVE = defaultArchiveDir(flag('out') ? { ...process.env, ULP_ARCHIVE_DIR: flag('out') } : process.env)
const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const GiB = 1024 ** 3
const gib = (n: number) => (n / GiB).toFixed(2)
const free = () => { const s = statfsSync(ARCHIVE); return Number(s.bavail) * Number(s.bsize) }

/** Set on a worker that a coordinator (`run --workers N`) started: its number, and the pid of the coordinator, which holds the lock for all of them. */
const WORKER = Number(process.env.REDUCE_WORKER ?? '0')
const PARENT = Number(process.env.REDUCE_LOCK_PID ?? '0')
const tag = WORKER > 0 ? `[w${WORKER}] ` : ''
const MAX_WORKERS = 8
/** `touch reduced/.stop`: no worker starts another file, and each finishes the one it has. The next `run` removes it when it starts. */
const stopFile = () => join(reducedDir(ARCHIVE), '.stop')

/** One run at a time: a lock file (by default reduced/.lock) that names the process holding it; a lock whose process is gone is taken over. */
function takeLock(path: string = join(reducedDir(ARCHIVE), '.lock')): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => rmSync(path, { force: true })
    } catch {
      let holder = 0
      try { holder = Number(readFileSync(path, 'utf8')) } catch { /* gone meanwhile */ }
      let alive = false
      if (holder > 0) { try { process.kill(holder, 0); alive = true } catch { /* no such process */ } }
      if (alive) return null
      rmSync(path, { force: true })
    }
  }
  return null
}

/** The scratch tables of a run that was killed (reduceSource drops its own whatever happens, but not when the process is gone). Called under the lock, when no run is alive. */
async function sweepScratch(ch: ReturnType<typeof dockerCh>): Promise<number> {
  const out = await ch.run(`SELECT name FROM system.tables WHERE database = 'default' AND startsWith(name, 'zz_red_') FORMAT TSV`)
  let n = 0
  for (const name of out.split('\n').map(l => l.trim()).filter(l => /^zz_red_\d+_[0-9a-f]+_[a-z]$/.test(l))) {
    await ch.run(`DROP TABLE IF EXISTS default.${name} SYNC`)
    n++
  }
  return n
}

interface WorkerResult { ok: number; failed: number; skipped: number }

/** Starts `count` copies of this command as workers and waits for them. Each reports its counts over the IPC channel; one that ends without a report counts as a failure. */
function runWorkers(count: number, release: () => void): Promise<WorkerResult> {
  const args = [...process.execArgv, process.argv[1], ...workerArgs(argv)]
  const sum: WorkerResult = { ok: 0, failed: 0, skipped: 0 }
  const children: ChildProcess[] = []
  const stopAll = () => { for (const c of children) c.kill('SIGTERM') }
  const onSignal = (sig: NodeJS.Signals) => { stopAll(); release(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)) }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  const done: Array<Promise<void>> = []
  for (let i = 1; i <= count; i++) {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, REDUCE_WORKER: String(i), REDUCE_LOCK_PID: String(process.pid) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    children.push(child)
    let reported = false
    child.on('message', m => {
      const r = m as WorkerResult
      reported = true
      sum.ok += r.ok; sum.failed += r.failed; sum.skipped += r.skipped
    })
    done.push(new Promise(resolve => {
      child.on('exit', (code, signal) => {
        if (!reported) { sum.failed++; console.log(`worker ${i} ended without a result (${signal ? `signal ${signal}` : `exit code ${code}`})`) }
        resolve()
      })
    }))
  }
  return Promise.all(done).then(() => {
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
    return sum
  })
}

async function cmdRun(): Promise<number> {
  if (!existsSync(ARCHIVE)) die(`the archive directory does not exist: ${ARCHIVE} (create it yourself; the tool never creates it)`)
  const workers = Number(flag('workers') ?? '1')
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) die(`--workers takes a whole number from 1 to ${MAX_WORKERS}`)
  const floor = Number(flag('floor-gib') ?? '80') * GiB
  if (free() < floor) {
    console.log(`${tag}not starting: ${gib(free())} GiB free on the archive's filesystem, under the ${gib(floor)} GiB floor`)
    return 0
  }
  mkdirSync(reducedDir(ARCHIVE), { recursive: true })
  // A worker started by a coordinator does not take the lock: the coordinator holds it for all of them, and a worker whose coordinator is gone stops.
  const release = WORKER > 0 ? () => undefined : takeLock()
  if (!release) { console.log('another run holds the lock; nothing started'); return 0 }
  const workRoot = join(reducedDir(ARCHIVE), 'work')
  const work = WORKER > 0 ? join(workRoot, String(WORKER)) : workRoot
  const claimDir = claimsDir(ARCHIVE)
  try {
    if (WORKER === 0) {
      removeStaleParts(reducedDir(ARCHIVE))
      rmSync(workRoot, { recursive: true, force: true })   // leftovers of a run that was killed: the lock says no other run is alive
      clearClaims(claimDir)
      rmSync(stopFile(), { force: true })                   // a stop asked for a run that was going; this is a new one
    } else {
      setInterval(() => { if (!isAlive(PARENT)) process.exit(143) }, 5000).unref()
    }
    const ch = dockerCh(CH, { maxMemoryBytes: 4_000_000_000 })
    const importedRows = new Map<string, number>()   // ulp.sources: file name -> the rows its import stored
    try {
      const out = await ch.run('SELECT filename, line_count FROM ulp.sources FORMAT JSONEachRow')
      for (const l of out.split('\n').filter(l => l.trim() !== '')) {
        const r = JSON.parse(l) as { filename: string; line_count: string | number }
        importedRows.set(r.filename, Math.max(importedRows.get(r.filename) ?? 0, Number(r.line_count)))
      }
    } catch (e) {
      console.log(`${tag}ClickHouse did not answer (${(e as Error).message}); nothing started`)
      return 0
    }
    if (WORKER === 0) {
      try {
        const swept = await sweepScratch(ch)
        if (swept > 0) console.log(`dropped ${swept} scratch table(s) left by a run that was killed`)
      } catch (e) {
        console.log(`the scratch tables of an earlier run could not be listed (${(e as Error).message}); going on`)
      }
    }
    const startedAt = readShadowStart(ARCHIVE)
    const only = flag('only')?.split(',')
    const onlySha = flag('only-sha')?.split(',').filter(p => p !== '')
    const named = only !== undefined || onlySha !== undefined
    const pilot = flag('pilot') ? Number(flag('pilot')) : 0
    const recompactOver = flag('recompact-over') ? Number(flag('recompact-over')) : undefined
    if (recompactOver !== undefined && !(recompactOver >= 0 && recompactOver <= 100)) die('--recompact-over takes a percent between 0 and 100')
    const entries = [...latestByName(readManifest(ARCHIVE)).values()].filter(e => (!only || only.includes(e.name)) && (!onlySha || onlySha.some(p => e.sha256.startsWith(p))))
    const pickWith = (list: ManifestEntry[], limit: number) => pickCandidates({
      entries: list, reduced: readReduced(ARCHIVE), log: readShadowLog(ARCHIVE), inSources: new Set(importedRows.keys()), startedAt,
      mode: named ? 'any' : pilot > 0 ? 'pilot' : 'new', maxBytes: flag('pilot-max-gib') ? Number(flag('pilot-max-gib')) * GiB : undefined,
      redo: recompactOver === undefined ? undefined : r => r.placeholders === undefined && r.of.size > 0 && (100 * r.size) / r.of.size >= recompactOver,
      limit,
      retryFailed: has('retry-failed'), seed: startedAt,
      archiveHolds: e => existsSync(join(ARCHIVE, `${e.id}.zst`)),
    })
    const picks = pickWith(entries, pilot > 0 ? pilot : Number(flag('limit') ?? '20'))
    console.log(`${tag}${picks.length} file(s) to reduce (${recompactOver !== undefined ? `again, compacted: entries over ${recompactOver}%` : named ? 'named' : pilot > 0 ? 'pilot' : 'new since the shadow began'})`)
    if (WORKER === 0 && workers > 1 && picks.length > 1) {
      const n = Math.min(workers, picks.length)
      console.log(`starting ${n} workers`)
      const sum = await runWorkers(n, release)
      console.log(`reduced ${sum.ok}, failed ${sum.failed}${sum.skipped > 0 ? `, skipped ${sum.skipped}` : ''}`)
      return sum.failed > 0 ? 1 : 0
    }
    const claiming = WORKER > 0
    const inbox = flag('inbox')
    const deadline = Date.now() + Number(flag('max-minutes') ?? '90') * 60_000
    let ok = 0, failed = 0, skipped = 0
    for (const entry of picks) {
      if (Date.now() > deadline) { console.log(`${tag}stopped: the time budget is used up`); break }
      if (free() < floor) { console.log(`${tag}stopped: free space fell under the ${gib(floor)} GiB floor`); break }
      if (inbox && inboxIsBusy(inbox)) { console.log(`${tag}stopped: a file is waiting or in flight in the inbox`); break }
      if (existsSync(stopFile())) { console.log(`${tag}stopped: ${stopFile()} exists`); break }
      if (WORKER > 0 && !isAlive(PARENT)) { console.log(`${tag}stopped: the coordinator is gone`); break }
      const key = claimKey(entry.name, entry.sha256)
      if (claiming) {
        if (!tryClaim(claimDir, key)) continue                 // another worker has it
        if (pickWith([entry], 1).length === 0) { releaseClaim(claimDir, key); continue }   // another worker finished it since the list was made
      }
      try {
        const t0 = Date.now()
        const out = await reduceSource({ entry, archiveDir: ARCHIVE, db: chReduceDb(ch), workDir: work, imported: importedRows.get(entry.name) })
        const ms = Date.now() - t0
        const kind = entry.created_at >= startedAt ? 'new' : 'pilot'
        const base = { name: entry.name, sha256: entry.sha256, at: new Date().toISOString(), kind, ms } as const
        let line: ShadowLine
        if (out.ok) {
          ok++
          const pct = entry.size > 0 ? (100 * out.entry.size) / entry.size : 0
          const fallback = out.stats.compactFallback
          line = {
            ...base, ok: true, keptPct: Number(pct.toFixed(2)), parsed: out.stats.parsed, mine: out.stats.mine, known: out.stats.known, absent: out.stats.absent, extra_known: out.entry.extra_known,
            drift: out.entry.db_drift, placeholders: out.stats.placeholders, ...(fallback ? { fallback: true } : {}),
          }
          console.log(`${tag}reduced ${entry.name}: ${pct.toFixed(1)}% of ${gib(entry.size)} GiB kept (${out.stats.mine} new, ${out.stats.absent} absent, ${out.stats.known} known dropped, ${out.stats.repeats} repeats, ${out.entry.extra_known} known inside records, ${out.stats.placeholders} placeholder lines${fallback ? `; the compacted copy failed its proof (${fallback.missing} missing, ${fallback.spurious} spurious) and the spans were kept whole` : ''}${out.entry.db_drift > 0 ? `, ${out.entry.db_drift} of ${out.entry.db_keys} stored keys no longer read by the parser` : ''}) in ${(ms / 1000).toFixed(0)} s`)
        } else if (out.reason === SKIP_REASON) {
          skipped++   // left whole on purpose, not a failure of the writer
          line = { ...base, ok: false, reason: out.reason, detail: out.detail.slice(0, 300), parsed: out.stats?.parsed }
          console.log(`${tag}skipped ${entry.name}: ${out.detail}`)
        } else {
          failed++
          line = { ...base, ok: false, reason: out.reason, detail: out.detail.slice(0, 300), parsed: out.stats?.parsed }
          console.log(`${tag}FAILED ${entry.name}: ${out.reason}: ${out.detail}`)
        }
        appendShadowLog(ARCHIVE, line)
      } finally {
        if (claiming) releaseClaim(claimDir, key)
      }
    }
    console.log(`${tag}reduced ${ok}, failed ${failed}${skipped > 0 ? `, skipped ${skipped}` : ''}`)
    if (WORKER > 0 && process.send) await new Promise<void>(resolve => process.send!({ ok, failed, skipped } satisfies WorkerResult, () => resolve()))
    return failed > 0 ? 1 : 0
  } finally {
    rmSync(work, { recursive: true, force: true })
    release()
  }
}

function cmdStatus(): number {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  const reduced = readReduced(ARCHIVE)
  const log = readShadowLog(ARCHIVE)
  const s = summarize({ entries, reduced, log })
  const started = existsSync(join(reducedDir(ARCHIVE), 'shadow.json')) ? readShadowStart(ARCHIVE) : 'not started'
  console.log(`reduced archive ${reducedDir(ARCHIVE)} (shadow since ${started})`)
  console.log(`reduced entries ${s.reducedFiles} of ${entries.length} archived names`)
  if (s.reducedFiles > 0) {
    console.log(`plaintext ${gib(s.wholeBytes)} GiB -> ${gib(s.reducedBytes)} GiB (${s.sharePct.toFixed(1)}%); on disk ${gib(s.wholeArchiveBytes)} GiB -> ${gib(s.reducedArchiveBytes)} GiB (${s.wholeArchiveBytes > 0 ? ((100 * s.reducedArchiveBytes) / s.wholeArchiveBytes).toFixed(1) : '0'}%)`)
  }
  const reasons = Object.entries(s.failuresByReason).map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(`gate: ${consecutiveExact(log)} of ${GATE_FILES} new files exact in a row; failures now: ${reasons || 'none'}`)
  if (s.skippedLongLine > 0) console.log(`left whole on purpose: ${s.skippedLongLine} file(s) hold a line over 1 MiB, which no reader parses the same way twice (neither counted nor a failure)`)
  if (s.reducedFiles > 0) console.log(`compaction: ${s.compactedFiles} of ${s.reducedFiles} reduced file(s) carry placeholder lines (${s.placeholders} lines)${s.compactFallbacks > 0 ? `; ${s.compactFallbacks} fell back to whole spans after the compacted copy failed its proof` : ''}`)
  if (s.driftFiles > 0) console.log(`drift: ${s.driftFiles} reduced file(s) hold ${s.driftKeys} stored keys that today's parser no longer reads from them (older parser versions stored them)`)
  // by file: the latest result of each (name, bytes)
  const latestPilot = new Map<string, ShadowLine>()
  for (const l of log) if (l.kind === 'pilot') latestPilot.set(`${l.name}\0${l.sha256}`, l)
  const pilot = [...latestPilot.values()]
  if (pilot.length > 0) {
    const skippedPilot = pilot.filter(l => !l.ok && l.reason === SKIP_REASON).length
    console.log(`pilot: ${pilot.filter(l => l.ok).length} exact, ${pilot.filter(l => !l.ok).length - skippedPilot} failed${skippedPilot > 0 ? `, ${skippedPilot} left whole` : ''} of ${pilot.length} tried`)
  }
  return 0
}

function cmdVerify(): number {
  const reduced = [...latestByName(readReduced(ARCHIVE)).values()]
  const count = has('all') ? reduced.length : Math.min(reduced.length, Number(flag('sample') ?? '3'))
  const picked = has('all') ? reduced : [...reduced].sort(() => Math.random() - 0.5).slice(0, count)
  let bad = 0
  for (const [i, e] of picked.entries()) {
    const v = verifyEntry(reducedDir(ARCHIVE), e)
    if (v.ok) console.log(`ok   ${i + 1}/${picked.length} ${e.id.slice(0, 8)}`)
    else { bad++; console.log(`FAIL ${i + 1}/${picked.length} ${e.name}: ${v.problems.join('; ')}`) }
  }
  const stray = existsSync(reducedDir(ARCHIVE))
    ? readdirSync(reducedDir(ARCHIVE)).filter(n => n.endsWith('.zst')).filter(n => !reduced.some(e => `${e.id}.zst` === n) && statSync(join(reducedDir(ARCHIVE), n)).size > 0).length
    : 0
  console.log(`verified ${picked.length}, failed ${bad}${stray > 0 ? `, ${stray} archive file(s) in reduced/ that no manifest line names` : ''}`)
  return bad > 0 ? 1 : 0
}

function swapInputs() {
  const wholes = latestByName(readManifest(ARCHIVE))
  return { wholes, reduced: readReduced(ARCHIVE), log: readShadowLog(ARCHIVE), wholeOnDisk: (e: { id: string }) => existsSync(join(ARCHIVE, `${e.id}.zst`)) }
}

function cmdReport(): number {
  if (!existsSync(ARCHIVE)) die(`the archive directory does not exist: ${ARCHIVE}`)
  const r = swapReport({ ...swapInputs(), archiveDir: ARCHIVE, verify: !has('no-verify') })
  const left = Object.entries(r.left).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ')
  console.log(`stage D report for ${ARCHIVE}`)
  console.log(`names ${r.names}: ${r.swapped} already swapped, ${r.eligible} eligible, left whole: ${left || 'none'}`)
  console.log(`freed by the removal of the eligible whole files: ${gib(r.wholeBytesFreed)} GiB (the reduced entries that stand in for them, ${gib(r.reducedBytesKept)} GiB, are already on disk)`)
  console.log(`free now ${gib(free())} GiB; after the removal about ${gib(free() + r.wholeBytesFreed)} GiB`)
  console.log(`drift: ${r.driftFiles} eligible file(s) hold ${r.driftKeys} stored keys that today's parser no longer reads from them`)
  try {
    const registry = standInRegistryFile(defaultLedgerFile())
    const lost = standInsLosingRestore(existsSync(registry) ? readFileSync(registry, 'utf8') : '', swapCandidates(swapInputs()).eligible)
    console.log(`stand-ins that could no longer be restored from the archive: ${lost.count} (${gib(lost.bytes)} GiB of original size); the chat service holds the originals`)
  } catch (e) {
    console.log(`stand-ins: the registry could not be read (${(e as Error).message})`)
  }
  for (const c of r.checks) console.log(`${c.ok === null ? 'open' : c.ok ? 'ok  ' : 'NO  '} ${c.id}: ${c.text}`)
  if (r.verifyFailed.length > 0) console.log(`reduced entries that do not decode: ${r.verifyFailed.join(', ')}`)
  return 0
}

function cmdSwap(): number {
  if (!existsSync(ARCHIVE)) die(`the archive directory does not exist: ${ARCHIVE}`)
  const apply = has('apply')
  const release = takeLock()
  if (!release) die('another run holds the lock (a reduction reads the whole-file entries); nothing swapped', 2)
  // A swap removes whole files: the archive timer's run (archive-when-idle.ts) would find one missing mid-check and report a failure, so it takes that run's lock too.
  const releaseTimer = apply ? takeLock(join(ARCHIVE, '.auto-archive.lock')) : () => undefined
  if (!releaseTimer) { release(); die('the archive timer\'s run is going (it reads the whole-file entries); try again in a few minutes; nothing swapped', 2) }
  try {
    const { eligible } = swapCandidates(swapInputs())
    const only = flag('only')?.split(',')
    const out = runSwap({
      archiveDir: ARCHIVE, eligible, apply, only, limit: flag('limit') ? Number(flag('limit')) : undefined,
      batchBytes: flag('batch-gib') ? Number(flag('batch-gib')) * GiB : undefined,
    })
    if (!apply) {
      console.log(`dry run (nothing changed; --apply does it): ${out.planned} of ${eligible.length} eligible entries would be swapped, their whole files hold ${gib(out.plannedBytes)} GiB`)
      return 0
    }
    console.log(`swapped ${out.swapped} of ${out.planned}, freed ${gib(out.freedBytes)} GiB; checked afterwards ${out.checked}, problems ${out.problems.length}`)
    for (const p of out.problems) console.log(`PROBLEM ${p}`)
    if (out.failed) console.log(`STOPPED at ${out.failed.id}: ${out.failed.reason}`)
    return out.failed || out.problems.length > 0 ? 1 : 0
  } finally {
    releaseTimer()
    release()
  }
}

async function main(): Promise<number> {
  switch (argv[0]) {
    case 'run': return cmdRun()
    case 'status': return cmdStatus()
    case 'verify': return cmdVerify()
    case 'report': return cmdReport()
    case 'swap': return cmdSwap()
    default: return die('usage: reduce-archive.ts run|status|verify|report|swap (see the header of this file)')
  }
}

main().then(code => process.exit(code), err => { console.error(err instanceof Error ? err.message : err); process.exit(2) })
