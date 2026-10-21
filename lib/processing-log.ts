/**
 * Persistent audit log for upload pipeline jobs.
 *
 * One row per completed file — written by the HTTP upload route and the
 * inbox watcher.  Silent on error so logging never crashes a pipeline.
 */

import type { PhaseTimings } from '@/lib/phase-timings'
import { dbRun } from '@/lib/sqlite'

export interface JobLogEntry extends Partial<PhaseTimings> {
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
  /** Rows that repeat an earlier row of the same file (novelty-aware ingest). With imported, known and skipped they account for every line. */
  repeats?:       number
  /** Why a finished job added nothing, when it is not an import problem: 'already-imported' (lib/import-summary.ts). */
  note?:          string
}

/**
 * A timing as the column holds it: whole milliseconds (the column is INTEGER, and SQLite would keep a fractional value as a REAL), never negative.
 * Anything that is not a number is 0 rather than a failed INSERT: this function swallows errors, so a NaN would lose the whole job row.
 */
const ms = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)

/** A count as the nullable column holds it: whole and not negative, otherwise NULL ("not recorded"), never a made-up 0. */
const countOrNull = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

export function logJob(entry: JobLogEntry): void {
  try {
    dbRun(
      `INSERT INTO processing_jobs
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name, known, gate_report, parse_ms, check_ms, insert_ms, repeats, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ms(entry.parse_ms),
        ms(entry.check_ms),
        ms(entry.insert_ms),
        countOrNull(entry.repeats),
        entry.note ?? null,
      ],
    )
  } catch {
    // Logging must never crash the upload pipeline
  }
}
