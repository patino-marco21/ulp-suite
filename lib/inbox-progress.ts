/**
 * How the inbox's live progress line follows novelty-aware ingest (lib/ingest-novelty.ts). Pure, so it can be tested without the
 * watcher.
 */
import type { ImportPhase, ImportProgressEvent } from '@/lib/import-runner'

export interface InboxProgressFields {
  /** Rows written so far: NEW rows with novelty-aware ingest. */
  rows_imported: number
  phase?: ImportPhase
  rows_staged?: number
  rows_known?: number
  slab?: number
  slabs?: number
}

/**
 * Applies one progress event of the file being imported. `base` is what the entries of the same archive that already finished
 * contributed (0 and 0 for a plain text file), because the event's counters belong to the entry in flight only.
 */
export function applyImportProgress(
  progress: InboxProgressFields,
  e: ImportProgressEvent,
  base: { imported: number; known: number },
): void {
  progress.phase = e.phase
  progress.rows_staged = e.staged
  progress.rows_known = base.known + e.known
  progress.rows_imported = base.imported + e.inserted
  progress.slab = e.slab
  progress.slabs = e.slabs
}

/**
 * The rows that count as "done" for the percentage and the ETA: the rows read and staged while novelty-aware ingest is working
 * (the rows written would stay near 0 for most of a file), the rows written otherwise.
 */
export function progressRows(p: { rows_imported: number; phase?: ImportPhase; rows_staged?: number }): number {
  return p.phase ? (p.rows_staged ?? 0) : p.rows_imported
}

export interface ProgressSample {
  started_at: number
  file_size_bytes: number
  rows_imported: number
  phase?: ImportPhase
  rows_staged?: number
  /** Bytes of the file the importer has read so far; undefined where it cannot tell (a ZIP). */
  bytes_read?: number
}

export interface ProgressView {
  rows_per_sec: number
  est_total_rows: number | null
  pct: number | null
  eta_ms: number | null
}

/**
 * The numbers of the progress card. Reading a file is measured by the bytes read, which does not depend on how long its lines are (the card used to assume 80
 * bytes a line; real files have 47-74, so the bar sat at 99% with a negative ETA for the last 14-30% of a file). The rows still to come are estimated from the
 * share of the file read, and the time left from the pace of that share. Once the file is read (checking, writing) the card waits at 99% with the staged rows as
 * the total and no ETA: how long the writes take depends on the files in front of it for the commit lock. Where the importer cannot count bytes (a ZIP) the old
 * estimate from the file size stays.
 */
export function computeProgress(p: ProgressSample, now: number): ProgressView {
  const rowsDone = progressRows(p)
  if (rowsDone <= 0) return { rows_per_sec: 0, est_total_rows: null, pct: null, eta_ms: null }
  const elapsedMs = Math.max(1, now - p.started_at)
  const rows_per_sec = Math.round(rowsDone / (elapsedMs / 1_000))

  if (p.bytes_read !== undefined && p.file_size_bytes > 0) {
    if (p.phase && p.phase !== 'parsing') return { rows_per_sec, est_total_rows: p.rows_staged ?? null, pct: 99, eta_ms: null }
    const fraction = Math.min(1, Math.max(0, p.bytes_read / p.file_size_bytes))
    return {
      rows_per_sec,
      est_total_rows: fraction > 0 ? Math.round(rowsDone / fraction) : null,
      pct: Math.min(99, Math.floor(fraction * 100)),
      eta_ms: fraction > 0 && fraction < 1 ? Math.round(elapsedMs * (1 - fraction) / fraction) : null,
    }
  }

  // No byte counter: assume an average credential line of 80 bytes.
  const est_total_rows = p.file_size_bytes > 0 ? Math.round(p.file_size_bytes / 80) : null
  return {
    rows_per_sec,
    est_total_rows,
    pct: est_total_rows && est_total_rows > 0 ? Math.min(99, Math.round(rowsDone / est_total_rows * 100)) : null,
    eta_ms: est_total_rows && rows_per_sec > 0 ? Math.round((est_total_rows - rowsDone) / rows_per_sec * 1_000) : null,
  }
}
