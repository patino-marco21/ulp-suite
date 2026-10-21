/**
 * Wording and arithmetic for what an import did, shared by the Upload and Inbox pages (docs/superpowers/specs/
 * 2026-10-02-novelty-aware-ingest-design.md). Pure, so the pages stay thin and this is tested.
 */
import type { ImportPhase } from '@/lib/import-runner'

const count = (n: number | undefined) => (n ?? 0).toLocaleString('en-US')

/** Lines the parser accepted: new rows, rows the database already held, and rows repeated inside the file. */
export function keptRows(r: { imported: number; known?: number; inFileDuplicates?: number }): number {
  return r.imported + (r.known ?? 0) + (r.inFileDuplicates ?? 0)
}

/** The accepted share of all lines, to one decimal. On the direct path known and repeated are 0, so this is the old import rate. */
export function importRatePct(r: { imported: number; known?: number; inFileDuplicates?: number; skipped: number }): number {
  const kept = keptRows(r)
  const total = kept + r.skipped
  return total > 0 ? Math.round((kept / total) * 1000) / 10 : 0
}

/** One line for the progress card, or null when there is no phase to describe (the direct path). */
export function phaseLine(p: {
  phase?: ImportPhase | null
  staged?: number
  known?: number
  imported?: number
  slab?: number | null
  slabs?: number | null
}): string | null {
  if (!p.phase) return null
  const part = p.slabs && p.slabs > 1 && p.slab ? ` (part ${p.slab} of ${p.slabs})` : ''
  if (p.phase === 'parsing') return `Reading the file: ${count(p.staged)} rows so far`
  if (p.phase === 'checking') return `Checking ${count(p.staged)} rows against the database${part}`
  return `Writing the new rows${part}: ${count(p.imported)} new, ${count(p.known)} already in the database so far`
}

/** "1.2M rows" as before when nothing was known, otherwise "1.2M new · 340K known". */
export function newKnownLabel(imported: number, known: number | undefined, fmt: (n: number) => string): string {
  return (known ?? 0) > 0 ? `${fmt(imported)} new · ${fmt(known ?? 0)} known` : `${fmt(imported)} rows`
}

// ─── What a job row says about the lines of a file ────────────────────────────────────────────────────────────────────────────────────────────────

/** The note a job row carries when the same-name check skipped the whole file (processing_jobs.note). */
export const ALREADY_IMPORTED_NOTE = 'already-imported'

/** What the files of one job (one for a text file, one per entry for a ZIP) add up to, besides the counts the row already has. */
export interface JobTally {
  entries: number
  alreadyImported: number
  repeats: number
}

export const newJobTally = (): JobTally => ({ entries: 0, alreadyImported: 0, repeats: 0 })

/** Adds one imported file or one entry of a ZIP. An entry that failed counts for nothing: the same-name check did not skip it. */
export function addToTally(t: JobTally, r: { inFileDuplicates: number; alreadyImported: boolean; errors: number }): void {
  if (r.errors > 0) return
  t.entries++
  if (r.alreadyImported) t.alreadyImported++
  t.repeats += r.inFileDuplicates
}

/** What a finished job shows in place of its counts: a skipped file says so ("0 rows" reads like an import that found nothing). */
export function jobLabel(j: { imported: number; known?: number; note?: string | null }, fmt: (n: number) => string): string {
  return j.note === ALREADY_IMPORTED_NOTE ? 'already imported · skipped' : newKnownLabel(j.imported, j.known, fmt)
}

/** The tally of one file that was imported on its own, a text file. */
export function tallyOf(r: { inFileDuplicates: number; alreadyImported: boolean; errors: number }): JobTally {
  const t = newJobTally()
  addToTally(t, r)
  return t
}

/** The two job-row fields the tally decides. The note is set only when there was at least one entry and the check skipped every one. */
export function jobAccounting(t: JobTally): { repeats: number; note?: string } {
  return t.entries > 0 && t.alreadyImported === t.entries ? { repeats: t.repeats, note: ALREADY_IMPORTED_NOTE } : { repeats: t.repeats }
}

/**
 * Where the lines of a finished job went, for a tooltip. A job from before the repeated rows were recorded (`repeats` null) has no total: its
 * lines could not be added up, so the parts are listed without one.
 */
export function jobAccountingTitle(j: { imported: number; known?: number; repeats?: number | null; skipped: number; note?: string | null }): string {
  if (j.note === ALREADY_IMPORTED_NOTE) return 'A file with this name (and size) was imported before, so it was not read again'
  const parts = [`${count(j.imported)} new`, `${count(j.known)} already in the database`]
  if (j.repeats !== null && j.repeats !== undefined) parts.push(`${count(j.repeats)} repeated inside the file`)
  parts.push(`${count(j.skipped)} rejected`)
  const total = j.repeats === null || j.repeats === undefined ? '' : `${count(j.imported + (j.known ?? 0) + j.repeats + j.skipped)} lines: `
  return total + parts.join(' · ')
}
