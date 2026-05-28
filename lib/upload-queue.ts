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

export const uploadQueue = pLimit(1)

/** Total number of uploads currently running + waiting. */
export function queueSize(): number {
  return uploadQueue.activeCount + uploadQueue.pendingCount
}
