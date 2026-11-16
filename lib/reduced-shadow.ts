/**
 * The shadow run of the reduced archive (docs/superpowers/plans/2026-11-15-reduced-archive.md, stage B): which archived files get a reduced entry, the log of every
 * result, and the gate. Shadow means the reduced entry is written beside the whole-file one and nothing is removed, replaced or switched on its account; the gate is how many
 * files in a row came out exact before the owner is asked to go further. Plain values in, answers out; the only file access is the log and the start marker.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import type { ManifestEntry } from '@/lib/source-archive'

/** Files in a row whose reduced entry proved exact before stage C is proposed. */
export const GATE_FILES = 200
/** A pilot entry is no bigger than this (plaintext): the pilot is about correctness on old files, not about the biggest ones. */
export const PILOT_MAX_BYTES = 2 * 1024 ** 3

const LOG_FILE = 'shadow-log.jsonl'
const START_FILE = 'shadow.json'

/** The reason of a file left whole on purpose (it holds a line over 1 MiB); not a failure of the writer, so neither the gate nor the failure counts take it. */
export const SKIP_REASON = 'long_line'

export interface ShadowLine {
  name: string
  /** The sha256 of the whole-file entry that was reduced: a name with other bytes is another file. */
  sha256: string
  at: string
  /** `new` for a file archived since the shadow began, `pilot` for an older one picked to test the writer on. Only `new` counts for the gate. */
  kind: 'new' | 'pilot'
  ok: boolean
  reason?: string
  detail?: string
  ms?: number
  /** The reduced entry's plaintext as a share of the whole file's, in percent. */
  keptPct?: number
  parsed?: number
  mine?: number
  known?: number
  absent?: number
  extra_known?: number
  /** Stored rows today's parser does not read from the file (ReducedEntry.db_drift). A new file with drift is not counted as exact. */
  drift?: number
  /** Placeholder lines in the reduced entry (ReducedEntry.placeholders); `fallback` when the compacted copy failed its proof and the spans were kept whole. */
  placeholders?: number
  fallback?: boolean
}

const keyOf = (name: string, sha: string) => `${name}\0${sha}`

export function readShadowLog(archiveDir: string): ShadowLine[] {
  const path = join(reducedDir(archiveDir), LOG_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as ShadowLine)
}

export function appendShadowLog(archiveDir: string, line: ShadowLine): void {
  mkdirSync(reducedDir(archiveDir), { recursive: true })
  appendFileSync(join(reducedDir(archiveDir), LOG_FILE), JSON.stringify(line) + '\n')
}

/** When the shadow began (ISO): written the first time it is asked for, and kept. Files archived after it are "new"; older ones are the pilot's. */
export function readShadowStart(archiveDir: string, now: () => Date = () => new Date()): string {
  const path = join(reducedDir(archiveDir), START_FILE)
  if (existsSync(path)) return (JSON.parse(readFileSync(path, 'utf8')) as { started_at: string }).started_at
  mkdirSync(reducedDir(archiveDir), { recursive: true })
  const started_at = now().toISOString()
  writeFileSync(path, JSON.stringify({ started_at }) + '\n')
  return started_at
}

export interface PickOptions {
  /** The latest whole-file entry of each name. */
  entries: ManifestEntry[]
  /** The reduced manifest (every line; a later one for a name supersedes an earlier). */
  reduced: ReducedEntry[]
  log: ShadowLine[]
  /** The names in ulp.sources: a file that is not imported has no rows to prove against. */
  inSources: Set<string>
  startedAt: string
  /** `any`: the files named on the command line, whatever their age or size. */
  mode: 'new' | 'pilot' | 'any'
  limit: number
  /** Try again the files whose last attempt failed. */
  retryFailed?: boolean
  /** Pilot only. */
  maxBytes?: number
  /**
   * Make a reduced entry again: when set, only the files whose reduced entry (any line of the manifest for the bytes) satisfies it are picked, the biggest entry first, and a file
   * whose manifest holds a line that does not satisfy it is done. Whatever the mode says about age and size is ignored.
   */
  redo?: (r: ReducedEntry) => boolean
  seed?: string
  /** True when the entry's archive file is on disk. */
  archiveHolds: (e: ManifestEntry) => boolean
}

