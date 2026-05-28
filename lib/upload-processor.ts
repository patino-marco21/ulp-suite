/**
 * Shared upload processing pipeline.
 *
 * Used by both the HTTP upload route (app/api/upload/route.ts) and the inbox
 * folder watcher (lib/inbox-watcher.ts).  Keeps ClickHouse insertion, source
 * recording, and parsing logic in one place.
 */

import { Readable } from 'stream'
import yauzl from 'yauzl'
import {
  parseULPStream,
  makeRejectionMap,
  type ULPCredential,
  type RejectionReason,
} from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { invalidateStatsCache } from '@/lib/stats-cache'
import { updateJob } from '@/lib/upload-jobs'

// ─── Public result type ───────────────────────────────────────────────────────

export interface ProcessResult {
  imported:            number
  skipped:             number
  errors:              number
  filename:            string
  breach_name:         string
  rejection_breakdown: Record<RejectionReason, number>
}

// ─── ClickHouse helpers ───────────────────────────────────────────────────────

/** Escape a value for ClickHouse CSV: wrap in double-quotes, double internal quotes. */
function csvField(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * Insert a batch into ClickHouse as a streaming CSV Readable.
 * Generator yields one row at a time — no large string materialised in heap.
 */
export async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
): Promise<void> {
  if (credentials.length === 0) return
  const chClient = getClient()

  const readable = Readable.from(
    (function* () {
      for (const c of credentials) {
        yield [
          csvField(c.url),
          csvField(c.email),
          csvField(c.password),
          csvField(c.domain),
          csvField(c.source_file),
          csvField(breach_name),
        ].join(',') + '\n'
      }
    })(),
    { objectMode: false },
  )

  await chClient.insert({
    table: 'ulp.credentials',
    columns: ['url', 'email', 'password', 'domain', 'source_file', 'breach_name'],
    values: readable,
    format: 'CSV',
    clickhouse_settings: {
      async_insert:          1 as any,
      wait_for_async_insert: 1 as any,
      max_execution_time:    0,
    },
  })
}

export async function recordSource(filename: string, lineCount: number): Promise<void> {
  const chClient = getClient()
  await chClient.insert({
    table: 'ulp.sources',
    values: [{ filename, line_count: lineCount }],
    format: 'JSONEachRow',
  })
}

// ─── Text stream processor ────────────────────────────────────────────────────

/**
 * Stream-process a .txt or .csv file.
 *
 * Reads in 500K-row batches — peak RAM is ~200 MB regardless of file size.
 * Pass jobId to push live progress via the in-memory SSE job store.
 */
export async function processTextStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  jobId?: string,
): Promise<ProcessResult> {
  const breach_name        = matchBreach(filename)
  let imported             = 0
  let skipped              = 0
  const rejection_breakdown = makeRejectionMap()

  for await (const batch of parseULPStream(stream, filename, 500_000)) {
    await insertBatch(batch.credentials, breach_name)
    imported += batch.credentials.length
    skipped  += batch.rejected
    for (const [k, v] of Object.entries(batch.breakdown)) {
      rejection_breakdown[k as RejectionReason] =
        (rejection_breakdown[k as RejectionReason] ?? 0) + v
    }
    if (jobId) updateJob(jobId, { imported, skipped })
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    invalidateStatsCache()
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown }
}

// ─── ZIP processor (yauzl — lazy entry streaming) ────────────────────────────

/**
 * Process a ZIP buffer by streaming its .txt/.csv entries one at a time.
 *
 * yauzl with lazyEntries:true decompresses entries lazily — only one entry
 * lives in memory at once.  Peak RAM ≈ one entry's 500K-row batch (≈200 MB),
 * not the full decompressed archive size.
 *
 * onEntry is called after each successfully processed entry so the caller can
 * accumulate results incrementally.
 */
export async function processZipBuffer(
  buffer: Buffer,
  onEntry: (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)

      zipfile.readEntry()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        // Skip directory entries
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

        const lp = entry.fileName.toLowerCase()
        if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) { reject(streamErr); return }

          const entryName = entry.fileName.split('/').pop() || entry.fileName
          // Convert Node.js Readable → Web ReadableStream for processTextStream
          const webStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>

          processTextStream(webStream, entryName)
            .then(result => { onEntry(result); zipfile.readEntry() })
            .catch(reject)
        })
      })

      zipfile.on('end', resolve)
      zipfile.on('error', reject)
    })
  })
}

/**
 * Process a ZIP file on disk by streaming its .txt/.csv entries one at a time.
 *
 * Uses yauzl.open — reads lazily from disk, no Buffer needed.
 * Ideal for the inbox watcher where we already have a file path.
 */
export async function processZipFile(
  filepath: string,
  onEntry:  (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)

      zipfile.readEntry()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

        const lp = entry.fileName.toLowerCase()
        if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) { reject(streamErr); return }

          const entryName = entry.fileName.split('/').pop() || entry.fileName
          const webStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>

          processTextStream(webStream, entryName)
            .then(result => { onEntry(result); zipfile.readEntry() })
            .catch(reject)
        })
      })

      zipfile.on('end', resolve)
      zipfile.on('error', reject)
    })
  })
}
