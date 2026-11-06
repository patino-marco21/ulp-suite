/**
 * The messages between the importer (lib/ingest-pool.ts) and a parse worker (lib/ingest-worker.ts), docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step C.
 * Types only: the worker bundle and the app both import this, and it imports nothing at run time.
 */
import type { GateCounters, GateReport } from '@/lib/ingest-quality-gate'
import type { StreamToTableResult } from '@/lib/ingest-stream'

/** One file to stage, as plain data (the worker's workerData). The worker reads the file itself and builds the ingest policy and the gate settings from the same environment. */
export interface StageJob {
  /** The plain file on disk the worker opens. */
  path: string
  filename: string
  /** The stage table the rows go to. The importer creates it before the worker starts and drops it after. */
  table: string
  breachName: string
  /** Whether the soft tier filter applies (the importer worked it out from the same policy). */
  filterOn: boolean
  /** An admin released this file from the Held list: the early check reports and does not hold. */
  gateOverride: boolean
  batchSize: number
  pipeline: boolean
}

export interface StageTimings { parseMs: number; insertMs: number }

export interface BatchMetrics { rows: number; parseMs: number; insertMs: number; tierDropped: number }

/** What a worker says. `done`, `held` and `error` each end the job. */
export type WorkerMessage =
  | { type: 'beat' }
  | { type: 'progress'; staged: number; skipped: number; bytes: number }
  | ({ type: 'metrics' } & BatchMetrics)
  | { type: 'done'; result: StreamToTableResult; gate: GateCounters | null; timings: StageTimings }
  | { type: 'held'; report: GateReport }
  | { type: 'error'; name: string; message: string }

/** What the importer says to a worker. */
export type ParentMessage = { type: 'abort' }
