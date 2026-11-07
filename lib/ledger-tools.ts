/**
 * The helpers behind the file ledger's command-line tools (docs/superpowers/specs/2026-11-07-file-ledger-design.md): the plain-text copy of the ledger
 * (scripts/ledger-export.ts), the check of a Telegram chat export against it (scripts/ledger-check.ts) and the move into the inbox that leaves a stand-in behind
 * (scripts/take-to-inbox.ts). Pure functions and plain `fs` calls, no database: the scripts fetch the rows and hand them over, so everything here is tested in a temp folder.
 *
 * Names of data files appear in these files' OUTPUT only, on the owner's machine; nothing here names one.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PARSER_REVISION } from '@/lib/parser-version'

// ── The plain-text ledger ───────────────────────────────────────────────────────────────────────────────

/** One line of the plain-text ledger: a row of ulp.sources (`ledger`), or a file the job log completed that has no row (`jobs`, older than the ledger or a file that yielded nothing). */
export interface LedgerRow {
  kind: 'ledger' | 'jobs'
  filename: string
  /** Bytes; 0 = not recorded. */
  size: number
  /** sha256 of the plaintext; '' = not recorded. */
  sha256: string
  /** Rows the file added when it was imported. */
  lines: number
  /** lib/parser-version.ts at the time; 0 = not recorded. */
  revision: number
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  when: string
  /** The source archive holds the plaintext (ulp.sources.archive_id is set). */
  archived: boolean
}

export const LEDGER_HEADER = '#kind\tfilename\tsize\tsha256\tlines\tparser_revision\twhen\tarchived'

const escapeField = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
const unescapeField = (s: string): string => s.replace(/\\([\\tnr])/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'))

export function formatLedger(rows: LedgerRow[]): string {
  const lines = rows.map(r => [r.kind, escapeField(r.filename), r.size, r.sha256, r.lines, r.revision, r.when, r.archived ? 1 : 0].join('\t'))
  return [LEDGER_HEADER, ...lines].join('\n') + '\n'
}

export function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 8 || (f[0] !== 'ledger' && f[0] !== 'jobs')) continue
    rows.push({
      kind: f[0], filename: unescapeField(f[1]), size: Number(f[2]) || 0, sha256: f[3], lines: Number(f[4]) || 0,
      revision: Number(f[5]) || 0, when: f[6], archived: f[7] === '1',
    })
  }
  return rows
}

/** The ledger indexed the two ways the tools ask: by content hash and by name. */
export interface LedgerIndex {
  bySha: Map<string, LedgerRow[]>
  byName: Map<string, LedgerRow[]>
}

export function indexLedger(rows: LedgerRow[]): LedgerIndex {
  const bySha = new Map<string, LedgerRow[]>()
  const byName = new Map<string, LedgerRow[]>()
  for (const r of rows) {
    if (r.sha256) bySha.set(r.sha256, [...(bySha.get(r.sha256) ?? []), r])
    byName.set(r.filename, [...(byName.get(r.filename) ?? []), r])
  }
  return { bySha, byName }
}

export function readLedgerFile(path: string): LedgerRow[] {
  return existsSync(path) ? parseLedger(readFileSync(path, 'utf8')) : []
}

/** Writes through a temp name and a rename, so a reader never sees half a file. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  const fd = openSync(tmp, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
}

// ── What the ledger says about a file ───────────────────────────────────────────────────────────────────

export type Known =
  | { status: 'content'; row: LedgerRow }       // the exact bytes are in the ledger (same hash)
  | { status: 'name-size'; row: LedgerRow }     // the name and the size are, and the row has no hash to compare
  | { status: 'other-size'; rows: LedgerRow[] } // the name is, only with another size: another file under a used name
  | { status: 'new' }

/** What the ledger knows about a file, by what is known of it: its name, its size and (when it was hashed) its sha256. A hash match wins over a name. */
export function lookupFile(index: LedgerIndex, file: { name: string; size: number; sha256?: string }): Known {
  if (file.sha256) {
    const hit = index.bySha.get(file.sha256)
    if (hit && hit.length > 0) return { status: 'content', row: newestRevision(hit) }
  }
  const named = index.byName.get(file.name) ?? []
  if (named.length === 0) return { status: 'new' }
  // A row with a hash that differs from the file's is another file; a row with no hash is decided by the size (0 = not recorded: the name decides).
  const same = named.filter(r => (r.sha256 ? !file.sha256 && r.size === file.size : r.size === 0 || r.size === file.size))
  if (same.length > 0) return { status: 'name-size', row: newestRevision(same) }
  return { status: 'other-size', rows: named }
}

