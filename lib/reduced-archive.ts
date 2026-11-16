/**
 * The reduced archive (docs/superpowers/plans/2026-11-15-reduced-archive.md). For an imported file it keeps a second archive entry that holds only the lines that added
 * something: the credentials the file was first to store, the credentials no row holds, and every rejected line nobody has explained. A line another file stored first, a
 * repeat inside the file, a blank separator and a tier-dropped line are proven to carry nothing and are left out. The entry is written beside the whole-file entry, in
 * `<archive>/reduced/` with a manifest of its own, so nothing that reads the whole-file entries can mistake one for the other.
 *
 * Nothing here prints a line of a file.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseIngestPolicy, policyActive, shouldDropAtIngest, type IngestDropPolicy } from '@/lib/ingest-filter'
import { preflightHardDrop } from '@/lib/ingest-preflight'
import { parseULPStream } from '@/lib/ulp-parser'
import {
  appendManifest, archiveFile, archiveSource, countNewlines, readManifest, verifyEntry, type ManifestEntry, type Source,
} from '@/lib/source-archive'

// ── byte ranges ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The union of byte ranges given as flat `[start0, end0, start1, end1, ...]` lists, as sorted, disjoint, non-touching flat pairs. Empty ranges are dropped. The parser's kept
 * ranges are nearly sorted (a block's range comes when the block closes), so a list that is already sorted skips the sort.
 */
export function normalizeRanges(parts: ArrayLike<number>[]): Float64Array {
  let total = 0
  for (const p of parts) total += p.length
  const flat = new Float64Array(total)
  let at = 0
  for (const p of parts) { for (let i = 0; i < p.length; i++) flat[at++] = p[i] }
  const n = total / 2
  let sorted = true
  for (let i = 1; i < n && sorted; i++) if (flat[2 * i] < flat[2 * i - 2]) sorted = false
  let order: Uint32Array | null = null
  if (!sorted) {
    order = Uint32Array.from({ length: n }, (_, i) => i)
    order.sort((a, b) => flat[2 * a] - flat[2 * b] || flat[2 * a + 1] - flat[2 * b + 1])
  }
  const out = new Float64Array(total)
  let m = 0
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k
    const s = flat[2 * i]
    const e = flat[2 * i + 1]
    if (e <= s) continue
    if (m > 0 && s <= out[m - 1]) { if (e > out[m - 1]) out[m - 1] = e }
    else { out[m++] = s; out[m++] = e }
  }
  return out.subarray(0, m)
}

/**
 * The lines to add to `ranges` (from normalizeRanges) because of rule B of the parser, which drops the repeats of an Android (login, password) pair per file. `repeats` are the
 * parser's androidRepeats lists (repeat start, repeat end, first start, first end). A repeat that lies inside `ranges` is copied; read alone it is no repeat, so the line of its
 * pair that came first must be copied with it. Returns those first lines as flat start/end pairs (not merged, not sorted).
 */
export function androidFirstsToKeep(ranges: Float64Array, repeats: ArrayLike<number>[]): number[] {
  const n = ranges.length / 2
  const out: number[] = []
  for (const q of repeats) {
    for (let i = 0; i + 3 < q.length; i += 4) {
      let lo = 0, hi = n - 1, at = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (ranges[2 * mid] <= q[i]) { at = mid; lo = mid + 1 } else hi = mid - 1
      }
      if (at >= 0 && q[i + 1] <= ranges[2 * at + 1]) out.push(q[i + 2], q[i + 3])
    }
  }
  return out
}

/**
 * Copies the bytes of `ranges` (from normalizeRanges) out of a stream, in order. A range that does not end in a newline (the last line of a file, or a long line the parser
 * read in pieces) is closed with one, so the range after it cannot glue onto it. A blank line goes between two ranges, because lines were left out there: the parser's
 * state (a url waiting for its login, a block) must end at the gap, as it ended in the original at the line that closed it, or the lines on both sides would read as one
 * record the original never had. Returns the bytes written and the newlines among them. A range that reaches past the end of the stream throws: a short copy would pass
 * for a reduced file.
 */
