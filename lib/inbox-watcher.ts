/**
 * Inbox folder watcher.
 *
 * Drop .txt, .csv, or .zip files into ./inbox/ and they are processed
 * automatically through the same streaming pipeline as the HTTP upload API.
 *
 * Directory layout (auto-created on startup):
 *   ./inbox/            — place files here
 *   ./inbox/processing/ — a file lives here for the duration of its import
 *   ./inbox/done/       — successfully processed files are moved here
 *   ./inbox/failed/     — failed (or interrupted) files are moved here
 *
 * Uses the global uploadQueue (pLimit(1)) so inbox jobs and HTTP uploads
 * share the same single-at-a-time constraint and never compete for RAM.
 *
 * Reliability design (no double-processing -> no duplicate credential rows):
 *  - usePolling: true because Docker bind-mount inotify events don't propagate
 *    from host → container.
 *  - inFlight Set prevents the same file from being queued twice WITHIN a
 *    process (polling can fire 'add' repeatedly before a file is claimed).
 *  - Filesystem claim (lib/inbox-claim.ts): each file is atomically renamed
 *    inbox/X → processing/X BEFORE it is read. The rename is a single-winner
 *    gate, so a second attempt OR a fresh reconcile after a restart finds the
 *    file already gone and refuses to import it. This is what the in-memory
 *    inFlight Set cannot guarantee — it dies on restart, leaving a file still
 *    in inbox/ to be re-imported.
 *  - Startup sweep: anything left in processing/ (interrupted mid-import) is
 *    moved to failed/ for review, never silently re-imported.
 *  - Reconciliation loop (every 30 s) re-queues any files still in inbox/ but
 *    not in inFlight — catches files chokidar missed (large batch drops, host
 *    FS races, watcher startup gaps).
 */

import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import { uploadQueue, queueSize, setCurrentJob } from '@/lib/upload-queue'
import { logJob } from '@/lib/processing-log'
import { processTextStream, processZipFile } from '@/lib/upload-processor'
import { claimFileForProcessing, sweepProcessingToFailed, isFileSizeStable } from '@/lib/inbox-claim'

const INBOX = path.resolve('./inbox')
const DONE  = path.resolve('./inbox/done')
const FAIL  = path.resolve('./inbox/failed')
// processing/ holds a file for the duration of its import. A file is moved here
// (atomic rename) BEFORE it is read, so a second attempt or a post-restart
// reconcile can't re-pick it -- the filesystem is the dedup gate that the
// in-memory inFlight Set can't be (it dies on restart). See lib/inbox-claim.ts.
const PROC  = path.resolve('./inbox/processing')

// Suffixes that mark subdirectory paths (with the OS separator so that
// files whose NAMES start with 'done'/'failed'/'processing' are not excluded).
const DONE_PREFIX = DONE + path.sep
const FAIL_PREFIX = FAIL + path.sep
const PROC_PREFIX = PROC + path.sep

let started = false

const DONE_MAX_AGE_MS         = 7 * 24 * 60 * 60 * 1_000   // 7 days
const RECONCILE_INTERVAL_MS   = 30_000                       // scan for missed files every 30 s
const STABILITY_CHECK_WAIT_MS = 1_000                        // gap between size checks before claiming a file

/**
 * Filenames that have been submitted to uploadQueue (both pending and active).
 * Entries are added in enqueueFile() and removed in the task's finally block.
 *
 * This is the source of truth for "is this file already in pLimit?".
 * inFlight mirrors pendingTasks but is also used by reconcile() as a fast guard.
 *
 * The distinction matters for clearStaleInFlight():
 *   inFlight = filenames added by enqueueFile (may include true orphans)
 *   pendingTasks = filenames with live pLimit tasks (active OR queued)
 *
 * An entry in inFlight but NOT in pendingTasks is a true orphan
 * (enqueueFile was called but the task's finally never ran — should never
 * happen in normal operation but guards against future bugs).
 */
const inFlight    = new Set<string>()
const pendingTasks = new Set<string>()  // subset of inFlight — has live pLimit task

/** Live progress for the file currently being processed. */
export interface InboxJobProgress {
  filename:        string
  started_at:      number   // Date.now() when processing began
  rows_imported:   number   // rows successfully inserted so far
  file_size_bytes: number   // from fs.statSync before processing
}

