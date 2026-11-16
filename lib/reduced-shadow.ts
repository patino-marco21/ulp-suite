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
  seed?: string
  /** True when the entry's archive file is on disk. */
  archiveHolds: (e: ManifestEntry) => boolean
}

/** The files to reduce in this run. `new` (and `any`): archived since the shadow began (any time for `any`), oldest first. `pilot`: older and not too big, in a seeded order that is the same every time. */
export function pickCandidates(o: PickOptions): ManifestEntry[] {
  const done = new Set<string>()
  for (const r of o.reduced) done.add(keyOf(r.name, r.of.sha256))
  const lastOk = new Map<string, boolean>()
  for (const l of o.log) lastOk.set(keyOf(l.name, l.sha256), l.ok)
  const maxBytes = o.maxBytes ?? PILOT_MAX_BYTES
  const eligible = o.entries.filter(e => {
    if (e.size === 0 || !o.inSources.has(e.name) || !o.archiveHolds(e)) return false
    if (done.has(keyOf(e.name, e.sha256))) return false
    if (!o.retryFailed && lastOk.get(keyOf(e.name, e.sha256)) === false) return false
    if (o.mode === 'any') return true
    return o.mode === 'new' ? e.created_at >= o.startedAt : e.created_at < o.startedAt && e.size <= maxBytes
  })
  const rank = (e: ManifestEntry) => createHash('sha1').update(`${o.seed ?? ''}:${e.name}`).digest('hex')
  eligible.sort(o.mode !== 'pilot'
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
  /** Reduced files with at least one stored row today's parser does not read from them, and the rows. */
  driftFiles: number
  driftKeys: number
}

export function summarize(o: { entries: ManifestEntry[]; reduced: ReducedEntry[]; log: ShadowLine[] }): Summary {
  const latestReduced = new Map<string, ReducedEntry>()
  for (const r of o.reduced) latestReduced.set(keyOf(r.name, r.of.sha256), r)
  let wholeBytes = 0, reducedBytes = 0, wholeArchiveBytes = 0, reducedArchiveBytes = 0, reducedFiles = 0, driftFiles = 0, driftKeys = 0
  for (const e of o.entries) {
    const r = latestReduced.get(keyOf(e.name, e.sha256))
    if (!r) continue
    reducedFiles++
    wholeBytes += e.size; reducedBytes += r.size
    wholeArchiveBytes += e.archive_bytes; reducedArchiveBytes += r.archive_bytes
    if ((r.db_drift ?? 0) > 0) { driftFiles++; driftKeys += r.db_drift }
  }
  const latest = new Map<string, ShadowLine>()
  for (const l of o.log) latest.set(keyOf(l.name, l.sha256), l)
  const failuresByReason: Record<string, number> = {}
  for (const l of latest.values()) if (!l.ok) failuresByReason[l.reason ?? 'unknown'] = (failuresByReason[l.reason ?? 'unknown'] ?? 0) + 1
  return {
    reducedFiles, wholeBytes, reducedBytes, sharePct: wholeBytes > 0 ? (100 * reducedBytes) / wholeBytes : 0,
    wholeArchiveBytes, reducedArchiveBytes, failuresByReason, driftFiles, driftKeys,
  }
}
