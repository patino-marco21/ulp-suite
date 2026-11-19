/**
 * Archives the files in inbox/done once the inbox has been quiet for a while, verifies a sample, and leaves a one-line account for the Inbox page. It removes plaintext
 * only when ULP_AUTO_ARCHIVE_REPLACE=1 (the owner's switch, set in scripts/systemd/ulp-archive-auto.service): after a clean archive and sample check it runs
 * `archive --replace` (scripts/archive-sources.ts), which decodes each archive again, compares it with the original and keeps any file that is not in ulp.sources, still new,
 * or in flight. Without the switch the account says what is ready to replace and how much that would free, and the replace stays a command of the owner.
 *
 *   tsx scripts/archive-when-idle.ts [--now]
 *
 * Run from the repository root by a systemd user timer (scripts/systemd/ulp-archive-auto.timer, installed by the owner). Environment: ULP_ARCHIVE_DIR (the archive,
 * which must exist), ULP_REPO (the checkout whose ./inbox is watched; default the current directory), CH_CONTAINER (ulpsuite_clickhouse), ULP_AUTO_ARCHIVE_IDLE_MIN
 * (minutes of quiet before a run; default 20), ULP_AUTO_ARCHIVE_WORKERS (default 4), ULP_AUTO_ARCHIVE_REPLACE (1 = remove the plaintext of archived files; default off),
 * ULP_REDUCED_ARCHIVE_WORKERS (1 to 8, default 3) and ULP_REDUCED_ARCHIVE_LIMIT (files per run, default 20) for the reduced archive's shadow run.
 * --now skips the wait for quiet, not the check that nothing is in flight.
 *
 * A run starts only when nothing is waiting or in flight in the inbox (which also covers the disk gate holding the ingest) and no inbox folder has changed for the wait.
 * Every run, busy inbox or not, first refreshes the plain-text copy of the file ledger (scripts/ledger-export.ts), and again after files were archived (the copy says which
 * files the archive holds). The chat client's download folder is not touched here: scripts/pull-downloads.ts, run by its own minute timer, moves finished downloads into
 * the inbox and swaps archived ones for stand-ins. One run at a time (a lock in the archive directory). The tool reads `*.txt` names only and skips files of 0 bytes; the account counts both so they are not forgotten.
 * Exit 0 when nothing went wrong or the inbox was not idle, 1 when an archive or a check failed, 2 when the archive directory is missing.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync, statfsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inboxIsBusy } from '@/lib/archive-replace'
import {
  DEFAULT_IDLE_MS, archiveNote, failureBackoff, idleRefusals, inboxLastActivityMs, parseArchiveSummary, parseVerifySummary, readStatus, readyToReplace, reducedArchiveMode, reducedRunArgs, replaceWanted,
  writeStatus, type AutoArchiveStatus,
} from '@/lib/archive-auto'
import { defaultArchiveDir, latestByName, readManifest } from '@/lib/source-archive'

const REPO = process.env.ULP_REPO ?? process.cwd()
const INBOX = join(REPO, 'inbox')
const DONE = join(INBOX, 'done')
const ARCHIVE = defaultArchiveDir()
const HERE = fileURLToPath(new URL('.', import.meta.url))   // the tool and tsx are this checkout's, whichever inbox ULP_REPO points at
const TOOL = join(HERE, 'archive-sources.ts')
const REDUCE_TOOL = join(HERE, 'reduce-archive.ts')
const TSX = join(HERE, '..', 'node_modules', '.bin', 'tsx')
const IDLE_MS = process.env.ULP_AUTO_ARCHIVE_IDLE_MIN !== undefined ? Number(process.env.ULP_AUTO_ARCHIVE_IDLE_MIN) * 60_000 : DEFAULT_IDLE_MS
const WORKERS = process.env.ULP_AUTO_ARCHIVE_WORKERS ?? '4'
const REPLACE = process.env.ULP_AUTO_ARCHIVE_REPLACE === '1'
const now = () => Date.now()

function say(message: string): void { console.log(`[archive-when-idle] ${message}`) }

/** One run at a time: a lock file in the archive directory that names the process holding it. A lock whose process is gone is taken over. */
function takeLock(): (() => void) | null {
  const path = join(ARCHIVE, '.auto-archive.lock')
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

/** Runs scripts/archive-sources.ts from the checkout (tsx resolves the @/ alias from the tsconfig next to it), pointed at the inbox and archive of this run. */
function tool(args: string[]): { out: string; status: number } {
  const r = spawnSync(TSX, [TOOL, ...args], {
    cwd: join(HERE, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ULP_ARCHIVE_DIR: ARCHIVE, ULP_REPO: REPO },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  for (const l of out.split('\n').filter(l => l.trim() !== '')) say(`  ${l}`)
  return { out, status: r.status ?? 1 }
}

/**
 * Refreshes the plain-text copy of the file ledger (scripts/ledger-export.ts), whatever the inbox is doing: it only reads the stack, and the copy is what a person greps before
 * downloading a file. A failure is logged and changes nothing about this run.
 */
function refreshLedgerCopy(): void {
  const r = spawnSync(TSX, [join(HERE, 'ledger-export.ts')], { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 120_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  say(r.status === 0 ? out.split('\n').pop() ?? 'ledger copy written' : `the ledger copy could not be written (exit ${r.status}): ${out.split('\n').pop() ?? ''}`)
}

/**
 * Stage B of the reduced archive (ULP_REDUCED_ARCHIVE=shadow): writes the reduced entries of the files archived since the shadow began, beside the whole-file ones. It removes
 * and replaces nothing, works on several files at once (ULP_REDUCED_ARCHIVE_WORKERS: the parse of one file is a single thread), stops starting files when the inbox gets busy, and its failure is a line in the log: it never fails the archive run.
 */
function reduceShadow(): void {
  const { mode, note } = reducedArchiveMode()
  if (note) say(note)
  if (mode !== 'shadow') return
  const run = reducedRunArgs(process.env, INBOX)
  if (run.note) say(run.note)
  const r = spawnSync(TSX, [REDUCE_TOOL, ...run.args], {
    cwd: join(HERE, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 100 * 60_000,
    env: { ...process.env, ULP_ARCHIVE_DIR: ARCHIVE },
  })
  for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(l => l.trim() !== '')) say(`  reduced archive: ${l}`)
  if (r.status !== 0) say(`the reduced archive (shadow) ended with exit ${r.status}; the archive run is not affected`)
}

function main(): number {
  refreshLedgerCopy()
  if (!existsSync(ARCHIVE)) { say(`the archive directory does not exist: ${ARCHIVE} (create it; this script never does)`); return 2 }
  const refusals = idleRefusals({
    nowMs: now(), inboxBusy: inboxIsBusy(INBOX), idleMs: IDLE_MS,
    lastActivityMs: process.argv.includes('--now') ? null : inboxLastActivityMs(INBOX),
  })
  if (refusals.length > 0) { say(`not now: ${refusals.join('; ')}`); return 0 }
  const wait = process.argv.includes('--now') ? null : failureBackoff(readStatus(ARCHIVE), now())
  if (wait) { say(`not now: ${wait}`); return 0 }
  const unlock = takeLock()
  if (!unlock) { say('not now: another run holds the lock'); return 0 }
  try {
    const before = readyToReplace(DONE, ARCHIVE, latestByName(readManifest(ARCHIVE)))
    let archived = 0, failed = 0, plain = 0, ran = false
    let verify: AutoArchiveStatus['verify'] = null

    if (before.unarchived_files > 0) {
      ran = true
      say(`${before.unarchived_files} file(s), ${(before.unarchived_bytes / 1024 ** 3).toFixed(1)} GiB, in done/ are not archived: archiving (no --replace)`)
      const a = tool(['archive', '--src', DONE, '--workers', WORKERS])
      const summary = parseArchiveSummary(a.out)
      if (summary) { archived = summary.archived; failed = summary.failed; plain = summary.plain_bytes } else { failed = 1 }
      if (a.status !== 0 && failed === 0) failed = 1
      const v = tool(['verify', '--sample', '3'])
      verify = parseVerifySummary(v.out) ?? { checked: 0, failed: v.status === 0 ? 0 : 1 }
    } else {
      say('nothing new in done/ to archive')
    }

    if (ran && archived > 0) refreshLedgerCopy()   // the copy now shows these files as archived, which is what lets the mover swap their downloads for stand-ins
    let replaced = 0
    const mid = readyToReplace(DONE, ARCHIVE, latestByName(readManifest(ARCHIVE)))
    if (replaceWanted({ enabled: REPLACE, failed, verifyFailed: verify?.failed ?? 0, readyFiles: mid.ready_files })) {
      say(`${mid.ready_files} archived file(s) are still in done/: replacing their plaintext (each archive is decoded and compared with its original first)`)
      // --no-sources: a replace changes none of what ulp.sources keeps (size, sha256, archive id), and the sync is a mutation over every manifest name on each pass
      const r = tool(['archive', '--src', DONE, '--workers', WORKERS, '--replace', '--no-sources'])
      const summary = parseArchiveSummary(r.out)
      if (summary) { replaced = summary.replaced; failed += summary.failed }
      else say(`the replace did not run to the end (exit ${r.status}); the files stay and the next run tries again`)   // e.g. ClickHouse did not answer for ulp.sources: not a failed file
    }
    reduceShadow()
    const after = readyToReplace(DONE, ARCHIVE, latestByName(readManifest(ARCHIVE)))
    const fs = statfsSync(REPO)
    const status: AutoArchiveStatus = {
      v: 1, at: new Date().toISOString(), ran, archived, failed, plain_bytes: plain, verify, ...after, free_bytes: Number(fs.bavail) * Number(fs.bsize),
      ...(REPLACE ? { auto_replace: true, replaced, replaced_bytes: Math.max(0, mid.ready_bytes - after.ready_bytes) } : {}),
    }
    writeStatus(ARCHIVE, status)
    say(archiveNote(status))
    return failed > 0 || (verify?.failed ?? 0) > 0 ? 1 : 0
  } finally {
    unlock()
  }
}

process.exit(main())
