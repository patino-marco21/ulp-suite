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
 */

import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import { uploadQueue, queueSize } from '@/lib/upload-queue'
import { processTextStream, processZipBuffer, processZipFile } from '@/lib/upload-processor'

const INBOX = path.resolve('./inbox')
const DONE  = path.resolve('./inbox/done')
const FAIL  = path.resolve('./inbox/failed')

let started = false

const DONE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

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

export function startInboxWatcher(): void {
  if (started) return
  started = true

  // Ensure directories exist before the watcher starts
  ;[INBOX, DONE, FAIL].forEach(d => fs.mkdirSync(d, { recursive: true }))

  // Prune stale done/ files on startup (older than 7 days)
  cleanupOldFiles(DONE, DONE_MAX_AGE_MS)

  console.log(`[inbox-watcher] started — watching ${INBOX}`)

  // Dynamic import keeps chokidar out of the client bundle (tree-shaking safe)
  import('chokidar')
    .then(mod => {
      const { watch } = mod as typeof import('chokidar')

      watch(INBOX, {
        persistent:    true,
        ignoreInitial: false,  // process files already in inbox on startup
        depth:         0,      // only watch root of inbox/, not subdirectories
      }).on('add', (filePath: string) => {
        // Filter to supported extensions in the event handler (v4 dropped glob support)
        const ext = path.extname(filePath).toLowerCase()
        if (!['.txt', '.csv', '.zip'].includes(ext)) return

        // Ignore files already in done/ or failed/ (depth:0 prevents this,
        // but guard defensively against any edge-case re-trigger)
        if (filePath.startsWith(DONE) || filePath.startsWith(FAIL)) return

        const filename = path.basename(filePath)
        console.log(`[inbox-watcher] queued: ${filename} (queue: ${queueSize()})`)

        uploadQueue(async () => {
          console.log(`[inbox-watcher] processing: ${filename}`)
          try {
            if (ext === '.zip') {
              // processZipFile reads directly from disk — no readFileSync buffer
              await processZipFile(filePath, result => {
                if (result.imported > 0) {
                  console.log(
                    `[inbox-watcher]   ${result.filename}: ` +
                    `imported=${result.imported} skipped=${result.skipped}`
                  )
                }
              })
            } else {
              const nodeStream = fs.createReadStream(filePath)
              const webStream  = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
              const result     = await processTextStream(webStream, filename)
              console.log(
                `[inbox-watcher] done: ${filename} ` +
                `imported=${result.imported} skipped=${result.skipped}`
              )
            }
            // Move to done/ — rename is atomic on same filesystem
            fs.renameSync(filePath, path.join(DONE, filename))
          } catch (err) {
            console.error(`[inbox-watcher] failed: ${filename}`, err)
            try { fs.renameSync(filePath, path.join(FAIL, filename)) } catch {}
          }
        })
      }).on('error', (err: unknown) => {
        console.error('[inbox-watcher] watcher error:', err)
      })
    })
    .catch(err => {
      console.error('[inbox-watcher] failed to load chokidar:', err)
    })
}