export async function copyRanges(
  chunks: AsyncIterable<Buffer | Uint8Array>,
  ranges: Float64Array,
  write: (bytes: Buffer) => void,
): Promise<{ bytes: number; lines: number }> {
  const NL = Buffer.from('\n')
  const count = ranges.length / 2
  let offset = 0
  let ri = 0
  let bytes = 0
  let lines = 0
  let lastByte = 10
  let wrote = false          // anything written yet
  let rangeStarted = false   // something of the current range written
  for await (const piece of chunks) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece.buffer, piece.byteOffset, piece.length)
    const chunkEnd = offset + chunk.length
    while (ri < count && ranges[2 * ri] < chunkEnd) {
      const from = Math.max(ranges[2 * ri], offset)
      const to = Math.min(ranges[2 * ri + 1], chunkEnd)
      if (to > from) {
        if (!rangeStarted) {
          if (wrote) { write(NL); bytes++; lines++ }
          rangeStarted = true
        }
        const part = chunk.subarray(from - offset, to - offset)
        write(part)
        bytes += part.length
        lines += countNewlines(part)
        lastByte = part[part.length - 1]
        wrote = true
      }
      if (ranges[2 * ri + 1] > chunkEnd) break   // the range goes on in the next chunk
      if (lastByte !== 10) { write(NL); bytes++; lines++; lastByte = 10 }
      rangeStarted = false
      ri++
    }
    offset = chunkEnd
    if (ri >= count) break
  }
  if (ri < count) throw new Error(`a kept range reaches past the end of the source (${ranges[2 * ri + 1]} > ${offset})`)
  return { bytes, lines }
}

// ── the entry and its manifest ──────────────────────────────────────────────────────────────────────

export const REDUCED_DIR = 'reduced'

/** A manifest entry of the reduced archive: the usual fields describe the reduced plaintext; the rest says what it was reduced from and what the proof found. */
export interface ReducedEntry extends ManifestEntry {
  /** The whole-file entry it was reduced from. */
  of: { sha256: string; size: number; lines: number }
  /** Distinct credentials kept: those the file stored plus those no row holds. */
  credentials: number
  /** Lines in the reduced plaintext. */
  kept_lines: number
  /** Kept credentials that no row holds. */
  absent: number
  /** Credentials the reduced entry produces that another file stored first: they sit inside a kept record. */
  extra_known: number
  /** Rows, and distinct normalised keys among them, that ulp.credentials held for the file when the entry was proven. */
  db_rows: number
  db_keys: number
  /** Of those keys, how many today's parser does not produce from the file (drift): their lines are kept or dropped by what today's parser makes of them. */
  db_drift: number
  /** ulp.sources.line_count when the entry was proven: the rows the import stored. */
  imported?: number
  verified_at: string
}

export const reducedDir = (archiveDir: string): string => join(archiveDir, REDUCED_DIR)

export function readReduced(archiveDir: string): ReducedEntry[] {
  return readManifest(reducedDir(archiveDir)) as ReducedEntry[]
}

export function appendReduced(archiveDir: string, entry: ReducedEntry): void {
  mkdirSync(reducedDir(archiveDir), { recursive: true })
  appendManifest(reducedDir(archiveDir), entry)
}

// ── the database side ───────────────────────────────────────────────────────────────────────────────

/** One parsed credential on its way to a scratch table: its place in the file (zero when the file is the reduced entry) and its three fields. */
export interface LoadRow { seq: number; s: number; e: number; url: string; email: string; password: string }

export interface ClassifyResult {
  /** Flat start/end byte offsets of the credentials to keep: the first occurrence of each key that this file stored or that no row holds. */
  keep: Float64Array
  /** Distinct normalised keys in the original parse, and how many of them this file stored, no row holds, or only other files hold. */
  distinct: number
  mine: number
  absent: number
  known: number
}

