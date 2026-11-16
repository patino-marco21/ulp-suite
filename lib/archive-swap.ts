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
import { appendManifest, archiveSource, isSwapped, latestByName, readManifest, verifyEntry, type ManifestEntry, type Source } from '@/lib/source-archive'

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

export { isSwapped }

/** The reduced entry is made from exactly this whole entry (same bytes, by hash and by size). */
const stands = (r: ReducedEntry, w: ManifestEntry): boolean => r.of.sha256 === w.sha256 && r.of.size === w.size

/** The reduced entry a swapped entry points at; undefined when it does not exist or was made from other bytes. */
export function reducedFor(archiveDir: string, e: ManifestEntry, reduced: ReducedEntry[] = readReduced(archiveDir)): ReducedEntry | undefined {
  if (!e.reduced_id) return undefined
  for (let i = reduced.length - 1; i >= 0; i--) if (reduced[i].id === e.reduced_id && stands(reduced[i], e)) return reduced[i]
  return undefined
}

/** The reduced text of a swapped name (by name or by id) as a Source. Refuses a name that is not swapped: its whole entry is the one to read. */
export function openReducedSource(ref: string, archiveDir: string): Source {
  const entries = readManifest(archiveDir)
  const key = ref.slice(ref.lastIndexOf('/') + 1)
  const entry = latestByName(entries).get(key) ?? [...entries].reverse().find(e => e.id === key && isSwapped(e))
  if (!entry) throw new Error(`not in the archive manifest: ${key}`)
  if (!isSwapped(entry)) throw new Error(`${entry.name} is not swapped: its whole entry is the one to read`)
  const reduced = reducedFor(archiveDir, entry)
  if (!reduced) throw new Error(`${entry.name} is swapped but its reduced entry (${entry.reduced_id}) is missing or was made from other bytes`)
  return archiveSource(reducedDir(archiveDir), reduced)
}

/**
 * The stand-in gate's `holds`: the manifest entry that holds these bytes WHOLE. Bytes that only a reduced entry stands for give nothing, so a download of them stays a file
 * (a stand-in on a reduced entry would replace the owner's only local copy by zeros that nothing can restore). With nothing swapped it is the plain map by sha256 that
 * the callers used before: the last line of a sha wins.
 */
export function standInHolder(manifest: ManifestEntry[]): (sha256: string) => ManifestEntry | undefined {
  const bySha = new Map(manifest.map(e => [e.sha256, e]))
  return sha => {
    const e = bySha.get(sha)
    return e && !isSwapped(e) ? e : undefined
  }
}

/** A reduced entry by its id, as a Source: what an archive reference with `of` points at. */
export function openReducedEntry(id: string, archiveDir: string): Source {
  const entry = [...readReduced(archiveDir)].reverse().find(e => e.id === id)
  if (!entry) throw new Error(`not in the reduced archive manifest: ${id}`)
  return archiveSource(reducedDir(archiveDir), entry)
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

// ── the report and the batch run ─────────────────────────────────────────────────────────────────────

/** The owner's bar (2026-11-16): the report must show at least this much freed before the cut yes is asked for. */
export const FREED_BAR_BYTES = 100 * 1024 ** 3

export interface ReportCheck {
  id: 'exact' | 'freed' | 'restore'
  /** null = this report cannot know (the restore proof is shown by the end-to-end run). */
  ok: boolean | null
  text: string
}

export interface SwapReport {
  names: number
  swapped: number
  eligible: number
  left: Record<LeftReason, number>
  /** Bytes on disk the removal of the eligible whole files frees (a file shared with a name that stays counts once every sharer is eligible). */
  wholeBytesFreed: number
  /** Bytes on disk of the reduced entries that stand in for them (already on disk, so not a cost). */
  reducedBytesKept: number
  driftFiles: number
  driftKeys: number
  /** Ids of eligible reduced entries that do not decode to their manifest. */
  verifyFailed: string[]
  checks: ReportCheck[]
}

const gib = (n: number): string => (n / 1024 ** 3).toFixed(2)

export function swapReport(o: CandidateOptions & { archiveDir: string; barBytes?: number; verify?: boolean }): SwapReport {
  const { eligible, left } = swapCandidates(o)
  const eligibleNames = new Set(eligible.map(i => i.whole.name))
  const wholeIds = new Set(eligible.map(i => i.whole.id))
  let wholeBytesFreed = 0
  for (const id of wholeIds) {
    const users = [...o.wholes.values()].filter(e => e.id === id && !isSwapped(e))
    if (users.every(u => eligibleNames.has(u.name))) wholeBytesFreed += users[0].archive_bytes
  }
  const reducedById = new Map(eligible.map(i => [i.reduced.id, i.reduced]))
  const reducedBytesKept = [...reducedById.values()].reduce((n, r) => n + r.archive_bytes, 0)
  const verifyFailed: string[] = []
  if (o.verify !== false) for (const r of reducedById.values()) if (!verifyEntry(reducedDir(o.archiveDir), r).ok) verifyFailed.push(r.id)
  const drifting = eligible.filter(i => i.reduced.db_drift > 0)
  const bar = o.barBytes ?? FREED_BAR_BYTES
  const checks: ReportCheck[] = [
    {
      id: 'exact',
      ok: eligible.length > 0 && verifyFailed.length === 0,
      text: o.verify === false ? `${eligible.length} eligible entries, not decoded again (--no-verify)` : `${reducedById.size - verifyFailed.length} of ${reducedById.size} eligible reduced entries decode to their manifest`,
    },
    { id: 'freed', ok: wholeBytesFreed >= bar, text: `${gib(wholeBytesFreed)} GiB freed against the ${gib(bar)} GiB bar` },
    { id: 'restore', ok: null, text: 'shown by the end-to-end run of scripts/e2e-reduced-archive.ts (stage D scenario), not computed here' },
  ]
  return {
    names: o.wholes.size, swapped: [...o.wholes.values()].filter(isSwapped).length, eligible: eligible.length, left, wholeBytesFreed, reducedBytesKept,
    driftFiles: drifting.length, driftKeys: drifting.reduce((n, i) => n + i.reduced.db_drift, 0), verifyFailed, checks,
  }
}

/** The stand-ins in the registry (`path size mtime_ns sha256 created`, one per line) whose original the eligible entries would take out of the archive: they could no longer be restored from it. */
export function standInsLosingRestore(registryText: string, eligible: SwapItem[]): { count: number; bytes: number } {
  const swappedShas = new Set(eligible.map(i => i.whole.sha256))
  let count = 0
  let bytes = 0
  for (const line of registryText.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length >= 4 && swappedShas.has(f[3])) { count++; bytes += Number(f[1]) || 0 }
  }
  return { count, bytes }
}

