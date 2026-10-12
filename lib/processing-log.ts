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
  status:         'done' | 'failed' | 'held'
  /** Rows written. With novelty-aware ingest, NEW rows only. */
  imported:       number
  skipped:        number
  duration_ms:    number
  error_message?: string
  breach_name?:   string
  /** Distinct credentials of the file that the table already held (novelty-aware ingest). */
  known?:         number
  /** The quality gate's JSON report (lib/ingest-quality-gate.ts) for a held file, or for a file imported with a warning. */
  gate_report?:   string
}

export function logJob(entry: JobLogEntry): void {
  try {
    dbRun(
      `INSERT INTO processing_jobs
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name, known, gate_report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.source,
        entry.filename,
        entry.status,
        entry.imported,
        entry.skipped,
        entry.duration_ms,
        entry.error_message ?? null,
        entry.breach_name   ?? null,
        entry.known         ?? 0,
        entry.gate_report   ?? null,
      ],
    )
  } catch {
    // Logging must never crash the upload pipeline
  }
}
