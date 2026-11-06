/**
 * The staging loop: parse a stream into a table and insert it batch by batch (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step C).
 *
 * Everything here runs on a bare Node thread: it reaches no Next, no SQLite and no job store (__tests__/ingest-stream-boundary.test.ts bundles it and fails
 * when one is reachable). lib/upload-processor.ts re-exports it, so the importer and the benchmark keep their imports; a parse worker runs it by itself.
 */

import { Readable } from 'stream'
import { performance } from 'node:perf_hooks'
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
import { parseIngestPolicy, shouldDropAtIngest } from '@/lib/ingest-filter'
import { csvChunks } from '@/lib/upload-csv'
import { recordGateBatch, type GateCounters } from '@/lib/ingest-quality-gate'

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

function retryErrorSummary(error: unknown): string {
  return privacySafeClickHouseErrorSummary(error)
}

export function makeRetryLogger(
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
  /** Breach label for inserted rows. Required: the label comes from the breach rules in SQLite (lib/breach-matcher.ts), which a worker cannot read; lib/upload-processor.ts fills it for its callers. */
  breachName: string
  /** Hard-tier early-drop predicate, applied inside the parser. */
  shouldHardDrop?: (email: string, url: string) => boolean
  /** Drop a line that repeats an earlier line of the file inside the parser (default true). The staged path turns it off: the stage does it exactly. */
  dedupInFile?: boolean
  /** Called after each batch inserts, with cumulative counts. */
  onProgress?: (imported: number, skipped: number) => void
  /** Optional accumulator (the benchmark and the staged import): time awaiting parse vs awaiting insert. */
  timings?: { parseMs: number; insertMs: number }
  /** Per-batch live metrics (ingest-health panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
  /** Called with each batch's actually-inserted credentials, right after insertBatch succeeds. Not passed by the benchmark — keeps that path free of monitor side effects. */
  onBatchCredentials?: (creds: ULPCredential[]) => void
  /** Aborts the import: no further batch is parsed or inserted, and the insert in flight is cancelled. */
  signal?: AbortSignal
  /** Progress heartbeat for the stall watchdog (lib/import-runner.ts): after each batch, on each retry, on each memory-guard poll. */
  onBeat?: () => void
  /** Counts the lines and the rows that break a rule (lib/ingest-quality-gate.ts). Passed by the staged path and, for a warning only, by the direct path. */
  gate?: GateCounters
  /** Runs once, after the first batch that brings `gate.lines` to `atLines`. A throw ends the import before that batch is written (an early hold costs a million lines, not a 4 GB file). */
  gateCheckpoint?: { atLines: number; check: () => void }
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
  options: StreamToTableOptions,
): Promise<StreamToTableResult> {
  const table       = options.table ?? 'ulp.credentials'
  const batchSize   = options.batchSize ?? UPLOAD_BATCH_SIZE
  const pipeline    = options.pipeline ?? importPipelineEnabled()
  const filterOn    = options.filterOn ?? false
  const dropPolicy  = options.dropPolicy
  const breach_name = options.breachName
  const timings     = options.timings

  let imported = 0
  let skipped = 0
  let tierDropped = 0
  let checkpointDone = false
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

      // The quality gate counts what the parser produced, before the tier filter below drops anything. A hold at the checkpoint throws here, before this
      // batch is written; the finally releases the parser.
      if (options.gate) {
        recordGateBatch(options.gate, batch)
        const cp = options.gateCheckpoint
        if (cp && !checkpointDone && options.gate.lines >= cp.atLines) {
          checkpointDone = true
          cp.check()
        }
      }

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