export interface ProofCounts {
  /** What ulp.credentials holds under the file's name. */
  dbRows: number
  dbKeys: number
  /**
   * Keys the database holds for the file that today's parser does not produce from it (an older parser version stored them; 0.15 to 0.22% of the rows in the first real
   * files tried). Re-importing the whole file would not make them either, so they are reported as drift and are not a loss.
   */
  notParsed: number
  /** Keys the file stored that today's parser produces from it and that the reduced entry does not: the loss a reduction can cause. Must be 0. */
  missing: number
  /** Keys the reduced entry produces that the original does not: must be 0. */
  spurious: number
  /** Keys the reduced entry produces that only other files hold: they came along inside a kept record. */
  extraKnown: number
  reducedKeys: number
}

/**
 * The questions the writer asks the database, one instance for one file (it owns that file's scratch tables). The ClickHouse implementation is lib/reduced-archive-ch.ts;
 * the unit tests use a map.
 */
export interface ReduceDb {
  /** Stores the parsed credentials of the original file; resolves with their number. */
  loadOriginal(rows: AsyncIterable<LoadRow[]>): Promise<number>
  /** Says which of the loaded credentials to keep, for the file called `name`. */
  classify(name: string): Promise<ClassifyResult>
  /** Stores the parsed credentials of the reduced entry and compares their keys with what the database holds for `name` and with the original. */
  prove(name: string, rows: AsyncIterable<LoadRow[]>): Promise<ProofCounts>
  /** Drops the scratch tables. Always called, and must not throw when there is nothing to drop. */
  cleanup(): Promise<void>
}

// ── the writer ──────────────────────────────────────────────────────────────────────────────────────

export interface ReduceOptions {
  /** The whole-file entry to reduce; its plaintext is read from the archive, whether or not the original is still on disk. */
  entry: ManifestEntry
  archiveDir: string
  db: ReduceDb
  /** Where the reduced plaintext is built before it is archived. */
  workDir: string
  env?: NodeJS.Dict<string>
  /** The importer's hard drop (tier T3 with its keep-list of countries) by default; a test seam. */
  hardDrop?: (email: string, url: string) => boolean
  now?: () => Date
  /** What ulp.sources says the import of this file stored (its line_count); 0 or absent when unknown. */
  imported?: number
  /** Test seams: smaller frames for the reduced entry. */
  frameBytes?: number
  searchBytes?: number
}

export interface ReduceStats {
  /** Credentials the parser produced (after the ingest policy), distinct keys among them, and the split of those. */
  parsed: number
  distinct: number
  mine: number
  absent: number
  known: number
  /** In-file repeats: parsed minus distinct. */
  repeats: number
  keptBytes: number
  keptLines: number
  proof?: ProofCounts
}

export type ReduceOutcome =
  | { ok: true; entry: ReducedEntry; stats: ReduceStats }
  | { ok: false; reason: 'mismatch' | 'source' | 'long_line' | 'error'; detail: string; stats?: ReduceStats }

function writeAll(fd: number, buf: Buffer): void {
  let done = 0
  while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done)
}

/** A Node stream's bytes as a web stream, hashed and counted on the way. */
function hashedWebStream(source: Source): { stream: ReadableStream<Uint8Array>; result: () => { sha256: string; bytes: number } } {
  const hash = createHash('sha256')
  let bytes = 0
  async function* tee(): AsyncGenerator<Buffer> {
    for await (const c of source.stream()) {
      const b = Buffer.from(c)
      hash.update(b)
      bytes += b.length
      yield b
    }
  }
  return {
    stream: Readable.toWeb(Readable.from(tee(), { objectMode: false })) as ReadableStream<Uint8Array>,
    result: () => ({ sha256: hash.digest('hex'), bytes }),
  }
}

interface ParseContext {
  name: string
  hard: ((email: string, url: string) => boolean) | undefined
  soft: IngestDropPolicy
  filterOn: boolean
  track: boolean
  /** The rejected units the parser says to keep, as flat start/end pairs; filled while the rows are read. */
  kept: number[]
  /** Rule B repeats the parser reports (ParseStreamOptions.trackSpans), one list per batch. */
  repeats: Float64Array[]
  /** Lines over the parser's length limit, or pieces of one (StreamBatch.overlongLines). */
  longLines: { n: number }
  parsed: { n: number }
}

