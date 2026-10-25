/**
 * The source archive (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md).
 *
 * A source file is kept as concatenated zstd frames of at most FRAME_BYTES of plaintext each, every frame cut at a newline, in `<archive dir>/<id>.zst`, where `id`
 * is the first ID_LENGTH hex characters of the sha256 of the plaintext (content addressed: two names with identical bytes share one archive). `manifest.jsonl` in the
 * same directory has one line per archived name with the frame table, which lets a reader decode one frame at a time: bounded memory for a stream, random access for
 * the sampling tools. `zstd -dc <id>.zst` returns the original file.
 *
 * Nothing here prints anything. The functions are synchronous on purpose: the CLI runs them in worker processes.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, createReadStream, existsSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { constants as Z, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const FRAME_BYTES = 64 * 1024 * 1024
/** A frame is cut at the last newline within this many bytes of its end; with none there, at FRAME_BYTES. */
export const FRAME_SEARCH_BYTES = 1024 * 1024
export const ZSTD_LEVEL = 12
export const ZSTD_WINDOW_LOG = 27
export const ID_LENGTH = 24
export const MANIFEST_FILE = 'manifest.jsonl'

/** [plain offset, plain length, compressed offset, compressed length] of one frame. */
export type FrameRow = [number, number, number, number]

export interface ManifestEntry {
  name: string
  id: string
  size: number
  sha256: string
  /** Physical lines: the newline bytes, plus one when the last line has none. */
  lines: number
  frames: FrameRow[]
  archive_bytes: number
  archive_sha256: string
  level: number
  created_at: string
  replaced_at?: string
}

export function defaultArchiveDir(env: NodeJS.Dict<string> = process.env): string {
  const set = env.ULP_ARCHIVE_DIR?.trim()
  return set ? set : join(homedir(), 'ulp-archive')
}

// ── small fs helpers ────────────────────────────────────────────────────────────────────────────────

function writeAll(fd: number, buf: Buffer): void {
  let done = 0
  while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done)
}

