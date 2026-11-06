/**
 * One automatic retry for a file the run lost (docs: .scratch ingest-yield-and-throughput, ticket 03). A restart, a stalled import (a suspended lid freezes the
 * connection to ClickHouse), an aborted job or a ClickHouse that dropped the connection says nothing about the file, so the file goes back to the inbox once. A
 * hold, a content error and the second loss of the same file stay in failed/ for the owner. A retry cannot double-write: the import is novelty-aware, so the rows
 * of the first attempt count as known.
 *
 * "Once" is read from the job log: the failure that schedules a retry carries the note AUTO_RETRY_NOTE, and the next failure of that name finds it as the latest row.
 * A finished import (or any other row) after it starts the count again. Names, not instances, are compared, because the log has nothing else to tell files apart by.
 */
import { isTransientClickHouseError } from '@/lib/clickhouse-retry'
import { dbGet } from '@/lib/sqlite'
import { retryFiles } from '@/lib/inbox-helpers'

/** The note on the failed job row that scheduled the automatic retry (processing_jobs.note). */
export const AUTO_RETRY_NOTE = 'auto-retry'
/** How long a file waits in failed/ before it goes back: long enough for a ClickHouse that dropped the connection to come back. */
export const AUTO_RETRY_DELAY_MS = 120_000

export interface LatestJob { status: string; note: string | null }

const nameOf = (e: unknown): string => (typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '')

/** Whether the failure is about the run (an interruption) rather than the file. `instanceof` fails across the app's webpack bundles, so the names count. */
export function isInterruption(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = nameOf(err)
  if (name === 'ImportStalledError' || name === 'AbortError' || name === 'ClickHouseRetryExhaustedError') return true
  return isTransientClickHouseError(err)
}

/** True unless the latest job row for the file is the failure that already scheduled its retry. */
export function mayAutoRetry(latest: LatestJob | undefined): boolean {
  return !(latest && latest.status === 'failed' && latest.note === AUTO_RETRY_NOTE)
}

/** The latest job row of the file (any source), or undefined when there is none or the log cannot be read. Never throws. */
export function latestJobRow(filename: string): LatestJob | undefined {
  try {
    const row = dbGet('SELECT status, note FROM processing_jobs WHERE filename = ? ORDER BY id DESC LIMIT 1', [filename]) as { status: string; note: string | null } | undefined
    return row ? { status: row.status, note: row.note ?? null } : undefined
  } catch {
    return undefined
  }
}

/** Puts the file back in the inbox after the delay. A file that is gone by then (the owner moved or retried it) is not an error. */
export function scheduleAutoRetry(filename: string, deps: { requeue?: (names: string[]) => string[]; delayMs?: number } = {}): void {
  const requeue = deps.requeue ?? ((names: string[]) => retryFiles(names))
  const timer = setTimeout(() => {
    try {
      const moved = requeue([filename])
      if (moved.length > 0) console.warn(`[inbox-watcher] retrying automatically after an interruption: ${filename}`)
    } catch {
      /* the file is gone: nothing to retry */
    }
  }, deps.delayMs ?? AUTO_RETRY_DELAY_MS)
  timer.unref?.()   // a pending retry must not keep the process alive
}
