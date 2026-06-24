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
import {
  privacySafeClickHouseErrorSummary,
  withClickHouseRetry,
  type ClickHouseRetryOptions,
} from '@/lib/clickhouse-retry'
import { batchDedupToken } from '@/lib/upload-dedup'
import { parseIngestPolicy, policyActive, shouldDropAtIngest } from '@/lib/ingest-filter'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'

// ─── Public result type ───────────────────────────────────────────────────────

export interface ProcessResult {
  imported:            number
  skipped:             number
  errors:              number
  filename:            string
  breach_name:         string
  rejection_breakdown: Record<RejectionReason, number>
  /** True when the file was skipped because its filename is already in ulp.sources. */
  alreadyImported:     boolean
  /** Rows dropped pre-insert by the ingest tier filter (lib/ingest-filter.ts). */
  tierDropped:         number
}

export const UPLOAD_BATCH_SIZE = 100_000

// ─── ClickHouse helpers ───────────────────────────────────────────────────────

/** Escape a value for ClickHouse CSV: wrap in double-quotes, double internal quotes. */
function csvField(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

function retryErrorSummary(error: unknown): string {
  return privacySafeClickHouseErrorSummary(error)
}

function makeRetryLogger(
  operation: string,
  target: string,
  forward?: ClickHouseRetryOptions['onRetry'],
): NonNullable<ClickHouseRetryOptions['onRetry']> {
  return event => {
    console.warn(
      `[upload-processor] retrying ${operation} for ${target} ` +
      `(attempt ${event.attempt}, next delay ${event.delayMs}ms, ${retryErrorSummary(event.error)})`
    )
    forward?.(event)
  }
}

/**
 * Authoritative "already imported" check. ulp.sources is written by recordSource
 * ONLY after a file fully imports, so its presence means the whole file is already
 * in ulp.credentials. Used both to skip re-imports (processTextStream) and to keep
 * recordSource idempotent.
 */
async function querySourceAlreadyImported(filename: string, signal: AbortSignal): Promise<boolean> {
  const res = await getClient().query({
    query:        `SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1`,
    query_params: { f: filename },
    format:       'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: {
      use_query_cache: 0,
    },
  })
  const closeOnAbort = () => res.close()
  signal.addEventListener('abort', closeOnAbort, { once: true })
  try {
    if (signal.aborted) {
      closeOnAbort()
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    }
    const rows = await res.json() as Array<{ c: string | number }>
    return Number(rows[0]?.c ?? 0) > 0
  } finally {
    signal.removeEventListener('abort', closeOnAbort)
  }
}

export async function sourceAlreadyImported(filename: string): Promise<boolean> {
  const rows = await withClickHouseRetry(
    async signal => querySourceAlreadyImported(filename, signal),
    { onRetry: makeRetryLogger('source check', filename) }
  )
  return rows
}

/**
 * Insert a batch into ClickHouse as a streaming CSV Readable.
 * Generator yields one row at a time — no large string materialised in heap.
 */
export async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
  retryOptions: ClickHouseRetryOptions = {},
  opts: { table?: string } = {},
): Promise<void> {
  if (credentials.length === 0) return
  const chClient = getClient()

  // Deterministic content hash of this exact batch — see lib/upload-dedup.ts.
  const token = batchDedupToken(credentials, breach_name)

  await withClickHouseRetry(
    async signal => {
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
        table: opts.table ?? 'ulp.credentials',
        columns: ['url', 'email', 'password', 'domain', 'source_file', 'breach_name'],
        values: readable,
        format: 'CSV',
        abort_signal: signal,
        clickhouse_settings: {
          max_execution_time:       0,
          insert_deduplicate:       1 as any,
          insert_deduplication_token: token as any,
          max_insert_threads:       2 as any,
        },
      })
    },
    {
      ...retryOptions,
      onRetry: makeRetryLogger('batch insert', breach_name, retryOptions.onRetry),
    }
  )
}

export async function recordSource(filename: string, lineCount: number): Promise<void> {
  await withClickHouseRetry(
    async signal => {
      const chClient = getClient()

      // Idempotent: skip if this filename was already recorded in ulp.sources.
      // Prevents duplicate source rows when a file is re-processed (e.g. after an
      // OOM crash between processTextStream and renameSync, or a Force Scan race).
      // Retried inserts re-check the guard so an ambiguous transient error does not
      // create duplicate source rows on a later attempt.
      if (await querySourceAlreadyImported(filename, signal)) {
        console.log(`[upload-processor] recordSource: ${filename} already in ulp.sources — skipping`)
        return
      }

      await chClient.insert({
        table:  'ulp.sources',
        values: [{ filename, line_count: lineCount }],
        format: 'JSONEachRow',
        abort_signal: signal,
      })
    },
    { onRetry: makeRetryLogger('source record', filename) }
  )
}

// ─── Text stream processor ────────────────────────────────────────────────────

/**
 * Stream-process a .txt or .csv file.
 *
 * Reads in 100K-row batches — peak RAM stays bounded regardless of file size.
 * Pass jobId to push live progress via the in-memory SSE job store.
 */