export interface SwapRunOptions {
  archiveDir: string
  eligible: SwapItem[]
  apply: boolean
  /** The smallest files first; at most this many. */
  limit?: number
  /** File names to swap; the rest of the eligible stay. */
  only?: string[]
  /** Stop once this many bytes were freed. */
  batchBytes?: number
  now?: () => Date
}

export interface SwapRunResult {
  planned: number
  /** Bytes on disk of the whole files of the planned entries (before any sharing is taken into account). */
  plannedBytes: number
  swapped: number
  freedBytes: number
  /** Swapped entries that passed the check afterwards: swapped in the manifest, the reduced entry resolves and decodes, the whole file is gone unless a name that stays shares it. */
  checked: number
  problems: string[]
  /** The whole entry's id and the reason, when the run stopped on a failure. */
  failed?: { id: string; reason: string }
}

/** Swaps the picked entries one by one, smallest first, stopping at the first failure, and checks every swap it made. Without `apply` it only counts what it would do. */
export function runSwap(o: SwapRunOptions): SwapRunResult {
  let picked = o.eligible.filter(i => !o.only || o.only.includes(i.whole.name)).sort((a, b) => a.whole.size - b.whole.size || (a.whole.name < b.whole.name ? -1 : 1))
  if (o.limit !== undefined) picked = picked.slice(0, o.limit)
  const result: SwapRunResult = { planned: picked.length, plannedBytes: picked.reduce((n, i) => n + i.whole.archive_bytes, 0), swapped: 0, freedBytes: 0, checked: 0, problems: [] }
  if (!o.apply) return result
  const done: SwapItem[] = []
  for (const item of picked) {
    const out = swapOne({ archiveDir: o.archiveDir, item, now: o.now })
    if (!out.ok) { result.failed = { id: item.whole.id, reason: out.reason }; break }
    result.swapped++
    result.freedBytes += out.freedBytes
    done.push(item)
    if (o.batchBytes !== undefined && result.freedBytes >= o.batchBytes) break
  }
  const latest = latestByName(readManifest(o.archiveDir))
  for (const item of done) {
    const e = latest.get(item.whole.name)
    const stillShared = [...latest.values()].some(x => x.id === item.whole.id && !isSwapped(x))
    const r = e ? reducedFor(o.archiveDir, e) : undefined
    if (!e || !isSwapped(e)) result.problems.push(`${item.whole.id}: the manifest does not show the entry as swapped`)
    else if (!r) result.problems.push(`${item.whole.id}: the reduced entry does not resolve`)
    else if (!verifyEntry(reducedDir(o.archiveDir), r).ok) result.problems.push(`${item.whole.id}: the reduced entry does not decode`)
    else if (!stillShared && existsSync(join(o.archiveDir, `${item.whole.id}.zst`))) result.problems.push(`${item.whole.id}: the whole file is still on disk`)
    else result.checked++
  }
  return result
}
