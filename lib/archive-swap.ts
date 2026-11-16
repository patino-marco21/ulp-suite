/**
 * Stage D of the reduced archive (docs/superpowers/plans/2026-11-16-reduced-archive-stage-d.md): the whole-file entry of an old file is swapped for its reduced entry.
 * A swap appends one line to the main manifest (the old entry plus `reduced_id` and `whole_removed_at`; a later line supersedes an earlier one, as `replaced_at` does) and
 * only then removes `<id>.zst`. Which entries may be swapped, and how one swap is done, live here as plain values and a few file operations; nothing in this module runs on
 * its own, and `scripts/reduce-archive.ts swap --apply` is the only caller that removes anything.
 */
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readReduced, reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import { SKIP_REASON, type ShadowLine } from '@/lib/reduced-shadow'
import { appendManifest, latestByName, readManifest, verifyEntry, type ManifestEntry } from '@/lib/source-archive'

/** The owner's rule (2026-11-16): swap an entry whose reduced version is at least this many percent smaller on disk. */
export const MIN_SAVING_PCT = 10

export type LeftReason = 'already-swapped' | 'no-whole-file' | 'long-line' | 'no-reduced' | 'not-exact' | 'below-threshold'

export interface SwapItem {
  whole: ManifestEntry
  reduced: ReducedEntry
  /** Bytes on disk the whole entry holds beyond the reduced one. */
  savedBytes: number
}

export type SwapOutcome = { ok: true; freedBytes: number } | { ok: false; reason: string }

const keyOf = (name: string, sha: string): string => `${name}\0${sha}`

/** The whole-file entry's `<id>.zst` was removed and the reduced entry stands for it. */
export const isSwapped = (e: ManifestEntry): boolean => e.whole_removed_at !== undefined

/** The reduced entry is made from exactly this whole entry (same bytes, by hash and by size). */
const stands = (r: ReducedEntry, w: ManifestEntry): boolean => r.of.sha256 === w.sha256 && r.of.size === w.size

/** The reduced entry a swapped entry points at; undefined when it does not exist or was made from other bytes. */
export function reducedFor(archiveDir: string, e: ManifestEntry, reduced: ReducedEntry[] = readReduced(archiveDir)): ReducedEntry | undefined {
  if (!e.reduced_id) return undefined
  for (let i = reduced.length - 1; i >= 0; i--) if (reduced[i].id === e.reduced_id && stands(reduced[i], e)) return reduced[i]
  return undefined
}

export interface CandidateOptions {
  /** `latestByName` of the main manifest. */
  wholes: Map<string, ManifestEntry>
  reduced: ReducedEntry[]
  /** The shadow log: the latest result of each (name, bytes) decides whether the entry is exact. */
  log: ShadowLine[]
  wholeOnDisk: (e: ManifestEntry) => boolean
  minSavingPct?: number
}

export function swapCandidates(o: CandidateOptions): { eligible: SwapItem[]; left: Record<LeftReason, number> } {
  const min = o.minSavingPct ?? MIN_SAVING_PCT
  const left: Record<LeftReason, number> = { 'already-swapped': 0, 'no-whole-file': 0, 'long-line': 0, 'no-reduced': 0, 'not-exact': 0, 'below-threshold': 0 }
  const reducedBy = new Map<string, ReducedEntry>()
  for (const r of o.reduced) reducedBy.set(keyOf(r.name, r.of.sha256), r)   // a later line (an entry made again) supersedes an earlier one
  const last = new Map<string, ShadowLine>()
  for (const l of o.log) last.set(keyOf(l.name, l.sha256), l)
  const eligible: SwapItem[] = []
  for (const name of [...o.wholes.keys()].sort()) {
    const whole = o.wholes.get(name)!
    if (isSwapped(whole)) { left['already-swapped']++; continue }
    if (!o.wholeOnDisk(whole)) { left['no-whole-file']++; continue }
    const k = keyOf(name, whole.sha256)
    const line = last.get(k)
    if (line && !line.ok && line.reason === SKIP_REASON) { left['long-line']++; continue }
    const reduced = reducedBy.get(k)
    if (!reduced || !stands(reduced, whole)) { left['no-reduced']++; continue }
    if (line && !line.ok) { left['not-exact']++; continue }
    const savedBytes = whole.archive_bytes - reduced.archive_bytes
    if (savedBytes * 100 < min * whole.archive_bytes) { left['below-threshold']++; continue }
    eligible.push({ whole, reduced, savedBytes })
  }
  return { eligible, left }
}

/** The `<id>.zst` of a swapped entry, removed when no other name that is not swapped shares it (one file holds the bytes of every name with the same content). */
function removeWholeFile(archiveDir: string, id: string): number {
  const shared = [...latestByName(readManifest(archiveDir)).values()].some(e => e.id === id && !isSwapped(e))
  const path = join(archiveDir, `${id}.zst`)
  if (shared || !existsSync(path)) return 0
  const bytes = statSync(path).size
  unlinkSync(path)
  return bytes
}

/**
 * One swap, in the order that survives a crash: the reduced entry is decoded and hashed again, the manifest line is appended (fsync), and only then is the whole file removed.
 * A crash between the last two leaves an orphan file next to a swapped entry; running the swap again removes it. A swapped entry is idempotent.
 */
export function swapOne(o: { archiveDir: string; item: SwapItem; now?: () => Date }): SwapOutcome {
  const { whole, reduced } = o.item
  const latest = latestByName(readManifest(o.archiveDir)).get(whole.name)
  if (!latest || latest.sha256 !== whole.sha256 || latest.size !== whole.size) return { ok: false, reason: 'the manifest no longer lists this name with these bytes' }
  if (isSwapped(latest)) return { ok: true, freedBytes: removeWholeFile(o.archiveDir, latest.id) }
  if (!stands(reduced, latest)) return { ok: false, reason: 'the reduced entry was not made from these bytes' }
  if (!existsSync(join(o.archiveDir, `${latest.id}.zst`))) return { ok: false, reason: 'the whole file is not on disk' }
  const v = verifyEntry(reducedDir(o.archiveDir), reduced)
  if (!v.ok) return { ok: false, reason: `the reduced entry does not verify: ${v.problems.join('; ')}` }
  appendManifest(o.archiveDir, { ...latest, reduced_id: reduced.id, whole_removed_at: (o.now?.() ?? new Date()).toISOString() })
  return { ok: true, freedBytes: removeWholeFile(o.archiveDir, latest.id) }
}