const newestRevision = (rows: LedgerRow[]): LedgerRow => rows.reduce((a, b) => (b.revision > a.revision || (b.revision === a.revision && b.when > a.when) ? b : a))

// ── A Telegram Desktop chat export ──────────────────────────────────────────────────────────────────────

export interface ExportFile {
  chat: string
  messageId: number
  date: string
  name: string
  size: number
}

/**
 * The files a Telegram Desktop JSON export lists, with or without the file itself in the export: the export always writes file_name and file_size for a document, and
 * puts a reason text in `file` when it did not include the bytes. Both layouts are read: one chat ({ name, messages }) and the whole account ({ chats: { list } }).
 */
export function parseTelegramExport(json: unknown): ExportFile[] {
  const out: ExportFile[] = []
  const chatsOf = (j: unknown): Array<{ name?: unknown; messages?: unknown }> => {
    if (!j || typeof j !== 'object') return []
    const o = j as { chats?: { list?: unknown }; messages?: unknown; name?: unknown }
    if (Array.isArray(o.messages)) return [o]
    const list = o.chats?.list
    return Array.isArray(list) ? (list as Array<{ name?: unknown; messages?: unknown }>) : []
  }
  for (const chat of chatsOf(json)) {
    if (!Array.isArray(chat.messages)) continue
    const chatName = typeof chat.name === 'string' ? chat.name : ''
    for (const m of chat.messages as Array<Record<string, unknown>>) {
      if (!m || typeof m.file_name !== 'string' || m.file_name === '') continue
      const size = Number(m.file_size)
      if (!Number.isFinite(size) || size < 0) continue
      out.push({ chat: chatName, messageId: Number(m.id) || 0, date: typeof m.date === 'string' ? m.date : '', name: m.file_name, size })
    }
  }
  return out
}

export type ExportStatus = 'NEW' | 'HAVE' | 'DIFFERENT-SIZE' | 'LOCAL'

export interface ExportVerdict {
  name: string
  size: number
  status: ExportStatus
  /** Messages of the export that carry this very file (reposts in other chats or the same one). */
  copies: number
  firstMessage: ExportFile
  /** A short reason for the line: the ledger row's parser revision, or the other sizes. */
  detail: string
}

export interface CheckOptions {
  /** Lower-case extensions to look at, without the dot. Empty = every file. */
  extensions: string[]
  /** Files below this many bytes are ignored (pictures, stickers, notes). */
  minSize: number
  /** Names and sizes of files already on disk (the download folder), as "name\0size". */
  local?: Set<string>
}

export const localKey = (name: string, size: number): string => `${name}\0${size}`

