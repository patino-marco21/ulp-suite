/**
 * Global upload concurrency limiter.
 *
 * pLimit(1) = one file processed at a time; all others wait in FIFO order.
 * Both the HTTP upload route and the inbox watcher share this queue so they
 * never compete for memory.
 *
 * Raise to 2–3 on machines with ≥16 GB RAM and multi-core CPUs if throughput
 * matters more than peak-memory predictability.
 */
import pLimit from 'p-limit'

/**
 * Parse UPLOAD_CONCURRENCY into a safe limiter size.
 * Invalid, empty, zero, or negative values fall back to 1.
 *
 * NB: raising this multiplies peak heap — each concurrent file holds its own
 * in-flight batch(es) AND its own ~440 MB-capped dedup Set. Only raise on
 * hardware with memory headroom. getCurrentJob() becomes best-effort ("one of
 * N") when concurrency > 1.
 */
export function parseConcurrency(raw?: string): number {
  const n = parseInt(raw ?? '1', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

export const uploadQueue = pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY))

/** Total number of uploads currently running + waiting. */
export function queueSize(): number {
  return uploadQueue.activeCount + uploadQueue.pendingCount
}

// ── Current job tracking ──────────────────────────────────────────────────────

let _currentJob: string | null = null

/** Set the filename of the job currently being processed. Pass null when done. */
export function setCurrentJob(name: string | null): void {
  _currentJob = name
}

/** Returns the filename currently being processed, or null if the queue is idle. */
export function getCurrentJob(): string | null {
  return _currentJob
}