export async function processTextStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  jobId?: string,
  /** Called after each 100K-row batch with the cumulative imported count. */
  onBatch?: (imported: number) => void,
): Promise<ProcessResult> {
  const breach_name        = matchBreach(filename)

  // Durable re-upload guard: if this filename is already in ulp.sources it was
  // fully imported before, so skip re-reading/inserting it entirely. This is the
  // authoritative, time-unbounded guard against the inbox watcher reprocessing a
  // file or a duplicate re-upload — complementary to ClickHouse's insert-dedup
  // token, which only covers re-inserts within its (1h default) dedup window.
  if (await sourceAlreadyImported(filename)) {
    console.log(`[upload-processor] ${filename} already in ulp.sources — skipping re-import`)
    return {
      imported: 0, skipped: 0, errors: 0, filename, breach_name,
      rejection_breakdown: makeRejectionMap(), alreadyImported: true, tierDropped: 0,
    }
  }

  let imported             = 0
  let skipped              = 0
  let tierDropped          = 0
  const rejection_breakdown = makeRejectionMap()

  // Ingest tier filter — drops low-value rows BEFORE insert. Off unless
  // INGEST_FILTER_DROP_TIERS / INGEST_FILTER_DROP_SUFFIXES is configured.
  const dropPolicy = parseIngestPolicy()
  const filterOn   = policyActive(dropPolicy)

  for await (const batch of parseULPStream(stream, filename, UPLOAD_BATCH_SIZE)) {
    let creds = batch.credentials
    if (filterOn) {
      const kept = creds.filter(c => !shouldDropAtIngest(c.email, c.url, c.domain, dropPolicy))
      tierDropped += creds.length - kept.length
      creds = kept
    }
    await insertBatch(creds, breach_name)
    imported += creds.length
    skipped  += batch.rejected
    for (const [k, v] of Object.entries(batch.breakdown)) {
      rejection_breakdown[k as RejectionReason] =
        (rejection_breakdown[k as RejectionReason] ?? 0) + v
    }
    if (jobId)   updateJob(jobId, { imported, skipped })
    if (onBatch) onBatch(imported)
  }

  if (filterOn && tierDropped > 0) {
    console.log(`[ingest-filter] ${filename}: dropped ${tierDropped} low-tier rows pre-insert`)
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
    // Cross-file content dedup remains available through the scheduled/manual
    // dedup flows; imports no longer trigger a full-table dedup hook here.
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
}

// ─── ZIP processor (yauzl — lazy entry streaming) ────────────────────────────

class ZipEntryStreamError extends Error {
  constructor(public override cause: unknown) {
    super('ZIP entry stream failed', { cause })
    this.name = 'ZipEntryStreamError'
  }
}

/**
 * Drive a yauzl ZipFile through its .txt/.csv entries one at a time.
 *
 * yauzl with lazyEntries:true decompresses entries lazily — only one entry
 * lives in memory at once.  Peak RAM ≈ one entry's 100K-row batch,
 * not the full decompressed archive size.
 *
 * A single bad entry (encrypted, corrupted/CRC mismatch, etc.) only fails
 * that entry — it's reported via onEntry with errors:1 and processing
 * continues with the rest of the archive. Without this, ULP zips that bundle
 * dozens of stealer-log files would abort entirely (and discard already-
 * imported credentials' result counts) because of one bad file.
 * zipfile-level errors (e.g. unreadable central directory) remain fatal.
 *
 * onEntry is called after each processed entry — successful or not — so the
 * caller can accumulate results incrementally.
 */
function processZipEntries(
  zipfile: yauzl.ZipFile,
  onEntry: (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const rejectArchive = (error: unknown) => {
      if (settled) return
      settled = true
      ;(zipfile as yauzl.ZipFile & { close?: () => void }).close?.()
      reject(error)
    }

    zipfile.readEntry()

    zipfile.on('entry', (entry: yauzl.Entry) => {
      // Skip directory entries
      if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

      const lp = entry.fileName.toLowerCase()
      if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
        zipfile.readEntry()
        return
      }

      const entryName = entry.fileName.split('/').pop() || entry.fileName

      const skipEntry = (entryErr: unknown) => {
        console.error(
          `[upload-processor] skipping zip entry "${entry.fileName}": ` +
          (entryErr instanceof Error ? entryErr.message : String(entryErr))
        )
        onEntry({
          imported:            0,
          skipped:             0,
          errors:              1,
          filename:            entryName,
          breach_name:         matchBreach(entryName),
          rejection_breakdown: makeRejectionMap(),
          alreadyImported:     false,
          tierDropped:         0,
        })
        zipfile.readEntry()
      }

      zipfile.openReadStream(entry, (streamErr, readStream) => {
        if (streamErr) { skipEntry(streamErr); return }

        // Convert Node.js Readable → Web ReadableStream for processTextStream
        const nodeWebStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>
        const reader = nodeWebStream.getReader()
        const webStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) controller.close()
              else controller.enqueue(value)
            } catch (error) {
              controller.error(new ZipEntryStreamError(error))
            }
          },
          cancel(reason) {
            return reader.cancel(reason)
          },
        })

        processTextStream(webStream, entryName)
          .then(result => { onEntry(result); zipfile.readEntry() })
          .catch(error => {
            if (error instanceof ZipEntryStreamError) skipEntry(error.cause)
            else rejectArchive(error)
          })
      })
    })

    zipfile.on('end', () => {
      if (settled) return
      settled = true
      resolve()
    })
    zipfile.on('error', rejectArchive)
  })
}

/**
 * Process a ZIP buffer by streaming its .txt/.csv entries one at a time.
 */
export async function processZipBuffer(
  buffer: Buffer,
  onEntry: (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      processZipEntries(zipfile, onEntry).then(resolve, reject)
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
      processZipEntries(zipfile, onEntry).then(resolve, reject)
    })
  })
}