/** Groups the export's files by name and size and says what the ledger and the download folder know of each. NEW and DIFFERENT-SIZE are the ones worth downloading. */
export function checkExport(files: ExportFile[], index: LedgerIndex, opts: CheckOptions): ExportVerdict[] {
  const groups = new Map<string, { first: ExportFile; copies: number }>()
  for (const f of files) {
    const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase() : ''
    if (opts.extensions.length > 0 && !opts.extensions.includes(ext)) continue
    if (f.size < opts.minSize) continue
    const k = localKey(f.name, f.size)
    const g = groups.get(k)
    if (g) { g.copies++; if (f.date < g.first.date) g.first = f } else groups.set(k, { first: f, copies: 1 })
  }
  const verdicts: ExportVerdict[] = []
  for (const { first, copies } of groups.values()) {
    const known = lookupFile(index, { name: first.name, size: first.size })
    let status: ExportStatus
    let detail = ''
    if (known.status === 'name-size') {
      status = 'HAVE'
      detail = known.row.kind === 'jobs' ? 'in the job log only' : known.row.revision > 0 && known.row.revision < PARSER_REVISION ? `imported by parser revision ${known.row.revision}` : ''
    } else if (opts.local?.has(localKey(first.name, first.size))) {
      status = 'LOCAL'
      detail = 'already in the download folder'
    } else if (known.status === 'other-size') {
      status = 'DIFFERENT-SIZE'
      detail = `the ledger has this name with size ${[...new Set(known.rows.map(r => r.size))].join(', ')}`
    } else {
      status = 'NEW'
    }
    verdicts.push({ name: first.name, size: first.size, status, copies, firstMessage: first, detail })
  }
  const order: Record<ExportStatus, number> = { NEW: 0, 'DIFFERENT-SIZE': 1, LOCAL: 2, HAVE: 3 }
  return verdicts.sort((a, b) => order[a.status] - order[b.status] || a.firstMessage.date.localeCompare(b.firstMessage.date))
}

// ── Stand-ins ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in is a sparse file with the name, the size and the modification time of a download that moved away. Telegram Desktop (and AyuGram, a fork) keep a message "downloaded"
 * while the file at the path it recorded exists with the same size and the same modification time (Core::FileLocation::check), and the Downloads list keeps its entry while
 * the size matches. A sparse file takes no disk, whatever its size.
 */
export function isStandIn(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && st.size > 0 && st.blocks === 0
  } catch {
    return false
  }
}

/** Creates the stand-in at `path` (which must not exist): `size` bytes, no blocks, modification time `mtimeNs` (nanoseconds since the epoch, as stat gives them). Returns false when it exists. */
export function createStandIn(path: string, size: number, mtimeNs: bigint, mode = 0o644): boolean {
  if (existsSync(path)) return false
  const fd = openSync(path, 'wx', mode)
  try {
    ftruncateSync(fd, size)   // on a fresh file this is a hole of that size: no byte is written, no block is taken
  } finally {
    closeSync(fd)
  }
  const sec = mtimeNs / 1_000_000_000n
  const nsec = mtimeNs % 1_000_000_000n
  // coreutils touch takes the time to the nanosecond; fs.utimes would round it to a double
  execFileSync('touch', ['-d', `@${sec}.${String(nsec).padStart(9, '0')}`, path])
  return true
}

/** The registry of stand-ins the take-to-inbox tool made: one line each, so a stand-in is never mistaken for data and can be checked later. */
export const STANDIN_HEADER = '#path\tsize\tmtime_ns\tsha256\tcreated'
export function appendStandIn(registry: string, path: string, size: number, mtimeNs: bigint, sha256: string, createdIso: string): void {
  if (!existsSync(registry)) writeFileSync(registry, STANDIN_HEADER + '\n')
  appendFileSync(registry, [escapeField(path), size, String(mtimeNs), sha256, createdIso].join('\t') + '\n')
}

// ── Hashing ──────────────────────────────────────────────────────────────────────────────────────────────

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

// ── Taking a download into the inbox ───────────────────────────────────────────────────────────────────

export type TakeAction =
  | { kind: 'standin-only'; reason: string }                // already ingested and archived: swap the download for a stand-in, move nothing
  | { kind: 'keep'; reason: string }                         // already ingested but not archived (or only by name): leave the file where it is
  | { kind: 'move'; destName: string; note: string }       // new: move it into the inbox under destName, leave a stand-in
  | { kind: 'refuse'; reason: string }                       // something is in the way

export interface TakeInput {
  name: string
  size: number
  sha256: string
  /** True when the source archive's manifest holds an entry with this sha256. */
  archiveHolds: boolean
  /** Names that already exist in the inbox or one of its folders (inbox, processing, done, held, failed). */
  inboxNames: Set<string>
  /** Move a file the ledger holds at an older parser revision, under a name that says it is a re-feed. */
  refeed: boolean
}