/** The credentials of a stream as the importer would stage them: its parser and its soft ingest policy. */
async function* credentialRows(stream: ReadableStream<Uint8Array>, ctx: ParseContext): AsyncGenerator<LoadRow[]> {
  let seq = 0
  for await (const batch of parseULPStream(stream, ctx.name, 100_000, ctx.hard, { dedupInFile: false, trackSpans: ctx.track })) {
    const rows: LoadRow[] = []
    for (let i = 0; i < batch.credentials.length; i++) {
      const c = batch.credentials[i]
      if (ctx.filterOn && shouldDropAtIngest(c.email, c.url, c.domain, ctx.soft)) continue
      rows.push({ seq: seq++, s: ctx.track ? batch.spans![2 * i] : 0, e: ctx.track ? batch.spans![2 * i + 1] : 0, url: c.url, email: c.email, password: c.password })
    }
    if (ctx.track && batch.kept) for (let i = 0; i < batch.kept.length; i++) ctx.kept.push(batch.kept[i])
    if (ctx.track && batch.androidRepeats) ctx.repeats.push(Float64Array.from(batch.androidRepeats))
    if (ctx.track && batch.overlongLines) ctx.longLines.n += batch.overlongLines
    ctx.parsed.n += rows.length
    if (rows.length > 0) yield rows
  }
}

/**
 * Writes the reduced entry of one archived file and proves it.
 *
 * 1. The original is parsed with span tracking by the importer's own parser and policy; every credential goes to the database side (loadOriginal).
 * 2. The database side says which credentials this file was first to store, or nobody holds (classify). Their byte ranges, plus the rejected units the parser kept, are
 *    copied out of a second read of the archive into a plain file in workDir.
 * 3. That file is parsed the same way and compared with what the database holds for the file (prove): nothing the file stored may be missing, and nothing may appear that
 *    the original did not produce. Only then is it archived, verified again, and added to the reduced manifest. A failed proof writes nothing.
 */
