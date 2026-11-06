/**
 * The parse pool: stage a file in a worker thread instead of on the importer's one thread (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step C).
 *
 * `INGEST_PARSE_WORKERS` (default 0 = off, at most 12) is the number of files that parse at once. Each file gets its own worker (lib/ingest-worker.ts, bundled to
 * dist/ingest-worker.cjs by scripts/build-ingest-worker.mjs), so a worker that fails, runs out of memory or hangs takes only its file with it: the importer rejects,
 * the stage is dropped by the importer's own `finally`, and the next file starts a fresh worker. The state is on globalThis because the watcher and the routes are
 * separate webpack bundles of this module.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import pLimit from 'p-limit'
import { IngestHeldError, type GateCounters } from '@/lib/ingest-quality-gate'
import type { StreamToTableResult } from '@/lib/ingest-stream'
import type { BatchMetrics, ParentMessage, StageJob, StageTimings, WorkerMessage } from '@/lib/ingest-worker-protocol'

export type { StageJob } from '@/lib/ingest-worker-protocol'

export const MAX_PARSE_WORKERS = 12
/** A file smaller than this is staged on the importer's thread: a worker costs a start-up that a small file would not earn back. */
export const MIN_WORKER_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_HEAP_MB = 768
const DEFAULT_TERMINATE_GRACE_MS = 20_000

/** The number of parse workers asked for; 0 (the default, and for anything that is not a positive number) keeps today's in-process path. */
export function parseWorkers(env: NodeJS.Dict<string> = process.env): number {
  const n = parseInt(env.INGEST_PARSE_WORKERS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PARSE_WORKERS) : 0
}

export function workerFile(env: NodeJS.Dict<string> = process.env): string {
  const set = env.INGEST_WORKER_FILE?.trim()
  return set ? set : join(process.cwd(), 'dist', 'ingest-worker.cjs')
}

export function workerAvailable(env: NodeJS.Dict<string> = process.env): boolean {
  return existsSync(workerFile(env))
}

/** The bundle is not there: the importer stages on its own thread and says so once. */
export class WorkerUnavailableError extends Error {
  constructor(file: string) {
    super(`the parse worker bundle is missing: ${file}`)
    this.name = 'WorkerUnavailableError'
  }
}

export interface StageCallbacks {
  onBeat: () => void
  onProgress: (staged: number, skipped: number, bytesRead: number) => void
  onMetrics: (m: BatchMetrics) => void
}

export interface StageOutcome {
  result: StreamToTableResult
  /** The gate's counters for the whole file (null when the gate is off), to be merged into the importer's own for the final check. */
  gate: GateCounters | null
  timings: StageTimings
}

export interface StageOptions {
  /** Aborted when the job is cancelled or stalls: the worker is told, and terminated if it has not stopped after `terminateGraceMs`. */
  signal?: AbortSignal
  workerFile?: string
  /** How many workers run at once. Default: INGEST_PARSE_WORKERS. */
  slots?: number
  /** Names a separate limiter (tests). */
  limiterKey?: string
  maxOldGenerationSizeMb?: number
  terminateGraceMs?: number
}

declare global {
  // eslint-disable-next-line no-var
  var __ulpParsePool: Map<string, ReturnType<typeof pLimit>> | undefined
}

function limiterFor(key: string, slots: number): ReturnType<typeof pLimit> {
  const all = (globalThis.__ulpParsePool ??= new Map())
  const id = `${key}:${slots}`
  let limit = all.get(id)
  if (!limit) all.set(id, (limit = pLimit(slots)))
  return limit
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/** Stage one file in a worker. Resolves with what the staging loop returned; rejects with the worker's error, an IngestHeldError for a hold, or the abort reason. */
export function stageInWorker(job: StageJob, callbacks: StageCallbacks, options: StageOptions = {}): Promise<StageOutcome> {
  const file = options.workerFile ?? workerFile()
  if (!existsSync(file)) return Promise.reject(new WorkerUnavailableError(file))
  const slots = options.slots ?? Math.max(1, parseWorkers())
  return limiterFor(options.limiterKey ?? 'default', slots)(() => runWorker(file, job, callbacks, options))
}

function runWorker(file: string, job: StageJob, cb: StageCallbacks, options: StageOptions): Promise<StageOutcome> {
  const { signal } = options
  signal?.throwIfAborted()
  return new Promise<StageOutcome>((resolve, reject) => {
    const worker = new Worker(file, {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? DEFAULT_HEAP_MB },
    })
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const end = (settle: () => void) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      settle()
      void worker.terminate()   // a worker that is done or failed is gone; terminate is a no-op once it has exited
    }

    const onAbort = () => {
      if (settled) return
      worker.postMessage({ type: 'abort' } satisfies ParentMessage)
      // A worker stuck in a long synchronous step never reads the message; it must not keep the job, and its queue slot, forever.
      killTimer = setTimeout(() => { void worker.terminate() }, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS)
      killTimer.unref?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (m: WorkerMessage) => {
      if (settled) return
      switch (m.type) {
        case 'beat': cb.onBeat(); break
        case 'progress': cb.onProgress(m.staged, m.skipped, m.bytes); break
        case 'metrics': cb.onMetrics({ rows: m.rows, parseMs: m.parseMs, insertMs: m.insertMs, tierDropped: m.tierDropped }); break
        case 'done': end(() => resolve({ result: m.result, gate: m.gate, timings: m.timings })); break
        case 'held': end(() => reject(new IngestHeldError(m.report))); break
        case 'error': end(() => reject(signal?.aborted ? abortReason(signal) : Object.assign(new Error(m.message), { name: m.name }))); break
      }
    })
    worker.on('error', err => end(() => reject(signal?.aborted ? abortReason(signal) : err)))
    worker.on('exit', code => end(() => reject(signal?.aborted ? abortReason(signal) : new Error(`the parse worker exited with code ${code} before it was done`))))
  })
}