/** The files to reduce in this run. `new` (and `any`): archived since the shadow began (any time for `any`), oldest first. `pilot`: older and not too big, in a seeded order that is the same every time. */
export function pickCandidates(o: PickOptions): ManifestEntry[] {
  const done = new Set<string>()
  const redoSize = new Map<string, number>()   // redo: the size of the entry that is to be made again
  for (const r of o.reduced) {
    const k = keyOf(r.name, r.of.sha256)
    if (o.redo && o.redo(r)) redoSize.set(k, Math.max(redoSize.get(k) ?? 0, r.size))
    else done.add(k)
  }
  const lastOk = new Map<string, boolean>()
  const skipped = new Set<string>()   // reduced entries are not made for these bytes: they hold a line the parser reads differently from reader to reader
  for (const l of o.log) {
    lastOk.set(keyOf(l.name, l.sha256), l.ok)
    if (!l.ok && l.reason === SKIP_REASON) skipped.add(keyOf(l.name, l.sha256))
  }
  const maxBytes = o.maxBytes ?? PILOT_MAX_BYTES
  const eligible = o.entries.filter(e => {
    if (e.size === 0 || !o.inSources.has(e.name) || !o.archiveHolds(e)) return false
    if (done.has(keyOf(e.name, e.sha256)) || skipped.has(keyOf(e.name, e.sha256))) return false
    if (!o.retryFailed && lastOk.get(keyOf(e.name, e.sha256)) === false) return false
    if (o.redo) return redoSize.has(keyOf(e.name, e.sha256))
    if (o.mode === 'any') return true
    return o.mode === 'new' ? e.created_at >= o.startedAt : e.created_at < o.startedAt && e.size <= maxBytes
  })
  const rank = (e: ManifestEntry) => createHash('sha1').update(`${o.seed ?? ''}:${e.name}`).digest('hex')
  if (o.redo) eligible.sort((a, b) => (redoSize.get(keyOf(b.name, b.sha256)) ?? 0) - (redoSize.get(keyOf(a.name, a.sha256)) ?? 0) || (a.name < b.name ? -1 : 1))
  else eligible.sort(o.mode !== 'pilot'
    ? (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.name < b.name ? -1 : 1)
    : (a, b) => (rank(a) < rank(b) ? -1 : 1))
  return eligible.slice(0, o.limit)
}

/** Exact results in a row from the newest, over files of kind `new`; a file tried again counts once, by its latest result. The first failure ends the count. */
export function consecutiveExact(log: ShadowLine[]): number {
  const seen = new Set<string>()
  let n = 0
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]
    if (l.kind !== 'new') continue
    const k = keyOf(l.name, l.sha256)
    if (seen.has(k)) continue
    seen.add(k)
    if (!l.ok && l.reason === SKIP_REASON) continue
    if (!l.ok || (l.drift ?? 0) > 0) break
    n++
  }
  return n
}

export interface Summary {
  reducedFiles: number
  wholeBytes: number
  reducedBytes: number
  /** reduced / whole, plaintext, in percent; 0 when nothing is reduced. */
  sharePct: number
  wholeArchiveBytes: number
  reducedArchiveBytes: number
  failuresByReason: Record<string, number>
  /** Files left whole on purpose (SKIP_REASON), by their latest result. */
  skippedLongLine: number
  /** Reduced files with at least one stored row today's parser does not read from them, and the rows. */
  driftFiles: number
  driftKeys: number
  /** Reduced files whose entry carries placeholder lines, and how many lines; files whose latest result says the compacted copy fell back to whole spans. */
  compactedFiles: number
  placeholders: number
  compactFallbacks: number
}

export function summarize(o: { entries: ManifestEntry[]; reduced: ReducedEntry[]; log: ShadowLine[] }): Summary {
  const latestReduced = new Map<string, ReducedEntry>()
  for (const r of o.reduced) latestReduced.set(keyOf(r.name, r.of.sha256), r)
  let wholeBytes = 0, reducedBytes = 0, wholeArchiveBytes = 0, reducedArchiveBytes = 0, reducedFiles = 0, driftFiles = 0, driftKeys = 0, compactedFiles = 0, placeholders = 0
  for (const e of o.entries) {
    const r = latestReduced.get(keyOf(e.name, e.sha256))
    if (!r) continue
    reducedFiles++
    wholeBytes += e.size; reducedBytes += r.size
    wholeArchiveBytes += e.archive_bytes; reducedArchiveBytes += r.archive_bytes
    if ((r.db_drift ?? 0) > 0) { driftFiles++; driftKeys += r.db_drift }
    if ((r.placeholders ?? 0) > 0) { compactedFiles++; placeholders += r.placeholders! }
  }
  const latest = new Map<string, ShadowLine>()
  for (const l of o.log) latest.set(keyOf(l.name, l.sha256), l)
  const failuresByReason: Record<string, number> = {}
  let skippedLongLine = 0
  let compactFallbacks = 0
  for (const l of latest.values()) {
    if (l.ok && l.fallback) compactFallbacks++
    if (l.ok) continue
    if (l.reason === SKIP_REASON) skippedLongLine++
    else failuresByReason[l.reason ?? 'unknown'] = (failuresByReason[l.reason ?? 'unknown'] ?? 0) + 1
  }
  return {
    reducedFiles, wholeBytes, reducedBytes, sharePct: wholeBytes > 0 ? (100 * reducedBytes) / wholeBytes : 0,
    wholeArchiveBytes, reducedArchiveBytes, failuresByReason, skippedLongLine, driftFiles, driftKeys, compactedFiles, placeholders, compactFallbacks,
  }
}
