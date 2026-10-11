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