export async function reduceSource(opts: ReduceOptions): Promise<ReduceOutcome> {
  const { entry, archiveDir, db } = opts
  const env = opts.env ?? process.env
  const hard = opts.hardDrop ?? preflightHardDrop(env)
  const soft: IngestDropPolicy = { ...parseIngestPolicy(env), hardTiers: new Set<string>() }
  const filterOn = policyActive(soft)
  const rdir = reducedDir(archiveDir)
  const plainPath = join(opts.workDir, `${randomBytes(6).toString('hex')}.reduced`)
  const stats: ReduceStats = { parsed: 0, distinct: 0, mine: 0, absent: 0, known: 0, repeats: 0, keptBytes: 0, keptLines: 0 }
  let archivedId: string | null = null
  try {
    const source = archiveSource(archiveDir, entry)

    // 1. parse the original
    const kept: number[] = []
    const repeats: Float64Array[] = []
    const parsed = { n: 0 }
    const longLines = { n: 0 }
    const tee = hashedWebStream(source)
    await db.loadOriginal(credentialRows(tee.stream, { name: entry.name, hard, soft, filterOn, track: true, kept, repeats, longLines, parsed }))
    const read = tee.result()
    if (read.bytes !== entry.size || read.sha256 !== entry.sha256) {
      return { ok: false, reason: 'source', detail: 'the archive entry does not hash to its manifest line; nothing was reduced' }
    }
    stats.parsed = parsed.n
    // The parser cuts a line over 1 MiB where its buffer happens to stand, or reads it whole when its end arrives first, so what it makes of such a line changes with the chunking of
    // the bytes: the rows the import stored for it are not reproducible from the file by any reader, the reduced entry's included. The file keeps its whole-file entry as the only copy.
    if (longLines.n > 0) {
      return {
        ok: false, reason: 'long_line', stats,
        detail: `the file has ${longLines.n} line(s) longer than 1 MiB, which the parser reads in pieces that depend on how the bytes are chunked; no reduced entry can reproduce them`,
      }
    }

    // 2. classify and copy
    const cls = await db.classify(entry.name)
    Object.assign(stats, { distinct: cls.distinct, mine: cls.mine, absent: cls.absent, known: cls.known, repeats: stats.parsed - cls.distinct })
    let ranges = normalizeRanges([kept, cls.keep])
    // A rule B repeat that is copied needs the first line of its pair beside it (see androidFirstsToKeep).
    const firsts = androidFirstsToKeep(ranges, repeats)
    if (firsts.length > 0) ranges = normalizeRanges([ranges, firsts])
    mkdirSync(opts.workDir, { recursive: true })
    const fd = openSync(plainPath, 'wx')
    let copied: { bytes: number; lines: number }
    try {
      copied = await copyRanges(source.stream(), ranges, b => writeAll(fd, b))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    stats.keptBytes = copied.bytes
    stats.keptLines = copied.lines

    // 3. prove
    const proofRows = credentialRows(
      Readable.toWeb(createReadStream(plainPath, { highWaterMark: 1 << 20 })) as ReadableStream<Uint8Array>,
      { name: entry.name, hard, soft, filterOn, track: false, kept: [], repeats: [], longLines: { n: 0 }, parsed: { n: 0 } },
    )
    const proof = await db.prove(entry.name, proofRows)
    stats.proof = proof
    if (proof.missing !== 0 || proof.spurious !== 0) {
      return {
        ok: false, reason: 'mismatch', stats,
        detail: `${proof.missing} of ${proof.dbKeys} stored keys would be lost, ${proof.spurious} keys appear that the original does not produce`,
      }
    }

    // The import says it stored rows and the database holds none under the name: they are under another name (a re-feed), every credential here looks "known", and no entry
    // would keep the lines. Not a file to reduce.
    if ((opts.imported ?? 0) > 0 && proof.dbRows === 0) {
      return { ok: false, reason: 'mismatch', stats, detail: `ulp.sources says the import stored ${opts.imported} rows, and ulp.credentials holds none under the file's name` }
    }

    // 4. archive, verify, record
    mkdirSync(rdir, { recursive: true })
    const known = readReduced(archiveDir)
    const base = archiveFile(plainPath, {
      archiveDir: rdir, name: entry.name, frameBytes: opts.frameBytes, searchBytes: opts.searchBytes, now: opts.now,
      lookupById: id => [...known].reverse().find(e => e.id === id),
    })
    if (!known.some(e => e.id === base.id)) archivedId = base.id
    const v = verifyEntry(rdir, base)
    if (!v.ok) return { ok: false, reason: 'error', stats, detail: `the reduced archive file failed its own check: ${v.problems.join('; ')}` }
    const reduced: ReducedEntry = {
      ...base,
      of: { sha256: entry.sha256, size: entry.size, lines: entry.lines },
      credentials: cls.mine + cls.absent,
      kept_lines: copied.lines,
      absent: cls.absent,
      extra_known: proof.extraKnown,
      db_rows: proof.dbRows,
      db_keys: proof.dbKeys,
      db_drift: proof.notParsed,
      ...(opts.imported !== undefined ? { imported: opts.imported } : {}),
      verified_at: (opts.now?.() ?? new Date()).toISOString(),
    }
    appendReduced(archiveDir, reduced)
    archivedId = null
    return { ok: true, entry: reduced, stats }
  } catch (err) {
    return { ok: false, reason: 'error', stats, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    // A file that was archived but not recorded (the proof passed, a later step failed) must not stay behind as an orphan.
    if (archivedId) rmSync(join(rdir, `${archivedId}.zst`), { force: true })
    rmSync(plainPath, { force: true })
    try { await db.cleanup() } catch (err) { console.warn(`[reduced-archive] could not drop the scratch tables of a file: ${err instanceof Error ? err.message : String(err)}`) }
  }
}