function readExact(fd: number, buf: Buffer, position: number): void {
  let done = 0
  while (done < buf.length) {
    const n = readSync(fd, buf, done, buf.length - done, position + done)
    if (n === 0) throw new Error(`unexpected end of file at byte ${position + done}`)
    done += n
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function countNewlines(buf: Buffer): number {
  let n = 0
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++
  return n
}

// ── frames ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The plaintext of a file as frames of at most `frameBytes`, each cut after the last newline within `searchBytes` of its end (at `frameBytes` when there is none).
 * Every yielded Buffer is its own allocation, so a consumer may keep it.
 */
export function* readFrames(path: string, frameBytes = FRAME_BYTES, searchBytes = FRAME_SEARCH_BYTES): Generator<Buffer> {
  const fd = openSync(path, 'r')
  try {
    let carry: Buffer = Buffer.alloc(0)
    for (;;) {
      const buf = Buffer.allocUnsafe(frameBytes)
      carry.copy(buf, 0)
      let filled = carry.length
      while (filled < frameBytes) {
        const n = readSync(fd, buf, filled, frameBytes - filled, null)
        if (n === 0) break
        filled += n
      }
      if (filled === 0) return
      if (filled < frameBytes) { yield buf.subarray(0, filled); return }
      const nl = buf.lastIndexOf(10, filled - 1)
      const cut = nl >= filled - searchBytes ? nl + 1 : filled
      yield buf.subarray(0, cut)
      carry = Buffer.from(buf.subarray(cut, filled))
    }
  } finally {
    closeSync(fd)
  }
}

export function compressFrame(plain: Buffer, level = ZSTD_LEVEL): Buffer {
  return zstdCompressSync(plain, {
    params: {
      [Z.ZSTD_c_compressionLevel]: level,
      [Z.ZSTD_c_windowLog]: ZSTD_WINDOW_LOG,
      [Z.ZSTD_c_enableLongDistanceMatching]: 1,
      [Z.ZSTD_c_checksumFlag]: 1,
    },
  })
}

export function decompressFrame(comp: Buffer): Buffer {
  return zstdDecompressSync(comp)
}

// ── the manifest ────────────────────────────────────────────────────────────────────────────────────

export function readManifest(archiveDir: string): ManifestEntry[] {
  const path = join(archiveDir, MANIFEST_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, i) => {
      try { return JSON.parse(line) as ManifestEntry } catch { throw new Error(`${MANIFEST_FILE} line ${i + 1} is not valid JSON`) }
    })
}

/** The latest line of each name (a later line, for example one with `replaced_at`, supersedes an earlier one). */
export function latestByName(entries: ManifestEntry[]): Map<string, ManifestEntry> {
  const latest = new Map<string, ManifestEntry>()
  for (const e of entries) latest.set(e.name, e)
  return latest
}

export function appendManifest(archiveDir: string, entry: ManifestEntry): void {
  const fd = openSync(join(archiveDir, MANIFEST_FILE), 'a')
  try {
    writeAll(fd, Buffer.from(JSON.stringify(entry) + '\n'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Removes `*.part` files older than `maxAgeMs` (the leftovers of a killed run: a live worker never keeps one that long). Returns the names removed. */
export function removeStaleParts(archiveDir: string, maxAgeMs = 3_600_000, nowMs = Date.now()): string[] {
  const removed: string[] = []
  for (const name of readdirSync(archiveDir)) {
    if (!name.endsWith('.part')) continue
    const path = join(archiveDir, name)
    try {
      if (nowMs - statSync(path).mtimeMs > maxAgeMs) { rmSync(path, { force: true }); removed.push(name) }
    } catch {
      /* gone meanwhile */
    }
  }
  return removed
}

// ── archive one file ────────────────────────────────────────────────────────────────────────────────

export interface ArchiveOptions {
  archiveDir: string
  /** The name recorded in the manifest. Default: the base name of the source. */
  name?: string
  level?: number
  /** Test seams: smaller frames. */
  frameBytes?: number
  searchBytes?: number
  /** The manifest entry that already holds this content id, if any. Then the archive file on disk is kept and shared. */
  lookupById?: (id: string) => ManifestEntry | undefined
  now?: () => Date
}

/**
 * Reads `srcPath` once, writes `<id>.zst` into the archive directory (through a `.part` file that is flushed and renamed) and returns the manifest entry.
 * Nothing is appended to the manifest here: the caller does that after verifyEntry. The directory must already exist.
 */
export function archiveFile(srcPath: string, opts: ArchiveOptions): ManifestEntry {
  const dir = opts.archiveDir
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`the archive directory does not exist: ${dir} (create it yourself; the tool never creates it)`)
  }
  const level = opts.level ?? ZSTD_LEVEL
  const name = opts.name ?? basename(srcPath)
  const part = join(dir, `${randomBytes(8).toString('hex')}.part`)
  const out = openSync(part, 'wx')
  const plainHash = createHash('sha256')
  const compHash = createHash('sha256')
  const frames: FrameRow[] = []
  let plainOffset = 0
  let compOffset = 0
  let lines = 0
  let lastByte = -1
  try {
    for (const plain of readFrames(srcPath, opts.frameBytes, opts.searchBytes)) {
      plainHash.update(plain)
      lines += countNewlines(plain)
      lastByte = plain[plain.length - 1]
      const comp = compressFrame(plain, level)
      compHash.update(comp)
      writeAll(out, comp)
      frames.push([plainOffset, plain.length, compOffset, comp.length])
      plainOffset += plain.length
      compOffset += comp.length
    }
    fsyncSync(out)
  } catch (err) {
    closeSync(out)
    rmSync(part, { force: true })
    throw err
  }
  closeSync(out)
  if (plainOffset > 0 && lastByte !== 10) lines += 1

  const sha256 = plainHash.digest('hex')
  const id = sha256.slice(0, ID_LENGTH)
  const created_at = (opts.now?.() ?? new Date()).toISOString()
  const final = join(dir, `${id}.zst`)
  const existing = opts.lookupById?.(id)
  if (existing && existsSync(final)) {
    rmSync(part, { force: true })
    return { ...existing, name, created_at, replaced_at: undefined }
  }
  renameSync(part, final)
  syncDir(dir)
  return { name, id, size: plainOffset, sha256, lines, frames, archive_bytes: compOffset, archive_sha256: compHash.digest('hex'), level, created_at }
}

// ── verify ──────────────────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  problems: string[]
}

/** Decodes every frame again, re-hashes, and compares everything the manifest says: sizes, line count, both sha256 values, the frame table. */
export function verifyEntry(archiveDir: string, entry: ManifestEntry): VerifyResult {
  const path = join(archiveDir, `${entry.id}.zst`)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { ok: false, problems: [`archive file missing: ${entry.id}.zst`] }
  }
  const problems: string[] = []
  try {
    const onDisk = statSync(path).size
    if (onDisk !== entry.archive_bytes) problems.push(`archive size is ${onDisk}, the manifest says ${entry.archive_bytes}`)
    const plainHash = createHash('sha256')
    const compHash = createHash('sha256')
    let plainLen = 0
    let lines = 0
    let lastByte = -1
    for (const [po, pl, co, cl] of entry.frames) {
      const comp = Buffer.allocUnsafe(cl)
      try { readExact(fd, comp, co) } catch (e) { problems.push(`frame at ${co} cannot be read: ${(e as Error).message}`); break }
      compHash.update(comp)
      let plain: Buffer
      try { plain = decompressFrame(comp) } catch (e) { problems.push(`frame at ${co} does not decode: ${(e as Error).message}`); break }
      if (po !== plainLen || plain.length !== pl) problems.push(`frame at ${co}: plaintext offset or length differs from the manifest`)
      plainHash.update(plain)
      plainLen += plain.length
      lines += countNewlines(plain)
      if (plain.length > 0) lastByte = plain[plain.length - 1]
    }
    if (plainLen > 0 && lastByte !== 10) lines += 1
    if (plainLen !== entry.size) problems.push(`plaintext is ${plainLen} bytes, the manifest says ${entry.size}`)
    if (lines !== entry.lines) problems.push(`plaintext has ${lines} lines, the manifest says ${entry.lines}`)
    if (plainHash.digest('hex') !== entry.sha256) problems.push('the plaintext sha256 differs from the manifest')
    if (compHash.digest('hex') !== entry.archive_sha256) problems.push('the archive sha256 differs from the manifest')
  } finally {
    closeSync(fd)
  }
  return { ok: problems.length === 0, problems }
}

// ── read a source: a plain file or an archive ───────────────────────────────────────────────────────

export interface Source {
  name: string
  size: number
  origin: { kind: 'file'; path: string } | { kind: 'archive'; id: string }
  /** Set for an archive origin. */
  entry?: ManifestEntry
  /** The plaintext as a stream of Buffers. */
  stream(): Readable
  /** Up to `length` bytes of plaintext from `offset` (fewer at the end of the file, none past it). */
  readSlice(offset: number, length: number): Promise<Buffer>
  readAll(): Promise<Buffer>
}

/** A plain file as a Source: no manifest lookup, so a path that is not a file throws instead of being read as the name of an archived file (openSource does that). */
export function fileSource(path: string): Source {
  const size = statSync(path).size
  return {
    name: basename(path),
    size,
    origin: { kind: 'file', path },
    stream: () => createReadStream(path, { highWaterMark: 1 << 20 }),
    async readSlice(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset))
      const buf = Buffer.allocUnsafe(len)
      if (len === 0) return buf
      const fd = openSync(path, 'r')
      try { readExact(fd, buf, offset) } finally { closeSync(fd) }
      return buf
    },
    async readAll() {
      return readFileSync(path)
    },
  }
}

