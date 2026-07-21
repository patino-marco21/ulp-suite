/**
 * Shared upload processing pipeline.
 *
 * Used by both the HTTP upload route (app/api/upload/route.ts) and the inbox
 * folder watcher (lib/inbox-watcher.ts).  Keeps ClickHouse insertion, source
 * recording, and parsing logic in one place.
 */

import { Readable } from 'stream'
import { performance } from 'node:perf_hooks'
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
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { batchDedupToken } from '@/lib/upload-dedup'
import { parseIngestPolicy, policyActive, shouldDropAtIngest, makeHardDropPredicate } from '@/lib/ingest-filter'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'
import { startIngest, recordBatch, finishIngest } from '@/lib/ingest-metrics'

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

// Longer than withClickHouseRetry's base 30-minute default: this pipeline is meant
// to be queued up and left running unattended for hours (many large files, one at a
// time). A server can plausibly stay near its memory ceiling for longer than 30
// minutes under that sustained load without any single batch's insert being stuck —
// transient overload (see lib/clickhouse-retry.ts's TRANSIENT_OVERLOAD_MESSAGES)
// deserves a longer runway here than it would for an interactive request. Still
// bounded, not infinite, so a genuinely stuck batch doesn't retry forever.
const IMPORT_RETRY_MAX_ELAPSED_MS = 2 * 60 * 60 * 1_000 // 2 hours

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
          // The default profile sets async_insert=1 for combining many small inserts.
          // A 100K-row batch is already large and has its own retry/dedup-token
          // logic, so it gets no benefit from that buffer — only the extra memory
          // cost of going through it. Must be explicit: leaving this key absent
          // does not disable async_insert, it inherits the profile default.
          async_insert:             0 as any,
        },
      })
    },
    {
      maxElapsedMs: IMPORT_RETRY_MAX_ELAPSED_MS,
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

// ─── Core stream→table loop (pipelined) ──────────────────────────────────────

/**
 * Pipelining is ON unless explicitly disabled. It overlaps parsing of the next
 * batch with the insert of the current one, costing at most one extra resident
 * batch (~30 MB at 100K rows). Set IMPORT_PIPELINE=off to fall back to strictly
 * sequential parse→insert (kill-switch / benchmark comparison).
 */
export function importPipelineEnabled(): boolean {
  return process.env.IMPORT_PIPELINE !== 'off'
}

export interface StreamToTableOptions {
  /** Target table. Default 'ulp.credentials'. Benchmark passes a 'ulp.bench_*' table. */
  table?: string
  /** Rows per parser batch. Default UPLOAD_BATCH_SIZE. */
  batchSize?: number
  /** Overlap parse(N+1) with insert(N). Default importPipelineEnabled(). */
  pipeline?: boolean
  /** Apply the ingest tier filter. Default false. */
  filterOn?: boolean
  /** Drop policy used when filterOn. */
  dropPolicy?: ReturnType<typeof parseIngestPolicy>
  /** Breach label for inserted rows. Default matchBreach(filename). */
  breachName?: string
  /** Hard-tier early-drop predicate, applied inside the parser. */
  shouldHardDrop?: (email: string, url: string) => boolean
  /** Called after each batch inserts, with cumulative counts. */
  onProgress?: (imported: number, skipped: number) => void
  /** Optional accumulator (benchmark): time awaiting parse vs awaiting insert. */
  timings?: { parseMs: number; insertMs: number }
  /** Per-batch live metrics (ingest-health panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
}

export interface StreamToTableResult {
  imported: number
  skipped: number
  tierDropped: number
  rejection_breakdown: Record<RejectionReason, number>
}

/**
 * Core parse→insert loop, free of source-recording and monitor side effects so
 * the benchmark can drive the real path against a throwaway table.
 *
 * Prefetch-one pipelining: when `pipeline`, the next parser batch is requested
 * BEFORE awaiting the current insert, so the parser's CPU work fills the insert's
 * I/O wait. At most two batches are ever resident. Exactly one insert is awaited
 * at a time, in order — preserving synchronous, retryable, dedup-token semantics.
 * On any insert failure the finally stops the generator (releasing the stream
 * reader lock) and absorbs the in-flight prefetch so it cannot become an
 * unhandled rejection; the original error propagates and aborts the file.
 */
export async function streamCredentialsToTable(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  options: StreamToTableOptions = {},
): Promise<StreamToTableResult> {
  const table       = options.table ?? 'ulp.credentials'
  const batchSize   = options.batchSize ?? UPLOAD_BATCH_SIZE
  const pipeline    = options.pipeline ?? importPipelineEnabled()
  const filterOn    = options.filterOn ?? false
  const dropPolicy  = options.dropPolicy
  const breach_name = options.breachName ?? matchBreach(filename)
  const timings     = options.timings

  let imported = 0
  let skipped = 0
  let tierDropped = 0
  const rejection_breakdown = makeRejectionMap()

  const gen = parseULPStream(stream, filename, batchSize, options.shouldHardDrop)
  let pending = gen.next()
  try {
    while (true) {
      const tParse = performance.now()
      const { value: batch, done } = await pending
      const batchParseMs = performance.now() - tParse
      if (timings) timings.parseMs += batchParseMs
      if (done) break

      // Kick off parsing of the NEXT batch before blocking on this insert.
      if (pipeline) pending = gen.next()

      let creds = batch.credentials
      if (filterOn && dropPolicy) {
        const kept = creds.filter(c => !shouldDropAtIngest(c.email, c.url, c.domain, dropPolicy))
        tierDropped += creds.length - kept.length
        creds = kept
      }
      skipped += batch.rejected
      for (const [k, v] of Object.entries(batch.breakdown)) {
        rejection_breakdown[k as RejectionReason] =
          (rejection_breakdown[k as RejectionReason] ?? 0) + v
      }

      const guardController = new AbortController()
      await waitForHeadroom(guardController.signal)

      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
      if (timings) timings.insertMs += batchInsertMs

      imported += creds.length
      options.onProgress?.(imported, skipped)
      options.onBatchMetrics?.({
        rows: creds.length,
        parseMs: batchParseMs,
        insertMs: batchInsertMs,
        tierDropped: batch.breakdown.tier_dropped ?? 0,
      })

      // Sequential fallback: only fetch the next batch after the insert is done.
      if (!pipeline) pending = gen.next()
    }
  } finally {
    await gen.return(undefined).catch(() => {})
    await Promise.resolve(pending).catch(() => {})
  }

  return { imported, skipped, tierDropped, rejection_breakdown }
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

  // Ingest tier filter — hard tiers drop in the parser (earliest); the rest
  // (noise/soft-tier/suffix) stays in the post-batch filter so kept rows are
  // never re-classified.
  const policy         = parseIngestPolicy()
  const shouldHardDrop = makeHardDropPredicate(policy)
  const softPolicy     = { ...policy, hardTiers: new Set<string>() }
  const filterOn       = policyActive(softPolicy)

  startIngest(filename)
  let result
  try {
    result = await streamCredentialsToTable(stream, filename, {
      table:      'ulp.credentials',
      batchSize:  UPLOAD_BATCH_SIZE,
      pipeline:   importPipelineEnabled(),
      filterOn,
      dropPolicy: softPolicy,
      breachName: breach_name,
      shouldHardDrop,
      onProgress: (imp, skp) => {
        if (jobId)   updateJob(jobId, { imported: imp, skipped: skp })
        if (onBatch) onBatch(imp)
      },
      onBatchMetrics: recordBatch,
    })
  } finally {
    finishIngest()
  }

  imported    = result.imported
  skipped     = result.skipped
  tierDropped = result.tierDropped
  Object.assign(rejection_breakdown, result.rejection_breakdown)

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