let _currentProgress: InboxJobProgress | null = null

/** Returns live progress for the inbox file currently being processed, or null if idle. */
export function getInboxJobProgress(): InboxJobProgress | null {
  return _currentProgress
}

/** Number of filenames currently marked as queued or in-progress. */
export function getInFlightCount(): number {
  return inFlight.size
}

/**
 * Clear inFlight entries that are NOT the currently-processing file so that
 * a forced reconcile can re-queue them.
 *
 * When are entries stale?
 *   - File was in inbox/, queued → user moved it out → uploadQueue task failed
 *     (no such file) → inFlight.delete ran → but chokidar fired 'add' BEFORE
 *     the delete, so the NEW enqueueFile call saw inFlight.has()=true → skipped.
 *   - User then moved files back in → chokidar fires 'add' again → still in
 *     inFlight (pending task) → still skipped.
 *
 * This function removes entries that are:
 *   a) Not currently being processed (not _currentProgress.filename), AND
 *   b) Still in inbox/ (file exists — we want to re-queue it) OR
 *      Not in inbox/ (task already ran and cleaned up, but entry leaked)
 */
export function clearStaleInFlight(): number {
  const current = _currentProgress?.filename ?? null
  let cleared = 0
  for (const name of Array.from(inFlight)) {
    if (name === current)          continue  // actively processing — leave it
    if (pendingTasks.has(name))    continue  // has a live pLimit task — DO NOT clear
    // True orphan: in inFlight but no live pLimit task — safe to remove
    inFlight.delete(name)
    cleared++
  }
  console.log(`[inbox-watcher] clearStaleInFlight: cleared ${cleared} true orphan(s)`)
  return cleared
}

/**
 * Trigger an immediate reconciliation scan outside the normal 30-second interval.
 * Call after clearStaleInFlight() to re-queue any files that were stuck.
 */
export function forceReconcile(): number {
  let queued = 0
  try {
    const entries = fs.readdirSync(INBOX, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(INBOX, entry.name)
      if (!inFlight.has(entry.name)) {
        void enqueueFile(filePath)
        queued++
      }
    }
  } catch { /* inbox/ might not exist yet */ }
  console.log(`[inbox-watcher] forceReconcile: queued ${queued} file(s)`)
  return queued
}

const SUPPORTED_EXTS = new Set(['.txt', '.csv', '.zip'])