function archiveSource(dir: string, entry: ManifestEntry): Source {
  const path = join(dir, `${entry.id}.zst`)
  const decode = (fd: number, i: number): Buffer => {
    const [, , co, cl] = entry.frames[i]
    const comp = Buffer.allocUnsafe(cl)
    readExact(fd, comp, co)
    return decompressFrame(comp)
  }
  const readSlice = async (offset: number, length: number): Promise<Buffer> => {
    const end = Math.min(entry.size, offset + length)
    if (offset >= end) return Buffer.alloc(0)
    const out = Buffer.allocUnsafe(end - offset)
    const fd = openSync(path, 'r')
    try {
      for (let i = 0; i < entry.frames.length; i++) {
        const [po, pl] = entry.frames[i]
        if (po + pl <= offset) continue
        if (po >= end) break
        const plain = decode(fd, i)
        const from = Math.max(offset, po)
        const to = Math.min(end, po + pl)
        plain.copy(out, from - offset, from - po, to - po)
      }
    } finally {
      closeSync(fd)
    }
    return out
  }
  return {
    name: entry.name,
    size: entry.size,
    origin: { kind: 'archive', id: entry.id },
    entry,
    stream() {
      const count = entry.frames.length
      return Readable.from((function* () {
        if (count === 0) return
        const fd = openSync(path, 'r')
        try { for (let i = 0; i < count; i++) yield decode(fd, i) } finally { closeSync(fd) }
      })(), { objectMode: false })
    },
    readSlice,
    readAll: () => readSlice(0, entry.size),
  }
}

