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
