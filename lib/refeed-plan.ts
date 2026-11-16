/**
 * Which archived files to read again after a parser change (docs/superpowers/specs/2026-11-07-file-ledger-design.md, "Re-feeding from the archive"). Pure: the script
 * reads the ledger copy, the archive manifest and the inbox folders and hands the facts over.
 *
 * A file the ledger holds with a hash, at a parser revision older than the current one, whose bytes the source archive holds, can be imported again through an
 * `.archiveref` (lib/archive-ref.ts): the importer decodes it from the archive, so no plaintext copy is made. The reference carries a name with "refeed" in it, which is
 * what lets the importer read bytes it already holds; the novelty check then stores only the credentials the table does not hold yet.
 */
import { ARCHIVE_REF_EXT } from '@/lib/archive-ref'
import { PARSER_REVISION } from '@/lib/parser-version'
import { refeedNameFor, type LedgerRow } from '@/lib/ledger-tools'
import { reducedFor } from '@/lib/archive-swap'
import type { ReducedEntry } from '@/lib/reduced-archive'
import { isSwapped, latestByName, type ManifestEntry } from '@/lib/source-archive'

export interface RefeedOptions {
  /** Only files whose newest ledger row is at this revision or newer / older (inclusive). */
  minRevision?: number
  maxRevision?: number
  /** The revision a re-feed would be read by; a file with a ledger row at this revision or newer is done. Default: the running parser's. */
  current?: number
  /** File-name substrings or sha256 prefixes; empty = all. */
  only?: string[]
  /** Every name in the inbox or one of its folders (a reference is `<name>.archiveref`). */
  inboxNames: Set<string>
  /** Stage D: the reduced manifest, for the names whose whole entry was swapped. */
  reduced?: ReducedEntry[]
}

export interface RefeedItem {
  /** The name the reference carries (the importer records the file by it). */
  refName: string
  /** The reference's file name in the inbox. */
  refFile: string
  originalName: string
  revision: number
  entry: ManifestEntry
  /** Stage D: the reduced entry the reference points at, when the whole entry was swapped. */
  reduced?: ReducedEntry
}

export type RefeedSkipReason = 'already-current' | 'out-of-range' | 'not-in-archive' | 'not-selected' | 'already-in-inbox' | 'name-too-long'

export interface RefeedPlan {
  items: RefeedItem[]
  /** How many files each rule left out. */
  skipped: Record<RefeedSkipReason, number>
}

/** The longest file name the importer's reference check accepts. */
const MAX_NAME = 255

export function planRefeeds(rows: LedgerRow[], manifest: ManifestEntry[], opts: RefeedOptions): RefeedPlan {
  const current = opts.current ?? PARSER_REVISION
  const only = (opts.only ?? []).map(s => s.toLowerCase()).filter(Boolean)
  const skipped: Record<RefeedSkipReason, number> = { 'already-current': 0, 'out-of-range': 0, 'not-in-archive': 0, 'not-selected': 0, 'already-in-inbox': 0, 'name-too-long': 0 }
  const entryBySha = new Map<string, ManifestEntry>()
  for (const e of manifest) if (!entryBySha.has(e.sha256)) entryBySha.set(e.sha256, e)
  // Stage D: bytes whose whole entry was swapped and that no name holds whole any more are read from the reduced entry. With nothing swapped this changes nothing.
  const heldWhole = new Set<string>()
  const swappedBySha = new Map<string, ManifestEntry>()
  for (const e of latestByName(manifest).values()) { if (isSwapped(e)) swappedBySha.set(e.sha256, e); else heldWhole.add(e.sha256) }
  for (const [shaHex, e] of swappedBySha) if (!heldWhole.has(shaHex)) entryBySha.set(shaHex, e)

  // One file = one hash. The newest row decides (a re-feed adds a row at the current revision under its own name).
  const bySha = new Map<string, LedgerRow[]>()
  for (const r of rows) {
    if (r.kind !== 'ledger' || !r.sha256) continue
    const list = bySha.get(r.sha256)
    if (list) list.push(r); else bySha.set(r.sha256, [r])
  }

  const items: RefeedItem[] = []
  for (const [sha, group] of bySha) {
    const newest = group.reduce((a, b) => (b.revision > a.revision || (b.revision === a.revision && b.when > a.when) ? b : a))
    if (newest.revision >= current) { skipped['already-current']++; continue }
    if (opts.minRevision !== undefined && newest.revision < opts.minRevision) { skipped['out-of-range']++; continue }
    if (opts.maxRevision !== undefined && newest.revision > opts.maxRevision) { skipped['out-of-range']++; continue }
    const entry = entryBySha.get(sha)
    if (!entry) { skipped['not-in-archive']++; continue }
    const reduced = isSwapped(entry) ? reducedFor('', entry, opts.reduced ?? []) : undefined
    if (isSwapped(entry) && !reduced) { skipped['not-in-archive']++; continue }
    if (only.length > 0 && !only.some(s => newest.filename.toLowerCase().includes(s) || sha.startsWith(s))) { skipped['not-selected']++; continue }
    const refName = refeedNameFor(newest.filename, current)
    const refFile = `${refName}${ARCHIVE_REF_EXT}`
    if (refName.length > MAX_NAME) { skipped['name-too-long']++; continue }
    if (opts.inboxNames.has(refFile) || opts.inboxNames.has(refName)) { skipped['already-in-inbox']++; continue }
    items.push({ refName, refFile, originalName: newest.filename, revision: newest.revision, entry, ...(reduced ? { reduced } : {}) })
  }
  // Small files first, like the pile feeder: the first result arrives soon, and a problem shows before a big file is spent on it.
  items.sort((a, b) => (a.reduced ?? a.entry).size - (b.reduced ?? b.entry).size || a.refName.localeCompare(b.refName))
  return { items, skipped }
}