/**
 * `ref` is a path of an existing file (read as it is), or the name of an archived file (the base name is looked up in the manifest), or an archive id.
 * After an original has been replaced, the very same call that read the file reads the archive.
 */
export function openSource(ref: string, opts: { archiveDir?: string } = {}): Source {
  if (existsSync(ref) && statSync(ref).isFile()) return fileSource(ref)
  const dir = opts.archiveDir ?? defaultArchiveDir()
  const entries = readManifest(dir)
  const key = basename(ref)
  const entry = latestByName(entries).get(key) ?? [...entries].reverse().find(e => e.id === key)
  if (!entry) throw new Error(`not a file and not in the archive manifest: ${key}`)
  return archiveSource(dir, entry)
}

// ── ulp.sources: file identity ──────────────────────────────────────────────────────────────────────

/** DDL v28 (lib/clickhouse-migrations.ts) and the archive tool run this same statement: ulp.sources learns the identity of the file a row came from. */
export const SOURCES_IDENTITY_ALTER =
  `ALTER TABLE ulp.sources ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''`

export function sqlQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * The statements that give ulp.sources its identity columns and fill them for the archived names: ensure the columns, then ONE mutation that maps every name to its
 * size, sha256 and archive id (names that are not in the table are simply not touched). Safe to run again.
 */
export function sourcesSyncSql(entries: ManifestEntry[]): string {
  const statements = [`${SOURCES_IDENTITY_ALTER};`]
  if (entries.length > 0) {
    const names = `[${entries.map(e => sqlQuote(e.name)).join(', ')}]`
    const arr = (f: (e: ManifestEntry) => string) => `[${entries.map(f).join(', ')}]`
    statements.push(
      `ALTER TABLE ulp.sources UPDATE ` +
      `size = transform(filename, ${names}, ${arr(e => String(e.size))}, size), ` +
      `sha256 = transform(filename, ${names}, ${arr(e => sqlQuote(e.sha256))}, sha256), ` +
      `archive_id = transform(filename, ${names}, ${arr(e => sqlQuote(e.id))}, archive_id) ` +
      `WHERE filename IN ${names} SETTINGS mutations_sync = 2;`,
    )
  }
  return statements.join('\n') + '\n'
}
