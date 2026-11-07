/**
 * The download-folder pass (docs/superpowers/specs/2026-11-07-file-ledger-design.md, "The sweep", and 2026-11-07-download-mover-design.md). For each finished download in the
 * chat client's folder it asks the ledger what the file is, and then:
 *   - exact bytes ingested AND held by the source archive (the archive decodes back to the same sha256, the standard of `archive --replace`): the download becomes a STAND-IN,
 *     the same name, size and modification time with no disk, so the client keeps showing it as downloaded and the plaintext's disk comes back;
 *   - new, and an inbox is given: the file MOVES into the inbox (a rename) and a stand-in takes its place, so the importer takes the file and the client still shows it as
 *     downloaded;
 *   - anything else (ingested but not archived yet, a name the ledger knows without a hash): left alone.
 * A file is only looked at once it is FINISHED (lib/download-ready.ts): nobody has it open, it has been quiet for a while, and no part of it was left unwritten. A file moved
 * while the client was still writing it would keep growing in its new place and the importer would miss the lines that came after. A partial download cannot match an archived
 * sha256, so the stand-in swap needs no "finished" signal of its own; the move does. Hashes are remembered by name, size and modification time (a JSON file next to the ledger
 * copy), so a folder of files waiting for the owner is read once, not on every tick.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync, type BigIntStats } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MIN_AGE_MS } from '@/lib/archive-replace'
import { openFilesUnder, readiness, type PendingState } from '@/lib/download-ready'
import { appendStandIn, moveAndLeaveStandIn, planTake, replaceWithStandIn, sha256OfFile, writeFileAtomic, type LedgerIndex } from '@/lib/ledger-tools'
import { decompressFrame, type ManifestEntry, type VerifyResult } from '@/lib/source-archive'

/** The folder the chat client downloads into: ULP_DOWNLOAD_DIR, else ~/Downloads/AyuGram Desktop. */
export function defaultDownloadDir(env: NodeJS.Dict<string> = process.env): string {
  return env.ULP_DOWNLOAD_DIR && env.ULP_DOWNLOAD_DIR.trim() !== '' ? env.ULP_DOWNLOAD_DIR : join(homedir(), 'Downloads', 'AyuGram Desktop')
}

/** The pass is on unless ULP_STANDIN_SWEEP=off (the name it had when it only swapped; it now also covers the move). */
export function sweepEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (env.ULP_STANDIN_SWEEP ?? '').trim().toLowerCase() !== 'off'
}

/** The remembered hashes live next to the ledger copy. */
export function hashCacheFile(ledgerFile: string): string {
  return join(dirname(ledgerFile), 'hashes.json')
}

interface CacheEntry { name: string; size: number; mtimeNs: string; sha256: string }
const cacheKey = (name: string, size: bigint | number, mtimeNs: bigint | string): string => `${name}\0${size}\0${mtimeNs}`

function readHashCache(path: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v?: number; files?: CacheEntry[] }
    if (parsed.v === 1 && Array.isArray(parsed.files)) for (const e of parsed.files) out.set(cacheKey(e.name, e.size, e.mtimeNs), e.sha256)
  } catch { /* no cache, or not readable: every file is hashed again */ }
  return out
}

export interface SweepOptions {
  dir: string
  index: LedgerIndex
  /** The archive entry that holds these bytes, if any. */
  holds: (sha256: string) => ManifestEntry | undefined
  /** Decodes the entry's archive again and compares it with the manifest (lib/source-archive verifyEntry). */
  verify: (entry: ManifestEntry) => VerifyResult
  registry: string
  hashCache: string
  /** The inbox a NEW finished download moves into. Without it nothing is moved: a new file is left where it is. */
  inbox?: string
  exts?: string[]
  minSize?: number
  /** The quiet period a download must have had since its last change (default 10 minutes). */
  minAgeMs?: number
  nowMs?: number
  /** The files some other process has open in the folder; defaults to a scan of /proc (lib/download-ready.ts). Called again just before a move. */
  openFiles?: () => Map<string, number[]>
  apply: boolean
}

export interface PendingFile { name: string; state: PendingState; detail: string }

