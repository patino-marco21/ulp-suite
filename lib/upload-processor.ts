/**
 * Shared upload processing pipeline.
 *
 * Used by both the HTTP upload route (app/api/upload/route.ts) and the inbox
 * folder watcher (lib/inbox-watcher.ts).  Keeps ClickHouse insertion, source
 * recording, and parsing logic in one place.
 */

import fs from 'fs'
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
import { waitForDiskSpace } from '@/lib/ingest-disk-gate'
import { batchDedupToken } from '@/lib/upload-dedup'
import { parseIngestPolicy, policyActive, shouldDropAtIngest, makeHardDropPredicate } from '@/lib/ingest-filter'
import { csvChunks } from '@/lib/upload-csv'
import { getActiveMonitors, fireMonitorAlertsFromMatches, type DomainMonitor } from '@/lib/domain-monitor'
import { buildMonitorDomainIndex, matchCredentialsAgainstIndex, type MatchedCredential } from '@/lib/domain-match'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'
import { startIngest, recordBatch, finishIngest } from '@/lib/ingest-metrics'
import type { ImportHooks, ImportProgressEvent } from '@/lib/import-runner'
import { noveltyConfig } from '@/lib/ingest-novelty-config'
import { commitStage } from '@/lib/ingest-novelty'
import { createStage, dropStage, newStageId, registerStage, stageTables, unregisterStage } from '@/lib/ingest-stage'

// ─── Public result type ───────────────────────────────────────────────────────

export interface ProcessResult {
  /** Rows written. With novelty-aware ingest (lib/ingest-novelty.ts) this is NEW rows only. */
  imported:            number
  /** Distinct credentials of the file that the table already held (0 on the direct path). */
  known:               number
  /** Rows that repeat an earlier row of the same file (0 on the direct path, which counts them in `skipped`). */
  inFileDuplicates:    number
  skipped:             number
  errors:              number
  filename:            string
  breach_name:         string
  rejection_breakdown: Record<RejectionReason, number>
  /** True when the file was skipped because its filename is already in ulp.sources. */
  alreadyImported:     boolean
  /** Rows dropped pre-insert by the ingest tier filter (lib/ingest-filter.ts). */
  tierDropped:         number
  /** Set when errors > 0 from a skipped zip entry — why it was skipped (oversized, bad ratio, corrupted, encrypted, ...). */
  error_reason?:       string
}

export const UPLOAD_BATCH_SIZE = 100_000

// Cap on in-process domain-monitor matches (lib/domain-match.ts) accumulated
// for a single upload (see processTextStream's monitorMatches). Without a cap,
// a broad monitor could accumulate matches for the entire file's duration,
// unbounded — breaking this file's "peak RAM stays bounded regardless of file
// size" invariant (see processTextStream's docstring below). The old (deleted)
// per-domain ClickHouse query this in-process matching replaced was itself
// capped at LIMIT 100 per monitored domain; this plays the same role.
export const MAX_INPROCESS_MATCHES = 5_000

// Longer than withClickHouseRetry's base 30-minute default: this pipeline is meant
// to be queued up and left running unattended for hours (many large files, one at a
// time). A server can plausibly stay near its memory ceiling for longer than 30
// minutes under that sustained load without any single batch's insert being stuck —
// transient overload (see lib/clickhouse-retry.ts's TRANSIENT_OVERLOAD_MESSAGES)
// deserves a longer runway here than it would for an interactive request. Still
// bounded, not infinite, so a genuinely stuck batch doesn't retry forever.
const IMPORT_RETRY_MAX_ELAPSED_MS = 2 * 60 * 60 * 1_000 // 2 hours

// ─── ClickHouse helpers ───────────────────────────────────────────────────────

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

