/**
 * The stand-in sweep (docs/superpowers/specs/2026-11-07-file-ledger-design.md, "The sweep"): in the chat client's download folder, a file whose exact bytes the ledger knows as
 * ingested AND the source archive holds, and whose archive decodes back to the same sha256 (the standard of `archive --replace`), is swapped for a stand-in: the same name, size and
 * modification time, no disk. The client keeps showing the message as downloaded, and the plaintext's disk comes back.
 *
 * It NEVER moves a file and never starts an ingest. A file the ledger does not know is left alone, and so is one that is ingested but not archived yet (the archive timer will
 * get to it). A file modified in the last 10 minutes is left alone (it may still be downloading), and so is one that changes between being hashed and being swapped. A partial
 * download cannot match an archived sha256, so no "download finished" signal is needed. Hashes are remembered by name, size and modification time (a JSON file next to the ledger
 * copy), so a folder of files waiting for the owner is read once, not on every tick.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync, type BigIntStats } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MIN_AGE_MS } from '@/lib/archive-replace'
import { appendStandIn, planTake, replaceWithStandIn, sha256OfFile, writeFileAtomic, type LedgerIndex } from '@/lib/ledger-tools'
import { decompressFrame, type ManifestEntry, type VerifyResult } from '@/lib/source-archive'

/** The folder the chat client downloads into: ULP_DOWNLOAD_DIR, else ~/Downloads/AyuGram Desktop. */
export function defaultDownloadDir(env: NodeJS.Dict<string> = process.env): string {
  return env.ULP_DOWNLOAD_DIR && env.ULP_DOWNLOAD_DIR.trim() !== '' ? env.ULP_DOWNLOAD_DIR : join(homedir(), 'Downloads', 'AyuGram Desktop')
}

/** The sweep is on unless ULP_STANDIN_SWEEP=off. */
export function sweepEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (env.ULP_STANDIN_SWEEP ?? '').trim().toLowerCase() !== 'off'
}

/** The remembered hashes live next to the ledger copy. */
export function hashCacheFile(ledgerFile: string): string {
  return join(dirname(ledgerFile), 'ulp-ledger-hashes.json')
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
  exts?: string[]
  minSize?: number
  minAgeMs?: number
  nowMs?: number
  apply: boolean
}

export interface SweepResult {
  swapped: string[]
  /** A dry run: what would have been swapped. */
  wouldSwap: string[]
  /** The ledger does not know these bytes: the file is new (or has another size), and the owner takes it to the inbox. */
  notIngested: string[]
  /** Ingested, but the archive does not hold the bytes yet. */
  notArchivedYet: string[]
  /** Modified in the last 10 minutes: possibly still downloading. */
  waiting: string[]
  /** Changed while it was being hashed: left alone. */
  changed: string[]
  standIns: number
  hashed: number
  failed: Array<{ name: string; error: string }>
}

export async function sweepDownloads(o: SweepOptions): Promise<SweepResult> {
  const exts = (o.exts ?? ['txt']).map(e => e.toLowerCase().replace(/^\./, ''))
  const minSize = o.minSize ?? 1_000_000
  const minAgeMs = o.minAgeMs ?? MIN_AGE_MS
  const nowMs = o.nowMs ?? Date.now()
  const result: SweepResult = { swapped: [], wouldSwap: [], notIngested: [], notArchivedYet: [], waiting: [], changed: [], standIns: 0, hashed: 0, failed: [] }
  const cache = readHashCache(o.hashCache)
  const keep: CacheEntry[] = []

  for (const name of readdirSync(o.dir).sort()) {
    const path = join(o.dir, name)
    let st: BigIntStats
    try { st = statSync(path, { bigint: true }) } catch { continue }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    if (!st.isFile() || !exts.includes(ext) || Number(st.size) < minSize) continue
    if (st.size > 0n && st.blocks === 0n) { result.standIns++; continue }   // already a stand-in
    if (nowMs - Number(st.mtimeNs / 1_000_000n) < minAgeMs) { result.waiting.push(name); continue }

    const key = cacheKey(name, st.size, st.mtimeNs)
    let sha = cache.get(key)
    if (!sha) {
      try { sha = await sha256OfFile(path) } catch (err) { result.failed.push({ name, error: err instanceof Error ? err.message : String(err) }); continue }
      result.hashed++
      const after = statSync(path, { bigint: true })
      if (after.size !== st.size || after.mtimeNs !== st.mtimeNs) { result.changed.push(name); continue }
    }
    keep.push({ name, size: Number(st.size), mtimeNs: String(st.mtimeNs), sha256: sha })

    const action = planTake(o.index, { name, size: Number(st.size), sha256: sha, archiveHolds: o.holds(sha) !== undefined, inboxNames: new Set(), refeed: false })
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
