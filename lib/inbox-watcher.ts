/**
 * Inbox folder watcher.
 *
 * Drop .txt, .csv, or .zip files into ./inbox/ and they are processed
 * automatically through the same streaming pipeline as the HTTP upload API.
 *
 * Directory layout (auto-created on startup):
 *   ./inbox/         — place files here
 *   ./inbox/done/    — successfully processed files are moved here
 *   ./inbox/failed/  — failed files are moved here
 *
 * Uses the global uploadQueue (pLimit(1)) so inbox jobs and HTTP uploads
 * share the same single-at-a-time constraint and never compete for RAM.
 *
 * Reliability design:
 *  - usePolling: true because Docker bind-mount inotify events don't propagate
 *    from host → container.
 *  - inFlight Set prevents the same file from being queued twice (polling can
 *    fire 'add' multiple times before a file is moved out of inbox/).
 *  - Reconciliation loop (every 30 s) re-queues any files that are still in
 *    inbox/ but not in inFlight.  This catches files that chokidar missed for
 *    any reason — large batch drops, host FS races, watcher startup gaps.
 */

import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import { uploadQueue, queueSize, setCurrentJob } from '@/lib/upload-queue'
import { logJob } from '@/lib/processing-log'
import { processTextStream, processZipFile } from '@/lib/upload-processor'

const INBOX = path.resolve('./inbox')
const DONE  = path.resolve('./inbox/done')
const FAIL  = path.resolve('./inbox/failed')

// Suffixes that mark subdirectory paths (with the OS separator so that
// files whose NAMES start with 'done' or 'failed' are not excluded).
const DONE_PREFIX = DONE + path.sep
const FAIL_PREFIX = FAIL + path.sep

let started = false

const DONE_MAX_AGE_MS       = 7 * 24 * 60 * 60 * 1_000   // 7 days
const RECONCILE_INTERVAL_MS = 30_000                       // scan for missed files every 30 s

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
        enqueueFile(filePath)
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
function enqueueFile(filePath: string): void {
  const filename = path.basename(filePath)
  const ext      = path.extname(filename).toLowerCase()

  if (!SUPPORTED_EXTS.has(ext))     return   // unsupported extension
  if (inFlight.has(filename))       return   // already queued or processing
  // Use path separator guards so 'done_batch.txt' is NOT excluded:
  if (filePath.startsWith(DONE_PREFIX) || filePath.startsWith(FAIL_PREFIX)) return

  inFlight.add(filename)
  pendingTasks.add(filename)   // mark as having a live pLimit task
  console.log(`[inbox-watcher] queued: ${filename} (queue: ${queueSize()})`)

  uploadQueue(async () => {
    const startAt = Date.now()
    console.log(`[inbox-watcher] processing: ${filename}`)
    setCurrentJob(filename)

    // Capture file size for ETA calculation in the status API.
    const fileSizeBytes = (() => { try { return fs.statSync(filePath).size } catch { return 0 } })()
    _currentProgress = { filename, started_at: startAt, rows_imported: 0, file_size_bytes: fileSizeBytes }

    let imported = 0
    let skipped  = 0
    try {
      if (ext === '.zip') {
        await processZipFile(filePath, result => {
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
        const nodeStream = fs.createReadStream(filePath)
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
      // Rename to done/ BEFORE calling logJob so that if the process crashes
      // between here and logJob (e.g. OOM), the file is already out of inbox/.
      // The next reconcile scan won't re-queue it, preventing double-processing
      // and duplicate credentials in ClickHouse.
      fs.renameSync(filePath, path.join(DONE, filename))
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
      try { fs.renameSync(filePath, path.join(FAIL, filename)) } catch {}
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
        enqueueFile(filePath)
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
  ;[INBOX, DONE, FAIL].forEach(d => fs.mkdirSync(d, { recursive: true }))

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