/** Delete files in dir that are older than maxAgeMs. Silent on errors. */
function cleanupOldFiles(dir: string, maxAgeMs: number): void {
  try {
    const now    = Date.now()
    const cutoff = now - maxAgeMs
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const filePath = path.join(dir, entry.name)
      try {
        const { mtimeMs } = fs.statSync(filePath)
        if (mtimeMs < cutoff) {
          fs.unlinkSync(filePath)
          console.log(`[inbox-watcher] cleanup: deleted old done file ${entry.name}`)
        }
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore if dir doesn't exist yet */ }
}

/**
 * Queue a single file for processing.
 * Safe to call multiple times for the same file — inFlight deduplates.
 */
async function enqueueFile(filePath: string): Promise<void> {
  const filename = path.basename(filePath)
  const ext      = path.extname(filename).toLowerCase()

  if (!SUPPORTED_EXTS.has(ext)) {
    // Previously a silent `return` here — the file just sat in inbox/ forever
    // with zero visibility, re-checked (and re-ignored) every 30s by reconcile().
    // Move it to failed/ (same as a real processing failure) so it's surfaced
    // in the job log / Inbox Monitor UI instead of vanishing from view.
    // The rename is the race gate: if a concurrent call (chokidar 'add' +
    // reconcile firing close together) already moved it, this throws and we
    // bail without double-logging — same pattern as claimFileForProcessing.
    try {
      fs.mkdirSync(FAIL, { recursive: true })
      fs.renameSync(filePath, path.join(FAIL, filename))
    } catch {
      return
    }
    console.warn(`[inbox-watcher] unsupported extension, moved to failed/: ${filename}`)
    logJob({
      source:        'inbox',
      filename,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   0,
      error_message: `Unsupported file extension "${ext || '(none)'}" — supported: .txt, .csv, .zip`,
    })
    return
  }
  if (inFlight.has(filename))       return   // already queued or processing
  // Use path separator guards so 'done_batch.txt' is NOT excluded:
  if (filePath.startsWith(DONE_PREFIX) || filePath.startsWith(FAIL_PREFIX) || filePath.startsWith(PROC_PREFIX)) return

  // Guard against claiming a file an external process (e.g. `cp` of a large
  // file) is still writing. fs.createReadStream hits EOF at the file's
  // CURRENT size, not its eventual size, so reading a partially-written file
  // silently "succeeds" with 0 or a handful of rows and no error. If the size
  // is still changing, skip this attempt without marking inFlight — the file
  // stays untouched in inbox/, so the next chokidar poll (~2s) or reconcile
  // pass (~30s) checks again with fresh stat calls. An arbitrarily slow
  // writer resolves correctly over time; no new timeout/retry-count logic
  // needed, since this reuses the existing polling cadence.
  //
  // NOTE: the await below opens a has()-then-add() gap where two concurrent
  // calls for the same filename (e.g. a chokidar 'add' event and a reconcile()
  // pass) can both pass the inFlight.has() check above before either calls
  // inFlight.add(). That's safe: uploadQueue is pLimit(1), so the two tasks
  // still run one at a time, and claimFileForProcessing's atomic rename lets
  // only one of them actually claim the file -- the other gets procPath ===
  // null and returns without importing. Worst case is a harmless extra
  // "claim skipped (already gone)" log line, never a double import.
  if (!(await isFileSizeStable(filePath, STABILITY_CHECK_WAIT_MS))) return

  inFlight.add(filename)
  pendingTasks.add(filename)   // mark as having a live pLimit task
  console.log(`[inbox-watcher] queued: ${filename} (queue: ${queueSize()})`)

  uploadQueue(async () => {
    const startAt = Date.now()
    setCurrentJob(filename)

    let imported = 0
    let skipped  = 0
    let procPath: string | null = null
    try {
      // CLAIM: atomically move the file out of inbox/ into processing/ BEFORE
      // reading it. If the rename returns null the file is already gone (a
      // concurrent attempt or a pre-restart claim won), so we must NOT import
      // it -- that is exactly the double-import that produced duplicate rows.
      procPath = claimFileForProcessing(filePath, PROC)
      if (procPath === null) {
        console.warn(`[inbox-watcher] claim skipped (already gone): ${filename}`)
        return   // finally still clears inFlight; nothing imported
      }

      console.log(`[inbox-watcher] processing: ${filename}`)
      // Capture file size (from the claimed path) for ETA in the status API.
      const fileSizeBytes = (() => { try { return fs.statSync(procPath!).size } catch { return 0 } })()
      _currentProgress = { filename, started_at: startAt, rows_imported: 0, file_size_bytes: fileSizeBytes }

      if (ext === '.zip') {
        await processZipFile(procPath, result => {
          imported += result.imported
          skipped  += result.skipped
          if (_currentProgress) _currentProgress.rows_imported = imported
          if (result.imported > 0) {
            console.log(
              `[inbox-watcher]   ${result.filename}: ` +
              `imported=${result.imported} skipped=${result.skipped}`
            )
          } else if (result.errors > 0) {
            console.warn(`[inbox-watcher]   ${result.filename}: skipped (entry error)`)
          }
        })
      } else {
        const nodeStream = fs.createReadStream(procPath)
        const webStream  = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
        const result     = await processTextStream(webStream, filename, undefined, n => {
          // onBatch: update live progress after each 500 K-row batch
          if (_currentProgress) _currentProgress.rows_imported = n
        })
        imported = result.imported
        skipped  = result.skipped
        console.log(
          `[inbox-watcher] done: ${filename} ` +
          `imported=${result.imported} skipped=${result.skipped}`
        )
      }
      // Move processing/ -> done/ BEFORE logJob so a crash here still leaves the
      // file out of inbox/ (it's in processing/, swept to failed/ on restart).
      fs.mkdirSync(DONE, { recursive: true })
      fs.renameSync(procPath, path.join(DONE, filename))
      logJob({
        source:      'inbox',
        filename,
        status:      'done',
        imported,
        skipped,
        duration_ms: Date.now() - startAt,
      })
    } catch (err) {
      console.error(`[inbox-watcher] failed: ${filename}`, err)
      logJob({
        source:        'inbox',
        filename,
        status:        'failed',
        imported,
        skipped,
        duration_ms:   Date.now() - startAt,
        error_message: err instanceof Error ? err.message : String(err),
      })
      // Move the claimed file (if we claimed it) to failed/ for review.
      if (procPath) {
        try {
          fs.mkdirSync(FAIL, { recursive: true })
          fs.renameSync(procPath, path.join(FAIL, filename))
        } catch {}
      }
    } finally {
      _currentProgress = null
      pendingTasks.delete(filename)   // task is done (success or fail)
      inFlight.delete(filename)
      setCurrentJob(null)
    }
  })
}

/**
 * Scan inbox/ for any files that are not currently in-flight and queue them.
 *
 * Called at startup (via ignoreInitial:false chokidar scan) and every
 * RECONCILE_INTERVAL_MS thereafter.  Ensures files that chokidar missed
 * (Docker bind-mount races, large batch drops, watcher startup gaps) are
 * eventually processed.
 */
function reconcile(): void {
  try {
    const entries = fs.readdirSync(INBOX, { withFileTypes: true })
    let queued = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(INBOX, entry.name)
      if (!inFlight.has(entry.name)) {
        void enqueueFile(filePath)
        queued++
      }
    }
    if (queued > 0) {
      console.log(`[inbox-watcher] reconcile: queued ${queued} missed file(s)`)
    }
  } catch { /* inbox/ doesn't exist yet — harmless */ }
}

export function startInboxWatcher(): void {
  if (started) return
  started = true

  // Ensure directories exist before the watcher starts
  ;[INBOX, DONE, FAIL, PROC].forEach(d => fs.mkdirSync(d, { recursive: true }))

  // Sweep any files left in processing/ by a previous run that was interrupted
  // mid-import (crash/OOM/redeploy). They may be partially imported, so move
  // them to failed/ for review rather than re-importing (which would duplicate
  // the partial rows). This MUST run before reconcile() so a leftover isn't
  // somehow re-picked.
  const interrupted = sweepProcessingToFailed(PROC, FAIL)
  for (const name of interrupted) {
    console.warn(`[inbox-watcher] interrupted mid-import, moved to failed/: ${name}`)
    logJob({
      source:        'inbox',
      filename:      name,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   0,
      error_message: 'Interrupted mid-import (app restart) — may be partially imported; review before re-adding.',
    })
  }

  // Prune stale done/ files on startup (older than 7 days)
  cleanupOldFiles(DONE, DONE_MAX_AGE_MS)

  // Reconcile on startup: pick up any files that were in inbox/ before this
  // process started (e.g. dropped during a rebuild or before first run).
  reconcile()

  // Periodic reconciliation: catch any files chokidar misses.
  // This is the reliability guarantee — even if every 'add' event fails,
  // files will still be processed within RECONCILE_INTERVAL_MS.
  setInterval(reconcile, RECONCILE_INTERVAL_MS)

  console.log(`[inbox-watcher] started — watching ${INBOX} (polling every 2 s, reconcile every 30 s)`)

  // Dynamic import keeps chokidar out of the client bundle (tree-shaking safe)
  import('chokidar')
    .then(mod => {
      const { watch } = mod as typeof import('chokidar')

      watch(INBOX, {
        persistent:    true,
        ignoreInitial: true,   // startup files handled by reconcile() above
        depth:         0,      // only watch root of inbox/, not subdirectories
        // usePolling is required for Docker bind mounts:
        // inotify events do NOT propagate from host → container.
        usePolling:    true,
        interval:      2_000,  // scan every 2 s — low CPU, ≤2 s detection lag
      }).on('add', enqueueFile)
        .on('error', (err: unknown) => {
          console.error('[inbox-watcher] watcher error:', err)
        })
    })
    .catch(err => {
      console.error('[inbox-watcher] failed to load chokidar:', err)
      // Even without chokidar, the reconciliation loop keeps processing running.
    })
}