export async function sourceAlreadyImported(filename: string, hooks: ImportHooks = {}): Promise<boolean> {
  const rows = await withClickHouseRetry(
    async signal => querySourceAlreadyImported(filename, signal),
    { signal: hooks.signal, onRetry: makeRetryLogger('source check', filename, () => hooks.beat?.()) }
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
      const readable = Readable.from(csvChunks(credentials, breach_name), { objectMode: false })

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

export async function recordSource(filename: string, lineCount: number, hooks: ImportHooks = {}): Promise<void> {
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
    { signal: hooks.signal, onRetry: makeRetryLogger('source record', filename, () => hooks.beat?.()) }
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
  /** Drop a line that repeats an earlier line of the file inside the parser (default true). The staged path turns it off: the stage does it exactly. */
  dedupInFile?: boolean
  /** Called after each batch inserts, with cumulative counts. */
  onProgress?: (imported: number, skipped: number) => void
  /** Optional accumulator (benchmark): time awaiting parse vs awaiting insert. */
  timings?: { parseMs: number; insertMs: number }
  /** Per-batch live metrics (ingest-health panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
  /** Called with each batch's actually-inserted credentials, right after insertBatch succeeds. Not passed by the benchmark — keeps that path free of monitor side effects. */
  onBatchCredentials?: (creds: ULPCredential[]) => void
  /** Aborts the import: no further batch is parsed or inserted, and the insert in flight is cancelled. */
  signal?: AbortSignal
  /** Progress heartbeat for the stall watchdog (lib/import-runner.ts): after each batch, on each retry, on each memory-guard poll. */
  onBeat?: () => void
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

  const gen = parseULPStream(stream, filename, batchSize, options.shouldHardDrop, { dedupInFile: options.dedupInFile })
  let pending = gen.next()
  try {
    while (true) {
      options.signal?.throwIfAborted()
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

      // Disk before memory: a full disk is the harsher condition. This pauses (it never fails) while the ClickHouse data disk is
      // under INGEST_MIN_FREE_BYTES and resumes by itself -- see lib/ingest-disk-gate.ts.
      const guardSignal = options.signal ?? new AbortController().signal
      await waitForDiskSpace(guardSignal, { onPoll: options.onBeat })
      await waitForHeadroom(guardSignal, { onPoll: options.onBeat })

      const tInsert = performance.now()
      await insertBatch(creds, breach_name, { signal: options.signal, onRetry: () => options.onBeat?.() }, { table })
      options.onBeat?.()
      const batchInsertMs = performance.now() - tInsert
      if (timings) timings.insertMs += batchInsertMs
      options.onBatchCredentials?.(creds)

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

// ─── Novelty-aware path ───────────────────────────────────────────────────────

interface StagedImport {
  stream:         ReadableStream<Uint8Array>
  filename:       string
  jobId?:         string
  onBatch?:       (imported: number) => void
  hooks:          ImportHooks
  breach_name:    string
  filterOn:       boolean
  softPolicy:     ReturnType<typeof parseIngestPolicy>
  shouldHardDrop: ReturnType<typeof makeHardDropPredicate>
  monitors:       DomainMonitor[]
  monitorsById:   Map<number, DomainMonitor>
  slabRows:       number
}

/**
 * Parse the file into its own stage table, then write only the credentials the table does not hold yet
 * (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md). Nothing reaches ulp.credentials until the commit, so a file
 * that fails while staging leaves no trace in it, and a retry after a failed commit counts what was already written as known.
 */
async function importThroughStage(a: StagedImport): Promise<ProcessResult> {
  const { filename, jobId, hooks } = a
  const tables = stageTables(newStageId())

  let known = 0
  let inserted = 0
  let staged = 0
  let skipped = 0
  const report = (event: ImportProgressEvent) => {
    if (jobId) {
      updateJob(jobId, {
        phase:    event.phase,
        staged:   event.staged,
        skipped:  event.skipped,
        imported: event.inserted,
        known:    event.known,
        slab:     event.slab,
        slabs:    event.slabs,
      })
    }
    hooks.onImportProgress?.(event)
  }

  // Register BEFORE creating: the orphan sweeper (lib/ingest-stage.ts) must never see a table of ours that is not registered.
  registerStage(tables.id)
  try {
    await createStage(tables, { signal: hooks.signal, onRetry: () => hooks.beat?.() })
    hooks.beat?.()

    report({ phase: 'parsing', staged: 0, skipped: 0, known: 0, inserted: 0 })
    startIngest(filename)
    let streamed: StreamToTableResult
    try {
      streamed = await streamCredentialsToTable(a.stream, filename, {
        table:          tables.stage,
        batchSize:      UPLOAD_BATCH_SIZE,
        pipeline:       importPipelineEnabled(),
        filterOn:       a.filterOn,
        dropPolicy:     a.softPolicy,
        breachName:     a.breach_name,
        shouldHardDrop: a.shouldHardDrop,
        dedupInFile:    false,
        signal:         hooks.signal,
        onBeat:         hooks.beat,
        onProgress: (n, skp) => {
          staged = n
          skipped = skp
          report({ phase: 'parsing', staged, skipped, known: 0, inserted: 0 })
        },
        onBatchMetrics: recordBatch,
      })
    } finally {
      finishIngest()
    }
    staged = streamed.imported
    skipped = streamed.skipped
    if (a.filterOn && streamed.tierDropped > 0) {
      console.log(`[ingest-filter] ${filename}: dropped ${streamed.tierDropped} low-tier rows pre-insert`)
    }

    const commit = await commitStage({
      tables,
      target:         'ulp.credentials',
      noveltyAgainst: 'ulp.credentials',
      parsedRows:     streamed.imported,
      slabRows:       a.slabRows,
      signal:         hooks.signal ?? new AbortController().signal,
      beat:           hooks.beat,
      monitors:       a.monitors.map(m => ({ id: m.id, domains: m.domains, match_mode: m.match_mode })),
      matchCap:       MAX_INPROCESS_MATCHES,
      onPhase: e => report({ phase: e.phase, staged, skipped, known, inserted, slab: e.slab, slabs: e.slabs }),
      onSlab: e => {
        known = e.known
        inserted = e.inserted
        a.onBatch?.(e.inserted)
        report({ phase: 'inserting', staged, skipped, known, inserted, slab: e.slab, slabs: e.slabs })
      },
    })

    // A file that had importable lines is remembered even when it added nothing, so the same-name guard stops its re-upload.
    if (streamed.imported > 0) await recordSource(filename, commit.inserted, hooks)
    if (commit.matches.length > 0) {
      fireMonitorAlertsFromMatches(filename, commit.matches, a.monitorsById).catch(err =>
        console.error('Domain monitor alert error:', err)
      )
    }

    return {
      imported:            commit.inserted,
      known:               commit.known,
      inFileDuplicates:    commit.inFileDuplicates,
      skipped,
      errors:              0,
      filename,
      breach_name:         a.breach_name,
      rejection_breakdown: streamed.rejection_breakdown,
      alreadyImported:     false,
      tierDropped:         streamed.tierDropped,
    }
  } finally {
    try {
      await dropStage(tables)
    } catch (err) {
      console.warn(`[upload-processor] could not drop the stage tables of ${filename}; the sweeper will: ${err instanceof Error ? err.message : String(err)}`)
    }
    unregisterStage(tables.id)
  }
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
  /** Abort signal and progress heartbeat from lib/import-runner.ts; both optional. */
  hooks: ImportHooks = {},
): Promise<ProcessResult> {
  const breach_name        = matchBreach(filename)

  // Durable re-upload guard: if this filename is already in ulp.sources it was
  // fully imported before, so skip re-reading/inserting it entirely. This is the
  // authoritative, time-unbounded guard against the inbox watcher reprocessing a
  // file or a duplicate re-upload — complementary to ClickHouse's insert-dedup
  // token, which only covers re-inserts within its (1h default) dedup window.
  if (await sourceAlreadyImported(filename, hooks)) {
    console.log(`[upload-processor] ${filename} already in ulp.sources — skipping re-import`)
    return {
      imported: 0, known: 0, inFileDuplicates: 0, skipped: 0, errors: 0, filename, breach_name,
      rejection_breakdown: makeRejectionMap(), alreadyImported: true, tierDropped: 0,
    }
  }
  hooks.beat?.()

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

  // Load active monitors once up front and match in-process as batches insert,
  // instead of re-querying ClickHouse per monitor domain after the fact. One
  // extra SQLite SELECT per upload attempt (even one that turns out to import
  // nothing) — negligible next to the cost this replaces.
  //
  // Monitor matching is a side-channel on top of the core ingest pipeline, so
  // a SQLite failure here (this project has a known-open issue with
  // SQLITE_READONLY symptoms) must degrade to "no monitor matching for this
  // upload" rather than reject the whole import — the file should still land.
  const monitors      = await getActiveMonitors().catch((err): DomainMonitor[] => {
    console.error('[upload-processor] getActiveMonitors failed, skipping monitor matching for this upload:', err)
    return []
  })
  const monitorsById  = new Map<number, DomainMonitor>(monitors.map(m => [m.id, m]))
  const monitorIndex  = buildMonitorDomainIndex(monitors)
  const monitorMatches: MatchedCredential[] = []
  let matchCapWarned = false

  // Novelty-aware ingest: stage the file, then write only what the table does not hold yet (lib/ingest-novelty.ts). Monitors are
  // matched in ClickHouse on the stage in that path, so the in-process matcher above is not used by it.
  const novelty = noveltyConfig()
  if (novelty.enabled) {
    return importThroughStage({
      stream, filename, jobId, onBatch, hooks, breach_name, filterOn, softPolicy, shouldHardDrop,
      monitors, monitorsById, slabRows: novelty.slabRows,
    })
  }

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
      signal: hooks.signal,
      onBeat: hooks.beat,
      onProgress: (imp, skp) => {
        if (jobId)   updateJob(jobId, { imported: imp, skipped: skp })
        if (onBatch) onBatch(imp)
      },
      onBatchMetrics: recordBatch,
      onBatchCredentials: monitorIndex.size > 0
        ? creds => {
            // Cap accumulation — see MAX_INPROCESS_MATCHES above. Once hit, stop
            // computing further matches too (not just stop pushing), so a huge
            // broadly-matching file doesn't keep paying matchCredentialsAgainstIndex's
            // cost for matches that will be discarded anyway.
            if (monitorMatches.length >= MAX_INPROCESS_MATCHES) return
            const batchMatches = matchCredentialsAgainstIndex(creds, monitorIndex)
            const room = MAX_INPROCESS_MATCHES - monitorMatches.length
            monitorMatches.push(...batchMatches.slice(0, room))
            if (monitorMatches.length >= MAX_INPROCESS_MATCHES && !matchCapWarned) {
              matchCapWarned = true
              console.warn(`[upload-processor] ${filename}: hit MAX_INPROCESS_MATCHES cap (${MAX_INPROCESS_MATCHES}) — further monitor matches in this upload will not be alerted`)
            }
          }
        : undefined,
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
    await recordSource(filename, imported, hooks)
    if (monitorMatches.length > 0) {
      fireMonitorAlertsFromMatches(filename, monitorMatches, monitorsById).catch(err =>
        console.error('Domain monitor alert error:', err)
      )
    }
    // Cross-file content dedup remains available through the scheduled/manual
    // dedup flows; imports no longer trigger a full-table dedup hook here.
  }

  return { imported, known: 0, inFileDuplicates: 0, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
}

/**
 * Import a text file that is already on disk (an inbox file or a spooled upload) through the same pipeline as a stream.
 * This is the one place a file is turned into a stream, so the inbox and the HTTP routes cannot drift apart.
 */
export async function processTextFile(
  filePath: string,
  filename: string,
  jobId?: string,
  onBatch?: (imported: number) => void,
  hooks: ImportHooks = {},
): Promise<ProcessResult> {
  const nodeStream = fs.createReadStream(filePath)
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
  try {
    return await processTextStream(webStream, filename, jobId, onBatch, hooks)
  } finally {
    nodeStream.destroy()
  }
}

// ─── ZIP processor (yauzl — lazy entry streaming) ────────────────────────────

class ZipEntryStreamError extends Error {
  constructor(public override cause: unknown) {
    super('ZIP entry stream failed', { cause })
    this.name = 'ZipEntryStreamError'
  }
}

// Decompression-bomb guards, checked against each entry's central-directory
// metadata BEFORE ever calling openReadStream. yauzl's validateEntrySizes
// (on by default — see node_modules/yauzl) only checks that the actual
// decompressed byte count MATCHES what an entry claims; it doesn't cap how
// large that claim is allowed to be, so an honestly-reported multi-TB entry
// from a handful of compressed bytes would otherwise decompress in full.
export const MAX_ZIP_ENTRIES = 100_000
// 50 GB — generous for one huge stealer log (legitimate archives here
// bundle "dozens" of files, per processZipEntries' own docs above), but finite.
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 ** 3
// Ordinary text rarely exceeds ~10-20:1 with DEFLATE, even highly repetitive
// structured log data. Real zip bombs routinely claim 1000:1+.
export const MAX_ZIP_COMPRESSION_RATIO = 300
// Don't flag tiny entries on ratio alone — a 50-byte entry expanding to 5KB
// is a 100:1 ratio but poses no real resource risk.
export const MIN_RATIO_CHECK_BYTES = 10 * 1024 * 1024

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
export function processZipEntries(
  zipfile: yauzl.ZipFile,
  onEntry: (result: ProcessResult) => void,
  hooks: ImportHooks = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let entriesSeen = 0
    const onAbort = () => rejectArchive(hooks.signal?.reason ?? new Error('ZIP import aborted'))
    const rejectArchive = (error: unknown) => {
      if (settled) return
      settled = true
      hooks.signal?.removeEventListener('abort', onAbort)
      ;(zipfile as yauzl.ZipFile & { close?: () => void }).close?.()
      reject(error)
    }

    if (hooks.signal?.aborted) {
      onAbort()
      return
    }
    hooks.signal?.addEventListener('abort', onAbort, { once: true })

    zipfile.readEntry()

    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (settled) return // aborted or failed meanwhile: do not open another entry
      hooks.beat?.()
      // Archive-level guard: too many entries is itself the resource cost
      // (central-directory iteration), so this aborts the whole archive
      // rather than skipping one entry — there's no safe way to "continue".
      entriesSeen++
      if (entriesSeen > MAX_ZIP_ENTRIES) {
        rejectArchive(new Error(
          `ZIP archive exceeds ${MAX_ZIP_ENTRIES} entries — refusing to process further (possible zip bomb)`
        ))
        return
      }

      // Skip directory entries
      if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

      const lp = entry.fileName.toLowerCase()
      if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
        zipfile.readEntry()
        return
      }

      const entryName = entry.fileName.split('/').pop() || entry.fileName

      const skipEntry = (entryErr: unknown) => {
        const reason = entryErr instanceof Error ? entryErr.message : String(entryErr)
        console.error(`[upload-processor] skipping zip entry "${entry.fileName}": ${reason}`)
        onEntry({
          imported:            0,
          known:               0,
          inFileDuplicates:    0,
          skipped:             0,
          errors:              1,
          filename:            entryName,
          breach_name:         matchBreach(entryName),
          rejection_breakdown: makeRejectionMap(),
          alreadyImported:     false,
          tierDropped:         0,
          error_reason:        reason,
        })
        zipfile.readEntry()
      }

      // Per-entry decompression-bomb guard — checked against claimed
      // metadata before ever opening a read stream, so a bomb entry is
      // never actually decompressed.
      if (entry.uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
        skipEntry(new Error(
          `entry uncompressed size ${entry.uncompressedSize} exceeds ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES}-byte cap`
        ))
        return
      }
      if (
        entry.uncompressedSize > MIN_RATIO_CHECK_BYTES &&
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > MAX_ZIP_COMPRESSION_RATIO
      ) {
        skipEntry(new Error(
          `entry compression ratio ${Math.round(entry.uncompressedSize / entry.compressedSize)}:1 exceeds ` +
          `${MAX_ZIP_COMPRESSION_RATIO}:1 cap (possible zip bomb)`
        ))
        return
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

        processTextStream(webStream, entryName, undefined, undefined, hooks)
          .then(result => { onEntry(result); hooks.beat?.(); zipfile.readEntry() })
          .catch(error => {
            if (error instanceof ZipEntryStreamError) skipEntry(error.cause)
            else rejectArchive(error)
          })
      })
    })

    zipfile.on('end', () => {
      if (settled) return
      settled = true
      hooks.signal?.removeEventListener('abort', onAbort)
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
  hooks:   ImportHooks = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      processZipEntries(zipfile, onEntry, hooks).then(resolve, reject)
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
  hooks:    ImportHooks = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      processZipEntries(zipfile, onEntry, hooks).then(resolve, reject)
    })
  })
}