export interface SweepResult {
  swapped: string[]
  /** A dry run: what would have been swapped. */
  wouldSwap: string[]
  /** Moved into the inbox, a stand-in left behind. */
  moved: string[]
  /** A dry run: what would have been moved. */
  wouldMove: string[]
  /** The ledger does not know these bytes and no inbox was given: the file is new and stays. */
  notIngested: string[]
  /** Ingested, but the archive does not hold the bytes yet (or the ledger knows the name and size without a hash). */
  notArchivedYet: string[]
  /** Not finished: still open in another program, changed a moment ago, or left with holes. The names; `pending` says why. */
  waiting: string[]
  pending: PendingFile[]
  /** Something is in the way (the name is already in the inbox): the file stays. */
  refused: Array<{ name: string; reason: string }>
  /** Changed while it was being hashed or just before the move: left alone. */
  changed: string[]
  standIns: number
  hashed: number
  failed: Array<{ name: string; error: string }>
}

const sameFile = (path: string, st: BigIntStats): boolean => {
  try {
    const now = statSync(path, { bigint: true })
    return now.size === st.size && now.mtimeNs === st.mtimeNs
  } catch { return false }
}

export async function sweepDownloads(o: SweepOptions): Promise<SweepResult> {
  const exts = (o.exts ?? ['txt']).map(e => e.toLowerCase().replace(/^\./, ''))
  const minSize = o.minSize ?? 1_000_000
  const quietMs = o.minAgeMs ?? MIN_AGE_MS
  const nowMs = o.nowMs ?? Date.now()
  const openFiles = o.openFiles ?? ((): Map<string, number[]> => openFilesUnder(o.dir, { excludePid: process.pid }))
  const result: SweepResult = {
    swapped: [], wouldSwap: [], moved: [], wouldMove: [], notIngested: [], notArchivedYet: [], waiting: [], pending: [], refused: [], changed: [], standIns: 0, hashed: 0, failed: [],
  }
  const cache = readHashCache(o.hashCache)
  const keep: CacheEntry[] = []
  const open = openFiles()
  // Names already in the inbox or one of its folders: a file moved onto one of them would replace it or be skipped by the importer's same-name guard.
  const inboxNames = new Set<string>()
  if (o.inbox) {
    for (const dir of [o.inbox, ...['processing', 'done', 'held', 'failed'].map(d => join(o.inbox!, d))]) {
      if (!existsSync(dir)) continue
      for (const n of readdirSync(dir)) inboxNames.add(n)
    }
  }

  for (const name of readdirSync(o.dir).sort()) {
    const path = join(o.dir, name)
    let st: BigIntStats
    try { st = statSync(path, { bigint: true }) } catch { continue }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    if (!st.isFile() || !exts.includes(ext) || Number(st.size) < minSize) continue
    if (st.size > 0n && st.blocks === 0n) { result.standIns++; continue }   // already a stand-in
    const ready = readiness(path, st, { nowMs, quietMs, open })
    if (!ready.ready) { result.waiting.push(name); result.pending.push({ name, state: ready.state!, detail: ready.detail! }); continue }

    const key = cacheKey(name, st.size, st.mtimeNs)
    let sha = cache.get(key)
    if (!sha) {
      try { sha = await sha256OfFile(path) } catch (err) { result.failed.push({ name, error: err instanceof Error ? err.message : String(err) }); continue }
      result.hashed++
      if (!sameFile(path, st)) { result.changed.push(name); continue }
    }
    keep.push({ name, size: Number(st.size), mtimeNs: String(st.mtimeNs), sha256: sha })

    const action = planTake(o.index, { name, size: Number(st.size), sha256: sha, archiveHolds: o.holds(sha) !== undefined, inboxNames, refeed: false })
    if (action.kind === 'move' && o.inbox) {
      if (!o.apply) { result.wouldMove.push(name); continue }
      // One last look right before the move: the client may have opened the file again, or it changed since it was hashed.
      const again = openFiles().get(path)
      if (again && again.length > 0) { result.waiting.push(name); result.pending.push({ name, state: 'downloading', detail: `still open in another program (pid ${again.join(', ')}): the download is not finished` }); continue }
      if (!sameFile(path, st)) { result.changed.push(name); continue }
      try {
        const r = moveAndLeaveStandIn(path, join(o.inbox, action.destName))
        appendStandIn(o.registry, path, r.size, r.mtimeNs, sha, new Date(nowMs).toISOString())
        inboxNames.add(action.destName)
        result.moved.push(name)
        keep.pop()   // a stand-in is never hashed again
      } catch (err) {
        result.failed.push({ name, error: err instanceof Error ? err.message : String(err) })
      }
      continue
    }
    if (action.kind === 'refuse' && o.inbox) { result.refused.push({ name, reason: action.reason }); continue }
    if (action.kind !== 'standin-only') {
      // 'keep' = ingested but not archived; everything else is a file the ledger does not know (or knows only by name)
      if (action.kind === 'keep') result.notArchivedYet.push(name); else result.notIngested.push(name)
      continue
    }
    const entry = o.holds(sha)!
    const verdict = o.verify(entry)
    if (!verdict.ok) { result.failed.push({ name, error: `the archive does not verify: ${verdict.problems.join('; ')}` }); continue }
    if (!o.apply) { result.wouldSwap.push(name); continue }
    try {
      const r = replaceWithStandIn(path, { size: Number(st.size), mtimeNs: st.mtimeNs })
      appendStandIn(o.registry, path, r.size, r.mtimeNs, sha, new Date(nowMs).toISOString())
      result.swapped.push(name)
      keep.pop()   // a stand-in is never hashed again
    } catch (err) {
      result.failed.push({ name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (o.apply) writeFileAtomic(o.hashCache, JSON.stringify({ v: 1, files: keep }) + '\n')
  return result
}

// ── restore ────────────────────────────────────────────────────────────────────────────────────────────

/** The registry line of the stand-in at `path` (the last one if it was made more than once). */
export function registryEntryFor(registry: string, path: string): { size: number; mtimeNs: bigint; sha256: string } | null {
  if (!existsSync(registry)) return null
  let found: { size: number; mtimeNs: bigint; sha256: string } | null = null
  for (const line of readFileSync(registry, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const [p, size, mtimeNs, sha256] = line.split('\t')
    // the registry escapes a tab, a newline or a backslash in a path the way the ledger does; the paths of the download folder do not carry them, so a plain compare is enough here
    if (p === path) found = { size: Number(size), mtimeNs: BigInt(mtimeNs), sha256 }
  }
  return found
}

/**
 * Puts the real bytes back where a stand-in is: decodes the archive entry into a temp file next to it, checks size and sha256, gives it the stand-in's modification time and renames it
 * over the stand-in. Refuses a path that is not a stand-in. Needs the file's size in free disk.
 */
export function restoreStandIn(path: string, entry: ManifestEntry, archiveDir: string, mtimeNs: bigint): void {
  const st = statSync(path)
  if (!(st.size > 0 && st.blocks === 0)) throw new Error(`${path} is not a stand-in`)
  if (st.size !== entry.size) throw new Error(`the stand-in is ${st.size} bytes, the archive holds ${entry.size}`)
  const temp = `${path}.restore-${process.pid}`
  const src = openSync(join(archiveDir, `${entry.id}.zst`), 'r')
  const dst = openSync(temp, 'wx', 0o644)
  const hash = createHash('sha256')
  try {
    let total = 0
    for (const [, , co, cl] of entry.frames) {
      const comp = Buffer.allocUnsafe(cl)
      for (let read = 0; read < cl;) {
        const n = readSync(src, comp, read, cl - read, co + read)
        if (n === 0) throw new Error('the archive ends early')
        read += n
      }
      const plain = decompressFrame(comp)
      hash.update(plain)
      for (let written = 0; written < plain.length;) written += writeSync(dst, plain, written, plain.length - written)
      total += plain.length
    }
    if (total !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('the decoded bytes do not match the manifest')
  } catch (err) {
    closeSync(dst); closeSync(src); rmSync(temp, { force: true })
    throw err
  }
  closeSync(dst); closeSync(src)
  const sec = mtimeNs / 1_000_000_000n
  const nsec = mtimeNs % 1_000_000_000n
  execFileSync('touch', ['-d', `@${sec}.${String(nsec).padStart(9, '0')}`, temp])
  renameSync(temp, path)
}
