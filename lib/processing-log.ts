/**
 * Persistent audit log for upload pipeline jobs.
 *
 * One row per completed file — written by the HTTP upload route and the
 * inbox watcher.  Silent on error so logging never crashes a pipeline.
 */

import { dbRun } from '@/lib/sqlite'

export interface JobLogEntry {
  source:         'http' | 'inbox'
  filename:       string
  status:         'done' | 'failed'
  imported:       number
  skipped:        number
  duration_ms:    number
  error_message?: string
  breach_name?:   string
}

export function logJob(entry: JobLogEntry): void {
  try {
    dbRun(
      `INSERT INTO processing_jobs
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.source,
        entry.filename,
        entry.status,
        entry.imported,
        entry.skipped,
        entry.duration_ms,
        entry.error_message ?? null,
        entry.breach_name   ?? null,
      ],
    )
  } catch {
    // Logging must never crash the upload pipeline
  }
}
