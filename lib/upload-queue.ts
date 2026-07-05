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

// globalThis-backed singletons -----------------------------------------------
//
// instrumentation.ts (which starts the inbox watcher) and the API routes that
// read/use this queue are compiled into SEPARATE webpack chunks in this app's
// production (output: 'standalone') build -- confirmed by inspecting the
// compiled .next/server/ output, where this file's code appeared duplicated
// across multiple chunk files. A plain module-scope `const`/`let` here would
// silently become multiple independent instances: one that the real watcher
// updates, and others -- always empty -- that routes read. globalThis is one
// true object per OS process regardless of which chunk loaded this file, so
// anchoring state to it is what makes it actually shared. See
// docs/superpowers/specs/2026-07-05-inbox-status-globalthis-singleton-design.md
declare global {
  // eslint-disable-next-line no-var
  var __ulpUploadQueue: ReturnType<typeof pLimit> | undefined
  // eslint-disable-next-line no-var
  var __ulpCurrentJob: string | null | undefined
}

export const uploadQueue =
  globalThis.__ulpUploadQueue ??
  (globalThis.__ulpUploadQueue = pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY)))

/** Total number of uploads currently running + waiting. */
export function queueSize(): number {
  return uploadQueue.activeCount + uploadQueue.pendingCount
}

// ── Current job tracking ──────────────────────────────────────────────────────

/** Set the filename of the job currently being processed. Pass null when done. */
export function setCurrentJob(name: string | null): void {
  globalThis.__ulpCurrentJob = name
}

/** Returns the filename currently being processed, or null if the queue is idle. */
export function getCurrentJob(): string | null {
  return globalThis.__ulpCurrentJob ?? null
}
