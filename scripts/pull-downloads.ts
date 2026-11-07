/**
 * The mover (docs/superpowers/specs/2026-11-07-download-mover-design.md): looks at the chat client's download folder and
 *   - moves every FINISHED new download into the inbox and leaves a stand-in where it was (the client keeps showing it as downloaded; the importer takes the file),
 *   - swaps a download whose bytes are already ingested and archived for a stand-in (the disk comes back),
 *   - leaves everything else alone, and above all leaves a download the client is still writing: a file moved before it is complete keeps growing in the inbox and the
 *     importer misses the lines that arrive after it read the file (lib/download-ready.ts says what "finished" means).
 * Then it rewrites the status pages in the pipeline folder (lib/pipeline-status.ts).
 *
 *   tsx scripts/pull-downloads.ts [--apply] [--dir <folder>] [--quiet <minutes>] [--ext txt] [--min-size 1000000] [--ledger <file>] [--archive <dir>] [--no-refresh]
 *
 * Without --apply it only says what it would do and writes nothing. Run every minute by a systemd user timer (scripts/systemd/ulp-pull-downloads.timer).
 * Environment: ULP_DOWNLOAD_DIR (default ~/Downloads/AyuGram Desktop), ULP_REPO (the checkout whose ./inbox is used; default the current directory), ULP_ARCHIVE_DIR,
 * ULP_LEDGER_FILE / ULP_PIPELINE_DIR (where the ledger copy and the status pages live; default ~/Desktop/ulp-pipeline), ULP_MOVER_QUIET_MIN (default 3), ULP_MOVER=off (the
 * run does nothing), ULP_STANDIN_SWEEP=off (the same switch the earlier swap-only pass had).
 * Exit 0 when nothing went wrong (a missing download folder is not an error here: the status page says so), 1 when a move, a swap or the run itself failed.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultLedgerFile, refreshLedgerIfStale, standInRegistryFile } from '@/lib/ledger-export'
import { indexLedger, readLedgerFile } from '@/lib/ledger-tools'
import { gatherFacts, writeMoverRun, writeStatusFiles, type MoverRun } from '@/lib/pipeline-status'
import { defaultDownloadDir, hashCacheFile, sweepDownloads, sweepEnabled } from '@/lib/stand-in-sweep'
import { defaultArchiveDir, readManifest, verifyEntry } from '@/lib/source-archive'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
const say = (m: string): void => console.log(`[pull-downloads] ${m}`)

const REPO = process.env.ULP_REPO ?? process.cwd()
const INBOX = join(REPO, 'inbox')
const LEDGER = flag('ledger') ?? defaultLedgerFile()
const PIPELINE = dirname(LEDGER)
const ARCHIVE = flag('archive') ?? process.env.ULP_ARCHIVE_DIR ?? defaultArchiveDir()
const DIR = resolve(flag('dir') ?? defaultDownloadDir())
const APPLY = has('apply')
const QUIET_MIN = Number(flag('quiet') ?? process.env.ULP_MOVER_QUIET_MIN ?? 3)

/** One run at a time (a timer tick and a run by hand): a lock file in the pipeline folder naming the process that holds it; a lock whose process is gone is taken over. */
function takeLock(): (() => void) | null {
  const path = join(PIPELINE, '.pull.lock')
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

async function main(): Promise<number> {
  if ((process.env.ULP_MOVER ?? '').trim().toLowerCase() === 'off') { say('ULP_MOVER=off: nothing to do'); return 0 }
  if (!sweepEnabled()) { say('ULP_STANDIN_SWEEP=off: nothing to do'); return 0 }
  mkdirSync(PIPELINE, { recursive: true })
  const unlock = takeLock()
  if (!unlock) { say('another run holds the lock'); return 0 }
  const started = Date.now()
  const run: MoverRun = {
    v: 1, at: '', ms: 0, applied: APPLY, ok: true, moved: [], swapped: [], kept: [], refused: [], pending: [], failed: [], changed: [], standIns: 0, hashed: 0,
  }
  try {
    if (!existsSync(INBOX)) { run.ok = false; run.error = `the inbox folder does not exist: ${INBOX}` }
    else if (existsSync(DIR)) {
      if (!has('no-refresh')) {
        try { refreshLedgerIfStale(LEDGER) } catch (err) {
          if (!existsSync(LEDGER)) { run.ok = false; run.error = `no ledger copy and the stack could not be read: ${err instanceof Error ? err.message : String(err)}` }
          else console.warn(`[pull-downloads] the stack could not be read; using the ledger copy as it is: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (run.ok && !existsSync(LEDGER)) { run.ok = false; run.error = `no ledger copy at ${LEDGER}: nothing is known, so nothing is moved` }
      if (run.ok) {
        const byHash = new Map((existsSync(ARCHIVE) ? readManifest(ARCHIVE) : []).map(e => [e.sha256, e]))
        const r = await sweepDownloads({
          dir: DIR, inbox: INBOX, index: indexLedger(readLedgerFile(LEDGER)), holds: sha => byHash.get(sha), verify: e => verifyEntry(ARCHIVE, e),
          registry: standInRegistryFile(LEDGER), hashCache: hashCacheFile(LEDGER),
          exts: (flag('ext') ?? 'txt').split(',').map(e => e.trim()).filter(Boolean),
          minSize: Number(flag('min-size') ?? 1_000_000), minAgeMs: QUIET_MIN * 60_000, apply: APPLY,
        })
        run.moved = APPLY ? r.moved : r.wouldMove
        run.swapped = APPLY ? r.swapped : r.wouldSwap
        run.kept = r.notArchivedYet
        run.refused = r.refused; run.pending = r.pending; run.failed = r.failed; run.changed = r.changed; run.standIns = r.standIns; run.hashed = r.hashed
        const verb = APPLY ? '' : 'would be '
        for (const n of run.moved) say(`${verb}moved into the inbox, stand-in left: ${n}`)
        for (const n of run.swapped) say(`${verb}swapped for a stand-in: ${n}`)
        for (const p of run.pending) say(`waiting: ${p.name}: ${p.detail}`)
        for (const x of run.refused) say(`REFUSED ${x.name}: ${x.reason}`)
        for (const f of run.failed) say(`FAILED ${f.name}: ${f.error}`)
      }
    }
  } catch (err) {
    run.ok = false
    run.error = err instanceof Error ? err.message : String(err)
    console.error(`[pull-downloads] ${run.error}`)
  } finally {
    run.at = new Date().toISOString()
    run.ms = Date.now() - started
    if (APPLY) {
      try {
        writeMoverRun(PIPELINE, run)
        const v = writeStatusFiles(gatherFacts({ downloads: DIR, repo: REPO, archive: ARCHIVE, pipeline: PIPELINE, ledger: LEDGER }))
        if (run.moved.length + run.swapped.length + run.failed.length + run.refused.length + run.pending.length > 0 || !run.ok) say(`status: ${v.headline}`)
      } catch (err) {
        console.error(`[pull-downloads] the status pages could not be written: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      say(`dry run (nothing changed; --apply does it): ${run.moved.length} would move, ${run.swapped.length} would be swapped, ${run.pending.length} not finished, ${run.refused.length} refused, ${run.standIns} already stand-ins`)
    }
    unlock()
  }
  return !run.ok || run.failed.length > 0 ? 1 : 0
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