/** The name a deliberate re-feed of `n` goes by: "x.txt" becomes "x (refeed v6.6).txt". The word "refeed" is what lets the importer read bytes it already holds. */
export function refeedNameFor(n: string, revision: number = PARSER_REVISION): string {
  const dot = n.lastIndexOf('.')
  const marker = ` (refeed v${(revision / 10).toFixed(1)})`
  return dot > 0 ? `${n.slice(0, dot)}${marker}${n.slice(dot)}` : `${n}${marker}`
}

/** What to do with one download. Pure: the script hashes the file, reads the folders and the archive manifest, and hands the facts over. */
export function planTake(index: LedgerIndex, f: TakeInput): TakeAction {
  const known = lookupFile(index, { name: f.name, size: f.size, sha256: f.sha256 })
  const refeedName = refeedNameFor
  if (known.status === 'content') {
    const r = known.row
    const olderParser = r.revision > 0 && r.revision < PARSER_REVISION
    if (f.refeed && olderParser) {
      const dest = refeedName(f.name)
      return f.inboxNames.has(dest) ? { kind: 'refuse', reason: `"${dest}" is already in the inbox` } : { kind: 'move', destName: dest, note: `re-feed: imported before by parser revision ${r.revision}` }
    }
    const since = `imported ${r.when.slice(0, 10)} as "${r.filename}"${olderParser ? ` by parser revision ${r.revision} (--refeed moves it again)` : ''}`
    return f.archiveHolds && r.archived
      ? { kind: 'standin-only', reason: `${since}; the source archive holds these bytes` }
      : { kind: 'keep', reason: `${since}; not in the source archive yet, so the file stays` }
  }
  if (known.status === 'name-size') {
    // A name from the job log is older than the ledger: it has no size and no hash, and the importer does not block on it, so the importer decides.
    if (known.row.kind === 'jobs') {
      if (f.inboxNames.has(f.name)) return { kind: 'refuse', reason: `"${f.name}" is already in the inbox or one of its folders` }
      return { kind: 'move', destName: f.name, note: 'the job log has this name from before the ledger; its content is unknown, so the importer decides' }
    }
    return { kind: 'keep', reason: `the ledger has this name and size (imported ${known.row.when.slice(0, 10)}) with no hash to compare; the file stays` }
  }
  if (f.inboxNames.has(f.name)) return { kind: 'refuse', reason: `"${f.name}" is already in the inbox or one of its folders` }
  return { kind: 'move', destName: f.name, note: known.status === 'other-size' ? 'a name the ledger has with another size: taken as a different file' : 'new' }
}

/** Moves `src` to `dest` (one filesystem: a rename keeps the modification time) and leaves a stand-in at `src`. Returns the stand-in's facts. */
export function moveAndLeaveStandIn(src: string, dest: string): { size: number; mtimeNs: bigint; mode: number } {
  const st = statSync(src, { bigint: true })
  if (existsSync(dest)) throw new Error(`${dest} exists`)
  renameSync(src, dest)   // throws EXDEV across filesystems; nothing is copied or half done
  const size = Number(st.size)
  createStandIn(src, size, st.mtimeNs, Number(st.mode & 0o777n))
  return { size, mtimeNs: st.mtimeNs, mode: Number(st.mode & 0o777n) }
}

/**
 * Replaces a download whose bytes are in the source archive by a stand-in: the same size and time, no blocks. The file is renamed aside first, so a failure leaves it.
 * With `expect` (the size and time the file had when it was hashed) it refuses a file that has changed since: a download that grew meanwhile is not the file that was checked.
 */
export function replaceWithStandIn(path: string, expect?: { size: number; mtimeNs: bigint }): { size: number; mtimeNs: bigint } {
  const st = statSync(path, { bigint: true })
  if (expect && (st.size !== BigInt(expect.size) || st.mtimeNs !== expect.mtimeNs)) throw new Error('the file changed after it was checked; nothing was replaced')
  const aside = `${path}.standin-old-${process.pid}`
  renameSync(path, aside)
  try {
    createStandIn(path, Number(st.size), st.mtimeNs, Number(st.mode & 0o777n))
  } catch (err) {
    renameSync(aside, path)
    throw err
  }
  unlinkSync(aside)
  return { size: Number(st.size), mtimeNs: st.mtimeNs }
}

