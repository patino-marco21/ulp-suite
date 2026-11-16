/**
 * The reduced archive, shadow mode (docs/superpowers/plans/2026-11-15-reduced-archive.md, stage B). For an archived, imported file it writes a second, smaller entry beside
 * the whole-file one, in `<archive>/reduced/`: only the lines that added something, proven by importing that entry again and comparing it with the rows the database holds
 * for the file. It removes nothing, replaces nothing and changes nothing the other archive tools read. It never prints a line of a file.
 *
 *   tsx scripts/reduce-archive.ts run [--limit 20] [--pilot 50] [--only a.txt,b.txt] [--retry-failed] [--floor-gib 80] [--max-minutes 90] [--inbox <dir>] [--out <archive dir>]
 *   tsx scripts/reduce-archive.ts status [--out <archive dir>]
 *   tsx scripts/reduce-archive.ts verify [--sample 3 | --all] [--out <archive dir>]
 *
 * `run` takes the files archived since the shadow began (oldest first), up to --limit; --pilot N takes N older files instead (a seeded pick, none over 2 GiB); --only names
 * files, whatever their age. A file whose last attempt failed waits for --retry-failed. Nothing starts with less than --floor-gib free on the archive's filesystem, and the
 * run stops starting files after --max-minutes, and, with --inbox, as soon as a file is waiting or in flight there (the import comes first). Every result is a line in `reduced/shadow-log.jsonl`; `status` reads it and counts the exact results in a row (the gate).
 *
 * Environment: ULP_ARCHIVE_DIR (default ~/ulp-archive; must exist), CH_CONTAINER (ulpsuite_clickhouse). Exit 0 when nothing failed, 1 when a file failed, 2 on a usage or
 * setup problem.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { dockerCh } from '@/lib/clickhouse-cli'
import { inboxIsBusy } from '@/lib/archive-replace'
import { readReduced, reduceSource, reducedDir } from '@/lib/reduced-archive'
import { chReduceDb } from '@/lib/reduced-archive-ch'
import {
  GATE_FILES, appendShadowLog, consecutiveExact, pickCandidates, readShadowLog, readShadowStart, summarize, type ShadowLine,
} from '@/lib/reduced-shadow'
import { defaultArchiveDir, latestByName, readManifest, removeStaleParts, verifyEntry } from '@/lib/source-archive'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
function die(message: string, code = 2): never { console.error(message); process.exit(code) }

const ARCHIVE = defaultArchiveDir(flag('out') ? { ...process.env, ULP_ARCHIVE_DIR: flag('out') } : process.env)
const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const GiB = 1024 ** 3
const gib = (n: number) => (n / GiB).toFixed(2)
const free = () => { const s = statfsSync(ARCHIVE); return Number(s.bavail) * Number(s.bsize) }

/** One run at a time: a lock file in reduced/ that names the process holding it; a lock whose process is gone is taken over. */
function takeLock(): (() => void) | null {
  const path = join(reducedDir(ARCHIVE), '.lock')
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

async function cmdRun(): Promise<number> {
  if (!existsSync(ARCHIVE)) die(`the archive directory does not exist: ${ARCHIVE} (create it yourself; the tool never creates it)`)
  const floor = Number(flag('floor-gib') ?? '80') * GiB
  if (free() < floor) {
    console.log(`not starting: ${gib(free())} GiB free on the archive's filesystem, under the ${gib(floor)} GiB floor`)
    return 0
  }
  mkdirSync(reducedDir(ARCHIVE), { recursive: true })
  const release = takeLock()
  if (!release) { console.log('another run holds the lock; nothing started'); return 0 }
  const work = join(reducedDir(ARCHIVE), 'work')
  try {
    removeStaleParts(reducedDir(ARCHIVE))
    rmSync(work, { recursive: true, force: true })   // leftovers of a run that was killed: the lock says no other run is alive
    const ch = dockerCh(CH, { maxMemoryBytes: 4_000_000_000 })
    let inSources: Set<string>
    try {
      const out = await ch.run('SELECT filename FROM ulp.sources FORMAT JSONEachRow')
      inSources = new Set(out.split('\n').filter(l => l.trim() !== '').map(l => (JSON.parse(l) as { filename: string }).filename))
    } catch (e) {
      console.log(`ClickHouse did not answer (${(e as Error).message}); nothing started`)
      return 0
    }
    const startedAt = readShadowStart(ARCHIVE)
    const only = flag('only')?.split(',')
    const pilot = flag('pilot') ? Number(flag('pilot')) : 0
    const entries = [...latestByName(readManifest(ARCHIVE)).values()].filter(e => !only || only.includes(e.name))
    const picks = pickCandidates({
      entries, reduced: readReduced(ARCHIVE), log: readShadowLog(ARCHIVE), inSources, startedAt,
      mode: only ? 'any' : pilot > 0 ? 'pilot' : 'new',
      limit: pilot > 0 ? pilot : Number(flag('limit') ?? '20'),
      retryFailed: has('retry-failed'), seed: startedAt,
      archiveHolds: e => existsSync(join(ARCHIVE, `${e.id}.zst`)),
    })
    console.log(`${picks.length} file(s) to reduce (${only ? 'named' : pilot > 0 ? 'pilot' : 'new since the shadow began'})`)
    const inbox = flag('inbox')
    const deadline = Date.now() + Number(flag('max-minutes') ?? '90') * 60_000
    let ok = 0, failed = 0
    for (const entry of picks) {
      if (Date.now() > deadline) { console.log('stopped: the time budget is used up'); break }
      if (free() < floor) { console.log(`stopped: free space fell under the ${gib(floor)} GiB floor`); break }
      if (inbox && inboxIsBusy(inbox)) { console.log('stopped: a file is waiting or in flight in the inbox'); break }
      const t0 = Date.now()
      const out = await reduceSource({ entry, archiveDir: ARCHIVE, db: chReduceDb(ch), workDir: work })
      const ms = Date.now() - t0
      const kind = entry.created_at >= startedAt ? 'new' : 'pilot'
      const base = { name: entry.name, sha256: entry.sha256, at: new Date().toISOString(), kind, ms } as const
      let line: ShadowLine
      if (out.ok) {
        ok++
        const pct = entry.size > 0 ? (100 * out.entry.size) / entry.size : 0
        line = { ...base, ok: true, keptPct: Number(pct.toFixed(2)), parsed: out.stats.parsed, mine: out.stats.mine, known: out.stats.known, absent: out.stats.absent, extra_known: out.entry.extra_known, drift: out.entry.db_drift }
        console.log(`reduced ${entry.name}: ${pct.toFixed(1)}% of ${gib(entry.size)} GiB kept (${out.stats.mine} new, ${out.stats.absent} absent, ${out.stats.known} known dropped, ${out.stats.repeats} repeats, ${out.entry.extra_known} known inside records${out.entry.db_drift > 0 ? `, ${out.entry.db_drift} of ${out.entry.db_keys} stored keys no longer read by the parser` : ''}) in ${(ms / 1000).toFixed(0)} s`)
      } else {
        failed++
        line = { ...base, ok: false, reason: out.reason, detail: out.detail.slice(0, 300), parsed: out.stats?.parsed }
        console.log(`FAILED ${entry.name}: ${out.reason}: ${out.detail}`)
      }
      appendShadowLog(ARCHIVE, line)
    }
    console.log(`reduced ${ok}, failed ${failed}`)
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
  if (s.driftFiles > 0) console.log(`drift: ${s.driftFiles} reduced file(s) hold ${s.driftKeys} stored keys that today's parser no longer reads from them (older parser versions stored them)`)
  // by file: the latest result of each (name, bytes)
  const latestPilot = new Map<string, ShadowLine>()
  for (const l of log) if (l.kind === 'pilot') latestPilot.set(`${l.name}\0${l.sha256}`, l)
  const pilot = [...latestPilot.values()]
  if (pilot.length > 0) console.log(`pilot: ${pilot.filter(l => l.ok).length} exact, ${pilot.filter(l => !l.ok).length} failed of ${pilot.length} tried`)
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

async function main(): Promise<number> {
  switch (argv[0]) {
    case 'run': return cmdRun()
    case 'status': return cmdStatus()
    case 'verify': return cmdVerify()
    default: return die('usage: reduce-archive.ts run|status|verify (see the header of this file)')
  }
}

main().then(code => process.exit(code), err => { console.error(err instanceof Error ? err.message : err); process.exit(2) })
