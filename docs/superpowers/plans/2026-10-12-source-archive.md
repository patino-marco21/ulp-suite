# Source Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every source file as a verified, compressed, content-addressed archive that every offline tool can read, and give the owner a command that replaces an original only after its archive has been decoded again and proven identical.

**Architecture:** `lib/source-archive.ts` (frames, manifest, verification, `openSource`), `lib/archive-replace.ts` (the guards of `--replace`), `scripts/archive-sources.ts` (the CLI, worker processes). `scripts/parser-diff.ts`, `scripts/pile/verify-file.ts`, `scripts/extract-dropped-lines.ts` and `lib/dropped-lines.ts` read through `openSource`. This is Part 1 of `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`; the importer's archive reference, the ingest gate and the DDL are a separate plan (`2026-10-12-ingest-gate-and-archive-ref.md`). Nothing here changes the running app: offline scripts, a library and tests.

**Tech Stack:** Node 24 built-in zstd (`node:zlib`), TypeScript (strict, `lib/` is type-checked, `scripts/` is not), vitest, tsx; ClickHouse is reached through `docker exec` exactly like `scripts/pile/*`.

## Global Constraints

- The archive directory is `~/ulp-archive` (env `ULP_ARCHIVE_DIR`, flag `--out`), outside the repository and the Docker build context; the tool never creates it.
- Format: concatenated zstd frames of at most 64 MiB of plaintext, each cut at a newline (at 64 MiB when the last 1 MiB holds none); level 12, window log 27, long-distance matching; `zstd -dc <id>.zst` returns the original file.
- `id` is the first 24 hex characters of the sha256 of the plaintext (content addressed: two names with identical bytes share one archive).
- `manifest.jsonl` has one JSON line per archived name: `name`, `id`, `size`, `sha256`, `lines`, `frames` (`[plainOffset, plainLength, compOffset, compLength]`), `archive_bytes`, `archive_sha256`, `level`, `created_at`, `replaced_at`. It holds file names, so it is never committed.
- Verify independently before anything is recorded or unlinked: decode every frame again, re-hash, compare size, line count and both sha256 values.
- `--replace` refusals, each printed with its reason: a file is in flight in the inbox (a top-level file in `inbox/`, or anything in `inbox/processing/`); the file was modified in the last 10 minutes (skipped, not an error); the name is not in `ulp.sources` (unless `--include-unimported`); free space is under 10 GiB plus twice the file (checked before work starts); the archive directory is missing or not writable.
- `--replace` unlinks only the original and the names under `inbox/done` that are hardlinks of the same inode; it never touches `inbox/failed`, `inbox/held` or anything it did not create, and it stat-checks the original (size and modification time) just before unlinking.
- The tool never prints a line of a file. Tests use synthetic fixtures only.
- The repository is public: no file names, search terms or credential values in code, tests, docs or commit messages.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/home/cole/ulp-suite/.claude/worktrees/reversible-pipeline` (branch `reversible-pipeline`); never touch the `parser-v6` worktree (a pile run's scripts execute from it).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/source-archive.ts` (create) | Frame reader and cutter, compress / decompress, `archiveFile`, `verifyEntry`, the manifest, `openSource`, `sourcesSyncSql`. No printing, no process state. |
| `lib/archive-replace.ts` (create) | `replaceRefusals`, `spaceRefusal`, `inboxIsBusy`, `sameInodeNames`, `replaceOriginal`. Pure functions plus small fs helpers. |
| `scripts/archive-sources.ts` (create) | The CLI: `archive`, `status`, `verify`, `restore`, `sources-sync`; worker processes via `fork`. |
| `lib/dropped-lines.ts` (modify) | Reads its source through `openSource`. |
| `scripts/parser-diff.ts` (modify) | Reads through `openSource`; `--from-archive` lists names from the manifest. |
| `scripts/pile/verify-file.ts` (modify) | Reads through `openSource`. |
| `scripts/extract-dropped-lines.ts` (modify) | `--from-archive`. |
| `__tests__/source-archive.test.ts`, `__tests__/archive-replace.test.ts`, `__tests__/archive-sources-cli.test.ts` (create) | Unit tests, and the CLI run for real in a sandbox with a fake `docker`. |
| `__tests__/dropped-lines.test.ts` (modify) | One test: a source that exists only in the archive. |
| `docs/pile-import-runbook.md` (modify), `.gitignore`, `.dockerignore` (modify) | The archive procedure; keep `ulp-archive/` out of git and the image. |

Prerequisite for every task: `node_modules` in the worktree. On a normal machine run `npm ci`. On this laptop a hardlink copy is instant and costs no disk:
`cp -al /home/cole/ulp-suite/.claude/worktrees/parser-v6/node_modules /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline/node_modules`.

---

### Task 1: The archive library

**Files:**
- Create: `lib/source-archive.ts`
- Test: `__tests__/source-archive.test.ts`

**Interfaces:**
- Consumes: Node built-ins only (`node:zlib` zstd, `node:crypto`, `node:fs`).
- Produces (exact signatures, used by every later task):
  - `export const FRAME_BYTES: number`, `FRAME_SEARCH_BYTES`, `ZSTD_LEVEL`, `ZSTD_WINDOW_LOG`, `ID_LENGTH`, `MANIFEST_FILE`
  - `export type FrameRow = [number, number, number, number]`
  - `export interface ManifestEntry { name: string; id: string; size: number; sha256: string; lines: number; frames: FrameRow[]; archive_bytes: number; archive_sha256: string; level: number; created_at: string; replaced_at?: string }`
  - `export function defaultArchiveDir(env?: NodeJS.ProcessEnv): string`
  - `export function countNewlines(buf: Buffer): number`
  - `export function* readFrames(path: string, frameBytes?: number, searchBytes?: number): Generator<Buffer>`
  - `export function compressFrame(plain: Buffer, level?: number): Buffer`, `export function decompressFrame(comp: Buffer): Buffer`
  - `export interface ArchiveOptions { archiveDir: string; name?: string; level?: number; frameBytes?: number; searchBytes?: number; lookupById?: (id: string) => ManifestEntry | undefined; now?: () => Date }`
  - `export function archiveFile(srcPath: string, opts: ArchiveOptions): ManifestEntry`
  - `export interface VerifyResult { ok: boolean; problems: string[] }`, `export function verifyEntry(archiveDir: string, entry: ManifestEntry): VerifyResult`
  - `export function readManifest(archiveDir: string): ManifestEntry[]`, `export function latestByName(entries: ManifestEntry[]): Map<string, ManifestEntry>`, `export function appendManifest(archiveDir: string, entry: ManifestEntry): void`
  - `export function removeStaleParts(archiveDir: string, maxAgeMs?: number, nowMs?: number): string[]` (removes `*.part` files older than `maxAgeMs`, default one hour; returns their names)
  - `export interface Source { name: string; size: number; origin: { kind: 'file'; path: string } | { kind: 'archive'; id: string }; entry?: ManifestEntry; stream(): Readable; readSlice(offset: number, length: number): Promise<Buffer>; readAll(): Promise<Buffer> }`
  - `export function openSource(ref: string, opts?: { archiveDir?: string }): Source`
  - `export function sqlQuote(s: string): string`, `export function sourcesSyncSql(entries: ManifestEntry[]): string`

- [ ] **Step 1: Write the failing test**

Create `__tests__/source-archive.test.ts`:

```ts
/**
 * The source archive: frames, manifest, verification, openSource and the ulp.sources statements.
 * Synthetic files only. Frames are made tiny (64 bytes) so that a few hundred bytes cross many frame boundaries.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  appendManifest, archiveFile, countNewlines, defaultArchiveDir, latestByName, openSource, readFrames, readManifest, removeStaleParts, sourcesSyncSql, sqlQuote,
  verifyEntry, type ManifestEntry,
} from '@/lib/source-archive'

let root: string
let src: string
let arc: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'source-archive-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  const t = mkdtempSync(join(root, 't-'))
  src = join(t, 'src'); arc = join(t, 'arc')
  mkdirSync(src); mkdirSync(arc)
})

const FRAME = { frameBytes: 64, searchBytes: 32 }
const lineBody = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(i % 17)}`).join('\n') + '\n'
const put = (name: string, body: Buffer | string) => { const p = join(src, name); writeFileSync(p, body); return p }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const expectedLines = (b: Buffer) => (b.length === 0 ? 0 : countNewlines(b) + (b[b.length - 1] === 10 ? 0 : 1))
const concat = async (s: AsyncIterable<unknown>) => { const parts: Buffer[] = []; for await (const c of s) parts.push(c as Buffer); return Buffer.concat(parts) }

describe('frames', () => {
  test('every frame but the last ends at a newline, and the frame table tiles the file', async () => {
    const body = lineBody(60)
    const p = put('tile.txt', body)
    const e = archiveFile(p, { archiveDir: arc, ...FRAME })
    appendManifest(arc, e)
    unlinkSync(p)
    const s = openSource(p, { archiveDir: arc })
    expect(e.frames.length).toBeGreaterThan(5)
    let off = 0
    for (const [i, [po, pl]] of e.frames.entries()) {
      expect(po).toBe(off)
      const plain = await s.readSlice(po, pl)
      expect(plain.length).toBe(pl)
      if (i < e.frames.length - 1) expect(plain[plain.length - 1]).toBe(10)
      off += pl
    }
    expect(off).toBe(Buffer.byteLength(body))
  })

  test('a line longer than a frame is cut at the frame size', () => {
    const p = put('long.txt', 'y'.repeat(300) + '\n' + lineBody(3))
    const sizes = [...readFrames(p, 64, 32)].map(f => f.length)
    expect(sizes.slice(0, 4)).toEqual([64, 64, 64, 64])
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(readFileSync(p).length)
  })
})

describe('archiveFile / openSource round trip', () => {
  const bodies: Array<[string, Buffer]> = [
    ['empty', Buffer.alloc(0)],
    ['one byte without a newline', Buffer.from('x')],
    ['no trailing newline', Buffer.from(lineBody(20).trimEnd())],
    ['CRLF line ends', Buffer.from(lineBody(20).replace(/\n/g, '\r\n'))],
    ['all 256 byte values', Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))],
    ['a line longer than a frame', Buffer.from('y'.repeat(300) + '\n' + lineBody(3))],
    ['only newlines', Buffer.from('\n'.repeat(150))],
  ]
  test.each(bodies)('%s', async (label, body) => {
    const p = put(`rt-${label.length}-${body.length}.bin`, body)
    const plainSource = openSource(p)
    expect(plainSource.origin.kind).toBe('file')
    expect(Buffer.compare(await plainSource.readAll(), body)).toBe(0)

    const e = archiveFile(p, { archiveDir: arc, ...FRAME })
    appendManifest(arc, e)
    expect(e.size).toBe(body.length)
    expect(e.sha256).toBe(sha(body))
    expect(e.id).toBe(sha(body).slice(0, 24))
    expect(e.lines).toBe(expectedLines(body))
    expect(verifyEntry(arc, e)).toEqual({ ok: true, problems: [] })

    unlinkSync(p)                                   // the original is gone: the same call falls back to the archive
    const archived = openSource(p, { archiveDir: arc })
    expect(archived.origin).toEqual({ kind: 'archive', id: e.id })
    expect(archived.size).toBe(body.length)
    expect(Buffer.compare(await archived.readAll(), body)).toBe(0)
    expect(Buffer.compare(await concat(archived.stream()), body)).toBe(0)
  })

  test('readSlice equals the plaintext slice across frame boundaries', async () => {
    const body = Buffer.from(lineBody(80))
    const p = put('slice.txt', body)
    appendManifest(arc, archiveFile(p, { archiveDir: arc, ...FRAME }))
    unlinkSync(p)
    const s = openSource(p, { archiveDir: arc })
    for (const off of [0, 1, 63, 64, 65, 100, body.length - 1, body.length, body.length + 5]) {
      for (const len of [0, 1, 63, 64, 65, 500, body.length * 2]) {
        const want = body.subarray(Math.min(off, body.length), Math.min(off + len, body.length))
        expect(Buffer.compare(await s.readSlice(off, len), want)).toBe(0)
      }
    }
  })

  const hasZstd = spawnSync('zstd', ['-V']).status === 0
  test.skipIf(!hasZstd)('the zstd binary decodes the archive file to the original', () => {
    const body = Buffer.from(lineBody(200))
    const e = archiveFile(put('interop.txt', body), { archiveDir: arc, ...FRAME })
    const r = spawnSync('zstd', ['-dc', join(arc, `${e.id}.zst`)], { maxBuffer: 1 << 24 })
    expect(r.status).toBe(0)
    expect(Buffer.compare(r.stdout, body)).toBe(0)
  })
})

describe('verifyEntry', () => {
  test('accepts a good archive and rejects a damaged, a truncated and a missing one', () => {
    const e = archiveFile(put('v.txt', lineBody(80)), { archiveDir: arc, ...FRAME })
    expect(verifyEntry(arc, e)).toEqual({ ok: true, problems: [] })
    const f = join(arc, `${e.id}.zst`)
    const good = readFileSync(f)
    const bad = Buffer.from(good); bad[Math.floor(bad.length / 2)] ^= 0xff
    writeFileSync(f, bad)
    expect(verifyEntry(arc, e).ok).toBe(false)
    writeFileSync(f, good.subarray(0, good.length - 5))
    expect(verifyEntry(arc, e).ok).toBe(false)
    unlinkSync(f)
    const missing = verifyEntry(arc, e)
    expect(missing.ok).toBe(false)
    expect(missing.problems[0]).toMatch(/missing/)
    writeFileSync(f, good)
    expect(verifyEntry(arc, e).ok).toBe(true)
  })

  test('rejects a manifest entry whose numbers do not match the archive', () => {
    const e = archiveFile(put('m.txt', lineBody(40)), { archiveDir: arc, ...FRAME })
    expect(verifyEntry(arc, { ...e, lines: e.lines + 1 }).ok).toBe(false)
    expect(verifyEntry(arc, { ...e, sha256: '0'.repeat(64) }).ok).toBe(false)
    expect(verifyEntry(arc, { ...e, size: e.size + 1 }).ok).toBe(false)
  })
})

describe('archiveFile edges', () => {
  test('two names with the same content share one archive file', () => {
    const a = archiveFile(put('d1.txt', lineBody(40)), { archiveDir: arc, ...FRAME })
    appendManifest(arc, a)
    const b = archiveFile(put('d2.txt', lineBody(40)), { archiveDir: arc, ...FRAME, lookupById: id => readManifest(arc).find(e => e.id === id) })
    expect(b.id).toBe(a.id)
    expect(b.name).toBe('d2.txt')
    expect(b.frames).toEqual(a.frames)
    expect(readdirSync(arc).filter(n => n.endsWith('.zst'))).toHaveLength(1)
    expect(readdirSync(arc).filter(n => n.endsWith('.part'))).toHaveLength(0)
  })

  test('a failed archive leaves no .part file behind', () => {
    expect(() => archiveFile(join(src, 'missing.txt'), { archiveDir: arc })).toThrow()
    expect(readdirSync(arc).filter(n => n.endsWith('.part'))).toHaveLength(0)
  })

  test('refuses an archive directory that does not exist and does not create it', () => {
    const nope = join(root, 'does-not-exist')
    expect(() => archiveFile(put('x.txt', 'abc\n'), { archiveDir: nope })).toThrow(/does not exist/)
    expect(() => readdirSync(nope)).toThrow()
  })

  test('removeStaleParts removes the leftovers of a killed run and only those', () => {
    const now = Date.now()
    const old = join(arc, 'dead.part'), fresh = join(arc, 'live.part'), other = join(arc, 'keep.zst')
    for (const p of [old, fresh, other]) writeFileSync(p, 'x')
    const longAgo = new Date(now - 2 * 3_600_000)
    utimesSync(old, longAgo, longAgo); utimesSync(other, longAgo, longAgo)
    expect(removeStaleParts(arc, 3_600_000, now)).toEqual(['dead.part'])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})

describe('manifest and openSource', () => {
  const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
    name: 'n.txt', id: 'a'.repeat(24), size: 1, sha256: 'b'.repeat(64), lines: 1, frames: [[0, 1, 0, 9]], archive_bytes: 9, archive_sha256: 'c'.repeat(64),
    level: 12, created_at: '2026-10-12T00:00:00.000Z', ...over,
  })

  test('appended lines are read back and the latest line of a name wins', () => {
    appendManifest(arc, entry({ size: 1 }))
    appendManifest(arc, entry({ size: 1, replaced_at: '2026-10-13T00:00:00.000Z' }))
    appendManifest(arc, entry({ name: 'other.txt', id: 'd'.repeat(24) }))
    const all = readManifest(arc)
    expect(all).toHaveLength(3)
    const latest = latestByName(all)
    expect(latest.size).toBe(2)
    expect(latest.get('n.txt')?.replaced_at).toBe('2026-10-13T00:00:00.000Z')
  })

  test('an empty or missing manifest reads as no entries', () => {
    expect(readManifest(arc)).toEqual([])
  })

  test('a name, an id and a path resolve; an unknown name throws', async () => {
    const body = Buffer.from(lineBody(30))
    const e = archiveFile(put('known.txt', body), { archiveDir: arc, ...FRAME })
    appendManifest(arc, e)
    expect((await openSource('known.txt', { archiveDir: arc }).readAll()).equals(body)).toBe(true)
    expect((await openSource(e.id, { archiveDir: arc }).readAll()).equals(body)).toBe(true)
    expect(() => openSource('unknown.txt', { archiveDir: arc })).toThrow(/not a file and not in the archive/)
  })

  test('defaultArchiveDir reads ULP_ARCHIVE_DIR and falls back to ~/ulp-archive', () => {
    expect(defaultArchiveDir({ ULP_ARCHIVE_DIR: '/somewhere' } as NodeJS.ProcessEnv)).toBe('/somewhere')
    expect(defaultArchiveDir({ ULP_ARCHIVE_DIR: '  ' } as NodeJS.ProcessEnv)).toMatch(/ulp-archive$/)
    expect(defaultArchiveDir({} as NodeJS.ProcessEnv)).toMatch(/ulp-archive$/)
  })
})

describe('sourcesSyncSql', () => {
  test('adds the columns and fills them with one mutation; names are quoted safely', () => {
    const sql = sourcesSyncSql([
      { name: "it's.txt", id: 'a'.repeat(24), size: 5, sha256: 'b'.repeat(64) } as ManifestEntry,
      { name: 'back\\slash.txt', id: 'c'.repeat(24), size: 6, sha256: 'd'.repeat(64) } as ManifestEntry,
    ])
    expect(sql).toMatch(/^ALTER TABLE ulp\.sources ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT '';/)
    expect(sql).toContain("'it\\'s.txt'")
    expect(sql).toContain("'back\\\\slash.txt'")
    expect(sql).toContain('size = transform(filename, [')
    expect(sql).toContain('SETTINGS mutations_sync = 2;')
    expect(sql.match(/UPDATE/g)).toHaveLength(1)
  })

  test('no entries: only the ALTER ADD COLUMN', () => {
    expect(sourcesSyncSql([])).not.toContain('UPDATE')
  })

  test('sqlQuote escapes backslashes and quotes', () => {
    expect(sqlQuote("a'b\\c")).toBe("'a\\'b\\\\c'")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/source-archive.test.ts`
Expected: FAIL, every test errors with `Failed to resolve import "@/lib/source-archive"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/source-archive.ts`:

```ts
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

export function defaultArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
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

function fileSource(path: string): Source {
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

export function sqlQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * The statements that give ulp.sources its identity columns and fill them for the archived names: ensure the columns, then ONE mutation that maps every name to its
 * size, sha256 and archive id (names that are not in the table are simply not touched). Safe to run again.
 */
export function sourcesSyncSql(entries: ManifestEntry[]): string {
  const cols =
    `ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''`
  const statements = [`ALTER TABLE ulp.sources ${cols};`]
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/source-archive.test.ts`
Expected: PASS, all tests green (the interop test is skipped only when the `zstd` binary is missing).

- [ ] **Step 5: Type-check, lint, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit && npx eslint --no-eslintrc -c .eslintrc.json lib/source-archive.ts __tests__/source-archive.test.ts`
Expected: no output from `tsc`; no errors from eslint (warnings about unused imports must be fixed first).

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib/source-archive.ts __tests__/source-archive.test.ts docs/superpowers/plans/2026-10-12-source-archive.md
git commit -m "feat(archive): the source archive library, frames, manifest, verification and openSource

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `--replace` guards

**Files:**
- Create: `lib/archive-replace.ts`
- Test: `__tests__/archive-replace.test.ts`

**Interfaces:**
- Consumes: Node built-ins only.
- Produces (used by Task 3):
  - `export const MIN_AGE_MS: number`, `export const FREE_MARGIN_BYTES: number`
  - `export interface ReplaceFacts { nowMs: number; mtimeMs: number; inboxBusy: boolean; inSources: boolean; includeUnimported: boolean }`
  - `export function replaceRefusals(f: ReplaceFacts): string[]`
  - `export function spaceRefusal(freeBytes: number, originalBytes: number, marginBytes?: number): string | null` (`marginBytes` defaults to `FREE_MARGIN_BYTES`)
  - `export function inboxIsBusy(inboxDir: string): boolean`
  - `export function sameInodeNames(original: string, dirs: string[]): string[]`
  - `export function replaceOriginal(original: string, linkDirs: string[], expected: { size: number; mtimeMs: number }): string[]` (returns the removed paths)

- [ ] **Step 1: Write the failing test**

Create `__tests__/archive-replace.test.ts`:

```ts
/** The guards of `archive-sources archive --replace`: plain values in, reasons out; and the unlink helper against real temp directories. */
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  FREE_MARGIN_BYTES, MIN_AGE_MS, inboxIsBusy, replaceOriginal, replaceRefusals, sameInodeNames, spaceRefusal, type ReplaceFacts,
} from '@/lib/archive-replace'

const GiB = 1024 ** 3

describe('replaceRefusals', () => {
  const quiet: ReplaceFacts = { nowMs: 100 * MIN_AGE_MS, mtimeMs: 0, inboxBusy: false, inSources: true, includeUnimported: false }

  test('a quiet inbox and an old file that is in ulp.sources: nothing to refuse', () => {
    expect(replaceRefusals(quiet)).toEqual([])
  })
  test('a busy inbox refuses', () => {
    expect(replaceRefusals({ ...quiet, inboxBusy: true })[0]).toMatch(/in flight/)
  })
  test('a file modified 9 minutes ago is refused, one modified 11 minutes ago is not', () => {
    const now = 1_000_000_000
    expect(replaceRefusals({ ...quiet, nowMs: now, mtimeMs: now - 9 * 60_000 })[0]).toMatch(/last 10 minutes/)
    expect(replaceRefusals({ ...quiet, nowMs: now, mtimeMs: now - 11 * 60_000 })).toEqual([])
  })
  test('a name that is not in ulp.sources is refused unless --include-unimported', () => {
    expect(replaceRefusals({ ...quiet, inSources: false })[0]).toMatch(/not in ulp\.sources/)
    expect(replaceRefusals({ ...quiet, inSources: false, includeUnimported: true })).toEqual([])
  })
  test('every reason is reported', () => {
    expect(replaceRefusals({ ...quiet, inboxBusy: true, mtimeMs: quiet.nowMs, inSources: false })).toHaveLength(3)
  })
})

describe('spaceRefusal', () => {
  test('needs 10 GiB plus twice the file', () => {
    expect(spaceRefusal(FREE_MARGIN_BYTES + 2 * GiB, GiB)).toBeNull()
    expect(spaceRefusal(FREE_MARGIN_BYTES + 2 * GiB - 1, GiB)).toMatch(/free space/)
    expect(spaceRefusal(5 * GiB, 0)).toMatch(/free space/)
  })
  test('the margin can be lowered (CI runners, tests)', () => {
    expect(spaceRefusal(3 * GiB, GiB, 0)).toBeNull()
    expect(spaceRefusal(3 * GiB, GiB, 2 * GiB)).toMatch(/free space/)    // a 2 GiB margin plus twice the file is 4 GiB
  })
})

describe('inboxIsBusy and replaceOriginal', () => {
  let root: string
  let pile: string
  let inbox: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-replace-')) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  beforeEach(() => {
    const t = mkdtempSync(join(root, 't-'))
    pile = join(t, 'pile'); inbox = join(t, 'inbox')
    for (const d of [pile, join(inbox, 'done'), join(inbox, 'failed'), join(inbox, 'processing')]) mkdirSync(d, { recursive: true })
  })

  test('an inbox with only sub-directories and an empty processing/ is quiet', () => {
    expect(inboxIsBusy(inbox)).toBe(false)
    expect(inboxIsBusy(join(inbox, 'does-not-exist'))).toBe(false)
  })
  test('a top-level file or something in processing/ makes it busy; done/ and failed/ do not', () => {
    writeFileSync(join(inbox, 'done', 'x.txt'), 'x'); writeFileSync(join(inbox, 'failed', 'y.txt'), 'y')
    expect(inboxIsBusy(inbox)).toBe(false)
    writeFileSync(join(inbox, 'processing', 'p.txt'), 'p')
    expect(inboxIsBusy(inbox)).toBe(true)
    rmSync(join(inbox, 'processing', 'p.txt'))
    writeFileSync(join(inbox, 'pending.txt'), 'q')
    expect(inboxIsBusy(inbox)).toBe(true)
  })

  test('removes the original and only the names that share its inode', () => {
    const orig = join(pile, 'o.txt')
    writeFileSync(orig, 'same bytes\n')
    linkSync(orig, join(inbox, 'done', 'o.txt'))                                // a hardlink of the original: goes
    writeFileSync(join(inbox, 'done', 'copy.txt'), 'same bytes\n')              // the same content, another inode: stays
    symlinkSync(orig, join(inbox, 'done', 'link.txt'))                          // a symlink: stays
    linkSync(orig, join(inbox, 'failed', 'o.txt'))                              // a hardlink in a directory we were not given: stays
    const st = statSync(orig)
    expect(sameInodeNames(orig, [join(inbox, 'done')])).toEqual([join(inbox, 'done', 'o.txt')])

    const removed = replaceOriginal(orig, [join(inbox, 'done')], { size: st.size, mtimeMs: st.mtimeMs })
    expect(removed.sort()).toEqual([join(inbox, 'done', 'o.txt'), orig].sort())
    expect(existsSync(orig)).toBe(false)
    expect(existsSync(join(inbox, 'done', 'o.txt'))).toBe(false)
    expect(readFileSync(join(inbox, 'done', 'copy.txt'), 'utf8')).toBe('same bytes\n')
    expect(lstatSync(join(inbox, 'done', 'link.txt')).isSymbolicLink()).toBe(true)   // dangling now, but it was never unlinked
    expect(readFileSync(join(inbox, 'failed', 'o.txt'), 'utf8')).toBe('same bytes\n')
  })

  test('removes nothing when the original changed since it was archived (size or modification time)', () => {
    const orig = join(pile, 'c.txt')
    writeFileSync(orig, 'abcdef')
    linkSync(orig, join(inbox, 'done', 'c.txt'))
    const { mtimeMs } = statSync(orig)
    expect(() => replaceOriginal(orig, [join(inbox, 'done')], { size: 5, mtimeMs })).toThrow(/changed while it was archived/)
    expect(() => replaceOriginal(orig, [join(inbox, 'done')], { size: 6, mtimeMs: mtimeMs - 1000 })).toThrow(/changed while it was archived/)
    expect(existsSync(orig)).toBe(true)
    expect(existsSync(join(inbox, 'done', 'c.txt'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-replace.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/archive-replace"`.

- [ ] **Step 3: Write the implementation**

Create `lib/archive-replace.ts`:

```ts
/**
 * The guards of `scripts/archive-sources.ts archive --replace` (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, Part 1).
 * Plain values in, reasons out, so every rule is tested without a ClickHouse or a real inbox. The one destructive helper, replaceOriginal, only unlinks a
 * file after checking that it is still the file that was archived, and then only the names that share its inode.
 */
import { lstatSync, readdirSync, statSync, unlinkSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** A file modified more recently than this may still be downloading. */
export const MIN_AGE_MS = 10 * 60_000
/** Free space that must remain besides the work itself. */
export const FREE_MARGIN_BYTES = 10 * 1024 ** 3

export interface ReplaceFacts {
  nowMs: number
  /** Modification time of the original. */
  mtimeMs: number
  /** A file is in flight: inbox/ holds a top-level file, or inbox/processing/ is not empty. */
  inboxBusy: boolean
  /** The name is in ulp.sources. */
  inSources: boolean
  includeUnimported: boolean
}

export function replaceRefusals(f: ReplaceFacts): string[] {
  const why: string[] = []
  if (f.inboxBusy) why.push('a file is in flight in the inbox (a top-level file in inbox/, or something in inbox/processing/)')
  if (f.nowMs - f.mtimeMs < MIN_AGE_MS) why.push('modified in the last 10 minutes (still being downloaded?)')
  if (!f.inSources && !f.includeUnimported) why.push('not in ulp.sources (not imported yet); use --include-unimported to replace it anyway')
  return why
}

const gib = (n: number) => (n / 1024 ** 3).toFixed(1)

/** The free space the work on one file needs: the margin (10 GiB) plus twice the original (an upper bound of twice its archive). Null when there is room. */
export function spaceRefusal(freeBytes: number, originalBytes: number, marginBytes = FREE_MARGIN_BYTES): string | null {
  const need = marginBytes + 2 * originalBytes
  return freeBytes < need ? `free space ${gib(freeBytes)} GiB is under the ${gib(need)} GiB this work needs (${gib(marginBytes)} GiB plus twice the file)` : null
}

/** True while a file is in flight: a top-level file in the inbox, or anything in inbox/processing/. A missing inbox is not busy. */
export function inboxIsBusy(inboxDir: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(inboxDir, { withFileTypes: true })
  } catch {
    return false
  }
  if (entries.some(e => e.isFile())) return true
  try {
    return readdirSync(join(inboxDir, 'processing')).length > 0
  } catch {
    return false
  }
}

/** The regular files in `dirs` (not symlinks) that are hardlinks of `original`: same device and inode. */
export function sameInodeNames(original: string, dirs: string[]): string[] {
  const st = statSync(original)
  const found: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const p = join(dir, n)
      try {
        const s = lstatSync(p)
        if (s.isFile() && s.ino === st.ino && s.dev === st.dev) found.push(p)
      } catch {
        /* vanished meanwhile */
      }
    }
  }
  return found
}

/**
 * Unlinks the hardlinks of `original` under `linkDirs`, then `original`. Throws, removing nothing, when the original no longer has the size and modification time it
 * had when it was archived. Returns the paths removed.
 */
export function replaceOriginal(original: string, linkDirs: string[], expected: { size: number; mtimeMs: number }): string[] {
  const st = statSync(original)
  if (st.size !== expected.size || st.mtimeMs !== expected.mtimeMs) {
    throw new Error('the original changed while it was archived; nothing was removed')
  }
  const links = sameInodeNames(original, linkDirs)
  for (const p of links) unlinkSync(p)
  unlinkSync(original)
  return [...links, original]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-replace.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Type-check and commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit`
Expected: no output.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib/archive-replace.ts __tests__/archive-replace.test.ts
git commit -m "feat(archive): the guards of --replace, with the unlink helper that checks the original first

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The CLI

**Files:**
- Create: `scripts/archive-sources.ts`
- Test: `__tests__/archive-sources-cli.test.ts`

**Interfaces:**
- Consumes (Task 1 and 2): `archiveFile`, `verifyEntry`, `readManifest`, `latestByName`, `appendManifest`, `openSource`, `defaultArchiveDir`, `sourcesSyncSql`, `ManifestEntry`; `MIN_AGE_MS`, `inboxIsBusy`, `replaceOriginal`, `replaceRefusals`, `spaceRefusal`.
- Produces: the command `tsx scripts/archive-sources.ts <archive|status|verify|restore|sources-sync>` (flags in the file header) and its summary lines, which the tests and the runbook rely on: `archived N, already archived N, too young N, replaced N, kept N, failed N; plaintext X GiB` and `names N (R replaced), archives A, plaintext X GiB, archive Y GiB, ratio Z`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/archive-sources-cli.test.ts`:

```ts
/**
 * The archive CLI run for real in a sandbox: fake sources, an archive directory, a fake repository with an inbox, and a fake `docker` that answers the ulp.sources
 * listing from a file and logs what it is given. Nothing here touches the real inbox, pile, archive or ClickHouse. Synthetic files only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'archive-sources.ts')

interface Box { root: string; src: string; arc: string; inbox: string; sources: string; dockerLog: string; env: NodeJS.ProcessEnv }
let box: Box | undefined
afterEach(() => { if (box) rmSync(box.root, { recursive: true, force: true }); box = undefined })

/** Sources of the given names and bodies, aged `ageMs`; an empty archive directory; an empty inbox; a docker that logs. */
function makeBox(files: Record<string, string>, ageMs = 60 * 60_000): Box {
  const root = mkdtempSync(join(tmpdir(), 'archive-cli-'))
  const src = join(root, 'src'), arc = join(root, 'arc'), repo = join(root, 'repo'), bin = join(root, 'bin')
  const inbox = join(repo, 'inbox')
  for (const d of [src, arc, join(inbox, 'done'), join(inbox, 'failed'), join(inbox, 'processing'), bin]) mkdirSync(d, { recursive: true })
  const when = new Date(Date.now() - ageMs)
  for (const [name, body] of Object.entries(files)) { const p = join(src, name); writeFileSync(p, body); utimesSync(p, when, when) }
  const sources = join(root, 'sources.jsonl'), dockerLog = join(root, 'docker.log')
  writeFileSync(sources, ''); writeFileSync(dockerLog, '')
  // docker exec [-i] <container> clickhouse-client [-n] [-q <sql>]: the listing comes from a file; a script on stdin (the last argument is -n) is logged
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ -n "$SHIM_FAIL" ]; then echo "Code: 210. DB::Exception: connection refused" >&2; exit 1; fi
sql="\${@: -1}"
case "$sql" in
  "SELECT filename FROM ulp.sources FORMAT JSONEachRow") cat "${sources}" ;;
  -n) cat >> "${dockerLog}" ;;
  *) echo "$sql" >> "${dockerLog}" ;;
esac
`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ULP_ARCHIVE_DIR: arc, ULP_REPO: repo, CH_CONTAINER: 'fake-clickhouse',
    ULP_ARCHIVE_FREE_MARGIN_BYTES: '0',    // a CI runner may have under 10 GiB free; the margin has its own unit test
  }
  return { root, src, arc, inbox, sources, dockerLog, env }
}

const run = (b: Box, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(TSX, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env: { ...b.env, ...extra }, timeout: 120_000 })
const manifest = (b: Box) => readFileSync(join(b.arc, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

describe('archive, status, verify, restore', () => {
  test('round-trips files and never overwrites a restore target', () => {
    box = makeBox({ 'a.txt': 'line one\nline two\n', 'b.txt': 'other\n' })
    const a = run(box, ['archive', '--src', box.src, '--workers', '2', '--no-sources'])
    expect(a.status).toBe(0)
    expect(a.stdout).toMatch(/archived 2, already archived 0, too young 0, replaced 0, kept 0, failed 0/)
    expect(readdirSync(box.arc).filter(n => n.endsWith('.zst'))).toHaveLength(2)
    expect(manifest(box)).toHaveLength(2)

    const st = run(box, ['status'])
    expect(st.status).toBe(0)
    expect(st.stdout).toMatch(/names 2 \(0 replaced\), archives 2/)

    const v = run(box, ['verify', '--all'])
    expect(v.status).toBe(0)
    expect(v.stdout).not.toMatch(/FAIL/)

    const to = join(box.root, 'restored.txt')
    const r = run(box, ['restore', 'a.txt', '--to', to])
    expect(r.status).toBe(0)
    expect(readFileSync(to, 'utf8')).toBe('line one\nline two\n')
    const again = run(box, ['restore', 'a.txt', '--to', to])
    expect(again.status).toBe(2)
    expect(again.stderr).toMatch(/refusing to overwrite/)
  })

  test('a second run archives nothing again', () => {
    box = makeBox({ 'a.txt': 'x\n', 'b.txt': 'y\n' })
    expect(run(box, ['archive', '--src', box.src, '--no-sources']).status).toBe(0)
    const second = run(box, ['archive', '--src', box.src, '--no-sources'])
    expect(second.stdout).toMatch(/archived 0, already archived 2/)
    expect(manifest(box)).toHaveLength(2)
  })

  test('a file modified a minute ago is skipped', () => {
    box = makeBox({ 'young.txt': 'x\n' }, 60_000)
    const r = run(box, ['archive', '--src', box.src, '--no-sources'])
    expect(r.stdout).toMatch(/archived 0, already archived 0, too young 1/)
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('--dry-run writes nothing', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const r = run(box, ['archive', '--src', box.src, '--dry-run'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/dry run/)
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('a missing archive directory is refused and not created', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const nope = join(box.root, 'nope')
    const r = run(box, ['archive', '--src', box.src, '--no-sources'], { ULP_ARCHIVE_DIR: nope })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/does not exist/)
    expect(existsSync(nope)).toBe(false)
  })

  test('verify fails (exit 1) on a damaged archive', () => {
    box = makeBox({ 'a.txt': 'some bytes that will be damaged\n'.repeat(20) })
    run(box, ['archive', '--src', box.src, '--no-sources'])
    const z = readdirSync(box.arc).find(n => n.endsWith('.zst')) as string
    const bytes = readFileSync(join(box.arc, z)); bytes[Math.floor(bytes.length / 2)] ^= 0xff
    writeFileSync(join(box.arc, z), bytes)
    const v = run(box, ['verify', '--all'])
    expect(v.status).toBe(1)
    expect(v.stdout).toMatch(/FAIL/)
  })
})

describe('--replace', () => {
  const body = 'secret one\nsecret two\n'

  test('removes the original and its inbox/done hardlink, nothing else, records replaced_at, and the archive restores the bytes', () => {
    box = makeBox({ 'r.txt': body })
    linkSync(join(box.src, 'r.txt'), join(box.inbox, 'done', 'r.txt'))
    writeFileSync(join(box.inbox, 'done', 'copy.txt'), body)
    writeFileSync(box.sources, JSON.stringify({ filename: 'r.txt' }) + '\n')
    const r = run(box, ['archive', '--src', box.src, '--replace', '--workers', '1'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/replaced 1, kept 0, failed 0/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(false)
    expect(existsSync(join(box.inbox, 'done', 'r.txt'))).toBe(false)
    expect(readFileSync(join(box.inbox, 'done', 'copy.txt'), 'utf8')).toBe(body)
    const lines = manifest(box)
    expect(lines).toHaveLength(2)
    expect(lines[1].replaced_at).toBeTruthy()
    expect(readFileSync(box.dockerLog, 'utf8')).toMatch(/ALTER TABLE ulp\.sources UPDATE size = transform\(filename, \['r\.txt'\]/)
    const to = join(box.root, 'back.txt')
    expect(run(box, ['restore', 'r.txt', '--to', to]).status).toBe(0)
    expect(readFileSync(to, 'utf8')).toBe(body)
  })

  test('keeps the original while a file is in flight in the inbox', () => {
    box = makeBox({ 'r.txt': body })
    writeFileSync(box.sources, JSON.stringify({ filename: 'r.txt' }) + '\n')
    writeFileSync(join(box.inbox, 'pending.txt'), 'x')
    const r = run(box, ['archive', '--src', box.src, '--replace', '--no-sources'])
    expect(r.stdout).toMatch(/kept r\.txt: a file is in flight/)
    expect(r.stdout).toMatch(/replaced 0, kept 1/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
  })

  test('keeps a name that is not in ulp.sources unless --include-unimported', () => {
    box = makeBox({ 'r.txt': body })
    const kept = run(box, ['archive', '--src', box.src, '--replace', '--no-sources'])
    expect(kept.stdout).toMatch(/kept r\.txt: not in ulp\.sources/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
    const forced = run(box, ['archive', '--src', box.src, '--replace', '--include-unimported', '--no-sources'])
    expect(forced.stdout).toMatch(/replaced 1/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(false)
  })

  test('without ClickHouse it refuses before touching anything', () => {
    box = makeBox({ 'r.txt': body })
    const r = run(box, ['archive', '--src', box.src, '--replace'], { SHIM_FAIL: '1' })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--replace needs ulp\.sources/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('an original that changed after an earlier archive run is not removed', () => {
    box = makeBox({ 'r.txt': body })
    writeFileSync(box.sources, JSON.stringify({ filename: 'r.txt' }) + '\n')
    expect(run(box, ['archive', '--src', box.src, '--no-sources']).status).toBe(0)
    const when = new Date(Date.now() - 3_600_000)
    writeFileSync(join(box.src, 'r.txt'), body.replace('one', 'ONE'))        // same size, different bytes
    utimesSync(join(box.src, 'r.txt'), when, when)
    const r = run(box, ['archive', '--src', box.src, '--replace', '--no-sources'])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/FAILED r\.txt: .*no longer matches its archive/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
  })
})

describe('sources-sync', () => {
  test('sends the identity statements for the archived names', () => {
    box = makeBox({ 's.txt': 'abc\n' })
    run(box, ['archive', '--src', box.src, '--no-sources'])
    const r = run(box, ['sources-sync'])
    expect(r.status).toBe(0)
    const log = readFileSync(box.dockerLog, 'utf8')
    expect(log).toMatch(/ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''/)
    expect(log).toMatch(/UPDATE size = transform\(filename, \['s\.txt'\], \[4\]/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-sources-cli.test.ts`
Expected: FAIL; the first spawn exits non-zero because `scripts/archive-sources.ts` does not exist (assertions on `status` / stdout fail).

- [ ] **Step 3: Write the CLI**

Create `scripts/archive-sources.ts`:

```ts
/**
 * The source archive tool (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md). It never prints a line of a file.
 *
 *   tsx scripts/archive-sources.ts archive --src <dir> [--out <archive dir>] [--workers 8] [--only a.txt,b.txt] [--replace] [--include-unimported] [--no-sources] [--dry-run]
 *   tsx scripts/archive-sources.ts status [--out <archive dir>]
 *   tsx scripts/archive-sources.ts verify [--out <archive dir>] [--all | --sample 3]
 *   tsx scripts/archive-sources.ts restore <name|id> --to <path> [--out <archive dir>]
 *   tsx scripts/archive-sources.ts sources-sync [--out <archive dir>]
 *
 * Run it from the repository root. Environment: ULP_ARCHIVE_DIR (default ~/ulp-archive; the directory must exist, the tool never creates it), ULP_REPO (the checkout
 * whose ./inbox --replace looks at; default the current directory), CH_CONTAINER (ulpsuite_clickhouse).
 *
 * --replace removes an original, and the inbox/done names that are hardlinks of it, only after the archive was decoded again and matched the original, and never
 * while a file is in flight in the inbox. A file modified in the last 10 minutes is skipped (it may still be downloading).
 */
import { fork, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createWriteStream, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  appendManifest, archiveFile, defaultArchiveDir, latestByName, openSource, readManifest, removeStaleParts, sourcesSyncSql, verifyEntry, type ManifestEntry,
} from '@/lib/source-archive'
import { FREE_MARGIN_BYTES, MIN_AGE_MS, inboxIsBusy, replaceOriginal, replaceRefusals, spaceRefusal } from '@/lib/archive-replace'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
const die = (message: string, code = 2): never => { console.error(message); process.exit(code) }

const ARCHIVE = defaultArchiveDir(flag('out') ? { ...process.env, ULP_ARCHIVE_DIR: flag('out') } : process.env)
const REPO = process.env.ULP_REPO ?? process.cwd()
const INBOX = join(REPO, 'inbox')
const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const GiB = 1024 ** 3
/** Free space that must remain besides the work itself (10 GiB); ULP_ARCHIVE_FREE_MARGIN_BYTES lowers it for tests and small CI runners. */
const MARGIN = process.env.ULP_ARCHIVE_FREE_MARGIN_BYTES !== undefined ? Number(process.env.ULP_ARCHIVE_FREE_MARGIN_BYTES) : FREE_MARGIN_BYTES

// ── ClickHouse through docker exec, like scripts/pile/*.sh ──────────────────────────────────────────

function clickhouse(sql: string): string {
  const r = spawnSync('docker', ['exec', CH, 'clickhouse-client', '-q', sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`clickhouse-client failed: ${(r.stderr ?? '').slice(0, 300)}`)
  return r.stdout
}

function clickhouseScript(script: string): void {
  const r = spawnSync('docker', ['exec', '-i', CH, 'clickhouse-client', '-n'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`clickhouse-client failed: ${(r.stderr ?? '').slice(0, 300)}`)
}

function listSourceNames(): Set<string> {
  const out = clickhouse('SELECT filename FROM ulp.sources FORMAT JSONEachRow')
  return new Set(out.split('\n').filter(l => l.trim() !== '').map(l => (JSON.parse(l) as { filename: string }).filename))
}

// ── the worker: one file at a time ──────────────────────────────────────────────────────────────────

interface Job { src: string; name: string; size: number; mtimeMs: number; replace: boolean; entry?: ManifestEntry }
interface Done { name: string; ok: boolean; fresh: boolean; entry?: ManifestEntry; problems: string[]; error?: string }

function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(8 << 20)
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function runJob(job: Job): Done {
  try {
    if (job.entry) {
      // archived by an earlier run: decode it again, and for --replace prove that the original still equals it
      const v = verifyEntry(ARCHIVE, job.entry)
      const problems = [...v.problems]
      if (job.replace && v.ok && sha256File(job.src) !== job.entry.sha256) problems.push('the original no longer matches its archive')
      return { name: job.name, ok: problems.length === 0, fresh: false, entry: job.entry, problems }
    }
    const entry = archiveFile(job.src, {
      archiveDir: ARCHIVE,
      name: job.name,
      lookupById: id => [...readManifest(ARCHIVE)].reverse().find(e => e.id === id),
    })
    const v = verifyEntry(ARCHIVE, entry)
    return { name: job.name, ok: v.ok, fresh: true, entry, problems: v.problems }
  } catch (err) {
    return { name: job.name, ok: false, fresh: false, problems: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function runPool(jobs: Job[], workers: number, canContinue: () => boolean, onDone: (job: Job, done: Done) => void): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, () => new Promise<void>(resolve => {
    const w = fork(process.argv[1], ['--worker'], { execArgv: process.execArgv, env: { ...process.env, ULP_ARCHIVE_DIR: ARCHIVE } })
    let current: Job | null = null
    w.on('exit', code => {
      if (current) onDone(current, { name: current.name, ok: false, fresh: false, problems: [], error: `worker exited (${code})` })
      current = null
      resolve()
    })
    const feed = () => {
      if (next >= jobs.length || !canContinue()) { w.kill(); return }
      current = jobs[next++]
      w.send(current)
    }
    w.on('message', (done: Done) => { const job = current as Job; current = null; onDone(job, done); feed() })
    feed()
  })))
}

// ── commands ────────────────────────────────────────────────────────────────────────────────────────

async function cmdArchive(): Promise<void> {
  const src = flag('src')
  if (!src) die('usage: archive --src <dir> [--out <dir>] [--workers 8] [--only a,b] [--replace] [--include-unimported] [--no-sources] [--dry-run]')
  if (!existsSync(ARCHIVE)) die(`the archive directory does not exist: ${ARCHIVE} (create it yourself; the tool never creates it)`)
  const stale = removeStaleParts(ARCHIVE)
  if (stale.length > 0) console.log(`removed ${stale.length} leftover .part file(s) of an interrupted run`)
  const replace = has('replace')
  const includeUnimported = has('include-unimported')
  const dry = has('dry-run')
  const only = flag('only')?.split(',')

  let inSources = new Set<string>()
  if (replace) {
    try { inSources = listSourceNames() } catch (e) { die(`--replace needs ulp.sources and ClickHouse did not answer: ${(e as Error).message}`) }
  }

  const latest = latestByName(readManifest(ARCHIVE))
  const now = Date.now()
  const jobs: Job[] = []
  const young: string[] = []
  let already = 0
  const names = readdirSync(src).filter(n => n.toLowerCase().endsWith('.txt') && (!only || only.includes(n))).sort()
  for (const name of names) {
    const path = join(src, name)
    const st = statSync(path)
    if (now - st.mtimeMs < MIN_AGE_MS) { young.push(name); continue }
    const prev = latest.get(name)
    const archivedBefore = !!prev && prev.size === st.size && existsSync(join(ARCHIVE, `${prev.id}.zst`))
    if (archivedBefore && !replace) { already++; continue }
    jobs.push({ src: path, name, size: st.size, mtimeMs: st.mtimeMs, replace, entry: archivedBefore ? prev : undefined })
  }

  const free = () => { const s = statfsSync(ARCHIVE); return Number(s.bavail) * Number(s.bsize) }
  const largest = jobs.reduce((m, j) => Math.max(m, j.entry ? 0 : j.size), 0)
  const space = largest > 0 ? spaceRefusal(free(), largest, MARGIN) : null
  if (space) die(`not starting: ${space}`)

  if (dry) {
    const busy = inboxIsBusy(INBOX)
    const wouldKeep = replace ? jobs.filter(j => replaceRefusals({ nowMs: now, mtimeMs: j.mtimeMs, inboxBusy: busy, inSources: inSources.has(j.name), includeUnimported }).length > 0).length : 0
    console.log(`dry run: ${jobs.length} to archive or confirm, ${already} already archived, ${young.length} too young${replace ? `, ${wouldKeep} would be kept` : ''}; nothing was written`)
    return
  }

  const stats = { archived: 0, replaced: 0, kept: 0, failed: 0, plain: 0 }
  const keep = (name: string, why: string) => { stats.kept++; console.log(`kept ${name}: ${why}`) }
  let halted = ''
  await runPool(jobs, Math.max(1, Number(flag('workers') ?? '8')), () => {
    const p = spaceRefusal(free(), 0, MARGIN)
    if (p) halted = p
    return !p
  }, (job, done) => {
    if (!done.ok || !done.entry) { stats.failed++; console.log(`FAILED ${job.name}: ${done.error ?? done.problems.join('; ')}`); return }
    if (done.fresh) { appendManifest(ARCHIVE, done.entry); stats.archived++ }
    stats.plain += done.entry.size
    if (!replace) return
    const why = replaceRefusals({ nowMs: Date.now(), mtimeMs: job.mtimeMs, inboxBusy: inboxIsBusy(INBOX), inSources: inSources.has(job.name), includeUnimported })
    if (why.length > 0) { keep(job.name, why.join('; ')); return }
    try {
      replaceOriginal(job.src, [join(INBOX, 'done')], { size: job.size, mtimeMs: job.mtimeMs })
      appendManifest(ARCHIVE, { ...done.entry, replaced_at: new Date().toISOString() })
      stats.replaced++
    } catch (e) {
      keep(job.name, (e as Error).message)
    }
  })

  if (halted) console.log(`stopped early: ${halted}`)
  console.log(`archived ${stats.archived}, already archived ${already}, too young ${young.length}, replaced ${stats.replaced}, kept ${stats.kept}, failed ${stats.failed}; plaintext ${(stats.plain / GiB).toFixed(2)} GiB`)
  if (!has('no-sources')) {
    try {
      clickhouseScript(sourcesSyncSql([...latestByName(readManifest(ARCHIVE)).values()]))
    } catch (e) {
      console.log(`ulp.sources was not updated (${(e as Error).message}); run sources-sync later`)
    }
  }
  process.exit(stats.failed > 0 ? 1 : 0)
}

function cmdStatus(): void {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  const plain = entries.reduce((a, e) => a + e.size, 0)
  const unique = new Map(entries.map(e => [e.id, e.archive_bytes]))
  const comp = [...unique.values()].reduce((a, b) => a + b, 0)
  console.log(`archive ${ARCHIVE}`)
  console.log(
    `names ${entries.length} (${entries.filter(e => e.replaced_at).length} replaced), archives ${unique.size}, plaintext ${(plain / GiB).toFixed(2)} GiB, ` +
    `archive ${(comp / GiB).toFixed(2)} GiB${comp > 0 ? `, ratio ${(plain / comp).toFixed(2)}x` : ''}`,
  )
  try {
    const names = listSourceNames()
    const have = new Set(entries.map(e => e.name))
    console.log(`in ulp.sources: ${names.size}, without an archive: ${[...names].filter(n => !have.has(n)).length}`)
  } catch {
    console.log('ulp.sources: not readable (no ClickHouse)')
  }
}

function cmdVerify(): void {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  const count = has('all') ? entries.length : Math.min(entries.length, Number(flag('sample') ?? '3'))
  const picked = has('all') ? entries : [...entries].sort(() => Math.random() - 0.5).slice(0, count)
  let bad = 0
  picked.forEach((e, i) => {
    const v = verifyEntry(ARCHIVE, e)
    if (v.ok) console.log(`ok   ${i + 1}/${picked.length} ${e.id.slice(0, 8)}`)
    else { bad++; console.log(`FAIL ${i + 1}/${picked.length} ${e.name}: ${v.problems.join('; ')}`) }
  })
  console.log(`verified ${picked.length}, failed ${bad}`)
  process.exit(bad > 0 ? 1 : 0)
}

async function cmdRestore(): Promise<void> {
  const ref = argv[1]
  const to = flag('to')
  if (!ref || ref.startsWith('--') || !to) die('usage: restore <name|id> --to <path> [--out <dir>]')
  if (existsSync(to)) die(`refusing to overwrite ${to}`)
  const s = openSource(ref, { archiveDir: ARCHIVE })
  if (s.origin.kind !== 'archive' || !s.entry) die(`${ref} is a plain file, not an archived name`)
  const entry = s.entry as ManifestEntry
  const part = `${to}.part`
  const hash = createHash('sha256')
  const source = s.stream()
  source.on('data', (c: Buffer) => hash.update(c))
  try {
    await pipeline(source, createWriteStream(part, { flags: 'wx' }))
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
  if (hash.digest('hex') !== entry.sha256) {
    rmSync(part, { force: true })
    die('the restored bytes do not match the manifest; nothing was written', 1)
  }
  renameSync(part, to)
  console.log(`restored ${entry.size} bytes to ${to} (sha256 matches the manifest)`)
}

function cmdSourcesSync(): void {
  const entries = [...latestByName(readManifest(ARCHIVE)).values()]
  clickhouseScript(sourcesSyncSql(entries))
  console.log(`ulp.sources: identity columns ensured, ${entries.length} archived name(s) mapped`)
}

async function main(): Promise<void> {
  if (argv[0] === '--worker') {
    process.on('message', (job: Job) => process.send?.(runJob(job)))
    return
  }
  switch (argv[0]) {
    case 'archive': return cmdArchive()
    case 'status': return cmdStatus()
    case 'verify': return cmdVerify()
    case 'restore': return cmdRestore()
    case 'sources-sync': return cmdSourcesSync()
    default: die('usage: archive-sources.ts archive|status|verify|restore|sources-sync (see the header of this file)')
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-sources-cli.test.ts`
Expected: PASS (all tests green; the file takes about 20-40 seconds because every test starts `tsx` and worker processes).

- [ ] **Step 5: Run the whole archive suite, then commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/source-archive.test.ts __tests__/archive-replace.test.ts __tests__/archive-sources-cli.test.ts && npx tsc --noEmit`
Expected: all three files pass; `tsc` prints nothing.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add scripts/archive-sources.ts __tests__/archive-sources-cli.test.ts
git commit -m "feat(archive): the archive CLI, archive / status / verify / restore / sources-sync, run for real in tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The readers learn the archive

**Files:**
- Modify: `lib/dropped-lines.ts`, `scripts/extract-dropped-lines.ts`, `scripts/parser-diff.ts`, `scripts/pile/verify-file.ts`
- Test: `__tests__/dropped-lines.test.ts` (one test added)

**Interfaces:**
- Consumes (Task 1): `openSource(ref, opts?) => Source`, `Source.size`, `Source.stream()`, `Source.readSlice()`, `Source.readAll()`, `defaultArchiveDir()`, `readManifest()`, `latestByName()`, `appendManifest()`, `archiveFile()`.
- Produces: `extractDroppedLines(srcPath, ...)` and the three scripts read a plain file or an archived name through the same call, so they still work after `--replace`. New flag `--from-archive` (`parser-diff.ts`, `extract-dropped-lines.ts`): the file list comes from the manifest.

- [ ] **Step 1: Write the failing test**

In `__tests__/dropped-lines.test.ts`, add this import below the existing imports:

```ts
import { appendManifest, archiveFile } from '@/lib/source-archive'
```

and append this block at the end of the file (it uses the file's own `dir` and `hardDrop`):

```ts
describe('extractDroppedLines reads the archive when the original is gone', () => {
  test('a source that exists only in the archive gives the same result', async () => {
    const arcDir = mkdtempSync(join(dir, 'arc-'))
    const body = 'https://shop.example.com.br/login:carlos:Secret4\njust a banner line\n'
    const p = join(dir, 'gone.txt')
    writeFileSync(p, body)
    appendManifest(arcDir, archiveFile(p, { archiveDir: arcDir }))
    rmSync(p)

    const before = process.env.ULP_ARCHIVE_DIR
    process.env.ULP_ARCHIVE_DIR = arcDir
    try {
      const stats = await extractDroppedLines(p, join(dir, 'gone.drop.zst'), hardDrop)
      expect(stats.lines).toBe(2)
      expect(stats.dropped).toBe(2)          // the T3 line outside the keep-list and the banner
      expect(stats.stored).toBe(0)
    } finally {
      if (before === undefined) delete process.env.ULP_ARCHIVE_DIR
      else process.env.ULP_ARCHIVE_DIR = before
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/dropped-lines.test.ts`
Expected: FAIL in the new test with `ENOENT` (the original is gone and `createReadStream` cannot read it); the older tests pass.

- [ ] **Step 3: Make `lib/dropped-lines.ts` read through `openSource`**

In `lib/dropped-lines.ts` replace the import of `createReadStream`:

```ts
import { createReadStream, createWriteStream } from 'node:fs'
```

with:

```ts
import { createWriteStream } from 'node:fs'
```

add below `import { repairUtf8Line } from '@/lib/ulp-utf8'`:

```ts
import { openSource } from '@/lib/source-archive'
```

and replace the read loop header:

```ts
  for await (const chunk of createReadStream(srcPath, { highWaterMark: 4 << 20 })) {
```

with:

```ts
  for await (const chunk of openSource(srcPath).stream()) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/dropped-lines.test.ts && npx tsc --noEmit`
Expected: PASS (the older tests too, they read plain files); `tsc` prints nothing.

- [ ] **Step 5: `scripts/extract-dropped-lines.ts`: `--from-archive`**

In `scripts/extract-dropped-lines.ts`, replace the import line

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
```

with:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
```

add below `import { extractDroppedLines } from '@/lib/dropped-lines'`:

```ts
import { defaultArchiveDir, latestByName, openSource, readManifest } from '@/lib/source-archive'
```

Replace the usage line in the header comment

```
 *   nice -n 19 npx tsx scripts/extract-dropped-lines.ts --src "$HOME/Downloads/AyuGram Desktop" --out /path/with/room [--workers 8] [--only a.txt,b.txt] [--limit N]
```

with:

```
 *   nice -n 19 npx tsx scripts/extract-dropped-lines.ts --src "$HOME/Downloads/AyuGram Desktop" --out /path/with/room [--workers 8] [--only a.txt,b.txt] [--limit N] [--from-archive]
 *   (--from-archive takes the names from the source archive manifest, ULP_ARCHIVE_DIR, and reads the archive when the original is gone; --src may then be omitted)
```

Replace these lines in `main()`:

```ts
    const src = flag('src')
    const out = flag('out')
    if (!src || !out) { console.error('usage: extract-dropped-lines.ts --src <dir> --out <dir> [--workers 8] [--only a,b] [--limit N]'); process.exit(2) }
    mkdirSync(out, { recursive: true })
    const only = flag('only')?.split(',')
    let names = readdirSync(src).filter(n => n.toLowerCase().endsWith('.txt') && (!only || only.includes(n))).sort()
```

with:

```ts
    const fromArchive = args.includes('--from-archive')
    const src = flag('src') ?? (fromArchive ? '.' : undefined)
    const out = flag('out')
    if (!src || !out) { console.error('usage: extract-dropped-lines.ts --src <dir> --out <dir> [--workers 8] [--only a,b] [--limit N] [--from-archive]'); process.exit(2) }
    mkdirSync(out, { recursive: true })
    const only = flag('only')?.split(',')
    const listed = fromArchive ? [...latestByName(readManifest(defaultArchiveDir())).keys()] : readdirSync(src)
    let names = listed.filter(n => n.toLowerCase().endsWith('.txt') && (!only || only.includes(n))).sort()
```

and replace `statSync(join(src, name)).size` in the manifest line with `openSource(join(src, name)).size`:

```ts
          appendFileSync(manifest, JSON.stringify({ name, size: openSource(join(src, name)).size, out: outFile, ...m.stats }) + '\n')
```

- [ ] **Step 6: `scripts/parser-diff.ts`: read through `openSource`**

In `scripts/parser-diff.ts` replace the `node:fs` import

```ts
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
```

with:

```ts
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
```

add below `import { repairUtf8Line } from '@/lib/ulp-utf8'`:

```ts
import { defaultArchiveDir, latestByName, openSource, readManifest, type Source } from '@/lib/source-archive'
```

Add a header usage line below the `--same-policy` line:

```
 *   npx tsx scripts/parser-diff.ts --baseline-ref 624b845 --from-archive --every 17     (the names come from the archive manifest, ULP_ARCHIVE_DIR; no originals needed)
```

Replace the file listing

```ts
  } else {
    files = args.slice(args.indexOf('--files') + 1).filter(a => !a.startsWith('--'))
  }
```

with:

```ts
  } else if (args.includes('--from-archive')) {
    const every = Number(flag('every') ?? '1')
    files = [...latestByName(readManifest(defaultArchiveDir())).keys()].filter(n => n.toLowerCase().endsWith('.txt')).sort().filter((_, i) => i % every === 0)
  } else {
    files = args.slice(args.indexOf('--files') + 1).filter(a => !a.startsWith('--'))
  }
```

Replace the whole `sampleLines` function (from `async function* sampleLines(path: string, size: number)` to its closing brace) with:

```ts
  async function* sampleLines(source: Source): AsyncGenerator<{ line: string; weight: number }> {
    const size = source.size
    if (everyLine) {
      const rl = createInterface({ input: source.stream().setEncoding('latin1'), crlfDelay: Infinity })
      for await (const line of rl) yield { line, weight: 1 }
      return
    }
    const whole = size <= 8 * 1048576
    const offsets = whole ? [0] : Array.from({ length: K }, (_, i) => Math.floor(i * (size - SLICE) / Math.max(1, K - 1)))
    const weight = whole ? 1 : size / (K * SLICE)
    if (whole) { for (const line of (await source.readAll()).toString('latin1').split('\n')) yield { line, weight }; return }
    for (const off of offsets) {
      const len = Math.min(SLICE, size - off)
      let text = (await source.readSlice(off, len)).toString('latin1')
      if (off > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1) }
      if (off + len < size) { const nl = text.lastIndexOf('\n'); text = nl === -1 ? '' : text.slice(0, nl) }
      for (const line of text.split('\n')) yield { line, weight }
    }
  }
```

Replace

```ts
  for (const path of files) {
    for await (const { line, weight } of sampleLines(path, statSync(path).size)) {
```

with:

```ts
  for (const path of files) {
    for await (const { line, weight } of sampleLines(openSource(path))) {
```

and in the `--stream` block replace

```ts
    for (const path of files.filter(f => statSync(f).size <= maxMb * 1048576)) {
```

with:

```ts
    for (const path of files.filter(f => openSource(f).size <= maxMb * 1048576)) {
```

and

```ts
      const bytes = readFileSync(path)
```

with:

```ts
      const bytes = await openSource(path).readAll()
```

- [ ] **Step 7: `scripts/pile/verify-file.ts`: read through `openSource`**

In `scripts/pile/verify-file.ts` delete the line `import { createReadStream } from 'node:fs'`, add `import { openSource } from '@/lib/source-archive'` below `import { DEFAULT_HARD_KEEP_COUNTRIES, parseIngestPolicy, makeHardDropPredicate } from '@/lib/ingest-filter'`, and replace

```ts
      const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
```

with:

```ts
      const stream = Readable.toWeb(openSource(path).stream()) as unknown as ReadableStream<Uint8Array>
```

- [ ] **Step 8: Check the scripts by hand (they have no unit tests of their own)**

Run (a smoke test of `parser-diff` and `verify-file`'s import path with a synthetic file, plain and then archived):

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
T=$(mktemp -d) && A=$(mktemp -d)
printf 'https://shop.example.test/login:alice@mail.test:Secret1\nshop.example.test : bob@mail.test : Secret3\nhttps://shop.example.com.br/login:carlos:Secret4\n' > "$T/p.txt"
touch -d '2 hours ago' "$T/p.txt"
npx tsx scripts/parser-diff.ts --baseline-ref HEAD --files "$T/p.txt" > "$T/plain.out" 2>&1
ULP_ARCHIVE_DIR="$A" CH_CONTAINER=none npx tsx scripts/archive-sources.ts archive --src "$T" --no-sources
rm "$T/p.txt"
ULP_ARCHIVE_DIR="$A" npx tsx scripts/parser-diff.ts --baseline-ref HEAD --files "$T/p.txt" > "$T/archived.out" 2>&1
diff "$T/plain.out" "$T/archived.out" && echo "IDENTICAL"
ULP_ARCHIVE_DIR="$A" npx tsx scripts/parser-diff.ts --baseline-ref HEAD --from-archive 2>&1 | head -3
rm -rf "$T" "$A"
```

Expected: `archived 1, ...` from the archive step, `IDENTICAL` from the diff, and a header line `baseline HEAD vs working tree, 1 files, ...` from the `--from-archive` run.

- [ ] **Step 9: Run the touched suites, type-check, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/dropped-lines.test.ts __tests__/parser-diff.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` prints nothing.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib/dropped-lines.ts scripts/extract-dropped-lines.ts scripts/parser-diff.ts scripts/pile/verify-file.ts __tests__/dropped-lines.test.ts
git commit -m "feat(archive): parser-diff, verify-file and the dropped-lines tools read an archived name like a file

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation, ignore files, the real-file rehearsal, and the merge

**Files:**
- Modify: `docs/pile-import-runbook.md`, `.gitignore`, `.dockerignore`
- Modify: `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md` (a Results section appended)

**Interfaces:**
- Consumes: everything above.
- Produces: the procedure the owner follows; measured numbers for the spec.

- [ ] **Step 1: Update the runbook**

In `docs/pile-import-runbook.md` replace this text:

```
5. Side copy: `nice -n 19 npx tsx scripts/extract-dropped-lines.ts --src "$HOME/Downloads/AyuGram Desktop" --out <dir with 10 GiB free> --workers 8`; compare the manifest
   totals with the importer's `skipped`.
6. Only then may the OWNER delete or move the originals (nobody else does), and the rollback images may be pruned one tag at a time (`docker rmi <tag>`; never an
   unscoped prune: the daemon is shared with another project).
```

with:

```
5. Archive the pile (the archive holds everything the old side copy of the dropped lines held, and the stored lines too): `mkdir -p ~/ulp-archive` once, then
   `nice -n 19 npx tsx scripts/archive-sources.ts archive --src "$HOME/Downloads/AyuGram Desktop" --workers 8` (about 17 minutes plus 2 of verification on an idle
   machine; it needs 10 GiB plus twice the largest file free, and it never runs while a pile run is writing to the same disk). `status` shows the names, the
   compression ratio and the `ulp.sources` rows that have no archive; `verify --all` decodes everything again. Nothing is removed by this step.
6. Only then may the OWNER run the same command with `--replace`: each original, and the `inbox/done` names that are hardlinks of it, is removed only after its archive
   was decoded again and matched, and never while a file is in flight in the inbox (see "The source archive" below). The rollback images may be pruned one tag at a
   time (`docker rmi <tag>`; never an unscoped prune: the daemon is shared with another project).
```

and insert this section before the line `## Rollback`:

```
## The source archive

`scripts/archive-sources.ts` keeps every source file as a verified zstd archive in `~/ulp-archive` (`ULP_ARCHIVE_DIR`; the directory must exist, the tool never creates it).
It is outside the repository and the Docker build context, and `manifest.jsonl` holds file names, so it is never committed. The archive lives on the same disk as
everything else: it protects against a parser or policy change, not against losing the disk (copy the directory to an external drive for that).

| Command | What it does |
|---|---|
| `archive --src <dir> [--workers 8] [--only a,b] [--dry-run]` | archive every `.txt`, verify each archive by decoding it again, record it in `manifest.jsonl`, then fill the identity columns of `ulp.sources` (`--no-sources` skips that) |
| `archive ... --replace [--include-unimported]` | also remove the original and its hardlinks under `inbox/done`, after confirming the archive against the original again |
| `status` | names, replaced, compression ratio, `ulp.sources` rows without an archive |
| `verify [--all \| --sample 3]` | decode archives again and compare with the manifest |
| `restore <name\|id> --to <path>` | write the original bytes back (never overwrites; checks the sha256) |
| `sources-sync` | (re)apply the `ulp.sources` identity columns for the archived names |

`--replace` keeps an original (and says why) while a file is in flight in the inbox, when the file was modified in the last 10 minutes, or when the name is not in
`ulp.sources` yet. `scripts/parser-diff.ts`, `scripts/pile/verify-file.ts` and `scripts/extract-dropped-lines.ts` read an archived name exactly like a file, so they keep
working after `--replace`. For a new batch: archive it first (without `--replace`), import, verify, and replace when you decide.
```

- [ ] **Step 2: Keep the archive out of git and out of the image**

In `.gitignore` replace

```
archive/
clickhouse-data/
```

with:

```
archive/
ulp-archive/
clickhouse-data/
```

In `.dockerignore` replace

```
inbox/
clickhouse-data/
```

with:

```
inbox/
ulp-archive/
clickhouse-data/
```

- [ ] **Step 3: The full gate**

Run:

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
nice -n 19 npx vitest run 2>&1 | tail -n 8
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json lib/source-archive.ts lib/archive-replace.ts lib/dropped-lines.ts __tests__/source-archive.test.ts __tests__/archive-replace.test.ts __tests__/archive-sources-cli.test.ts __tests__/dropped-lines.test.ts
```

Expected: the vitest summary shows no failed files (`Test Files ... passed`), `tsc` and `eslint` print nothing. Existing suites are unchanged by this plan; if a suite outside the archive fails, check whether it also fails on `main` before touching it.

- [ ] **Step 4: Rehearse on three real pile files (read-only on the originals)**

Run (a small file, a mid-size one and a ~1 GB one, picked by size rank; names containing a comma are skipped because `--only` splits on commas; no name is printed):

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
REH=$(mktemp -d /tmp/archive-rehearsal-XXXXXX) && mkdir "$REH/arc"
PILE="$HOME/Downloads/AyuGram Desktop"
NAMES=$(ls -S "$PILE"/*.txt | grep -v ',' | awk 'NR==40 || NR==150 || NR==400' | xargs -d '\n' -n1 basename | paste -sd, -)
echo "files picked: $(echo "$NAMES" | tr ',' '\n' | wc -l)"
/usr/bin/time -v nice -n 19 env ULP_ARCHIVE_DIR="$REH/arc" CH_CONTAINER=none npx tsx scripts/archive-sources.ts archive --src "$PILE" --only "$NAMES" --workers 3 --no-sources 2>&1 | grep -E "^archived|Elapsed|Maximum resident"
ULP_ARCHIVE_DIR="$REH/arc" CH_CONTAINER=none npx tsx scripts/archive-sources.ts status
ULP_ARCHIVE_DIR="$REH/arc" npx tsx scripts/archive-sources.ts verify --all | tail -n 1
echo "$NAMES" | tr ',' '\n' | while IFS= read -r n; do
  ULP_ARCHIVE_DIR="$REH/arc" npx tsx scripts/archive-sources.ts restore "$n" --to "$REH/restored.bin" > /dev/null && cmp -s "$REH/restored.bin" "$PILE/$n" && echo "restored: identical" || echo "restored: DIFFERENT"
  rm -f "$REH/restored.bin"
done
Z=$(ls "$REH/arc"/*.zst | head -1); zstd -dc "$Z" | cmp -s - "$PILE/$(echo "$NAMES" | cut -d, -f1)" && echo "zstd binary agrees (first file)" || echo "zstd binary: the first listed file is not the first archive; compare by id instead"
```

Expected: `files picked: 3`; `archived 3, already archived 0, too young 0, replaced 0, kept 0, failed 0; plaintext N GiB`; the elapsed time and peak memory; `names 3 (0 replaced), ... ratio 2.xx-4.xx x`; `verified 3, failed 0`; three lines `restored: identical`. The last line is a convenience check: if the first `.zst` is not the first listed file the message says so; compare by id (the first 24 hex characters of `sha256sum` of the original) instead.

Then remove the scratch directory: `rm -rf "$REH"`.

- [ ] **Step 5: Record the numbers in the spec and commit everything**

Append this section to `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`, replacing each `<...>` with the number printed by Step 4 (numbers only, no names):

```
## Results (archive rehearsal, <YYYY-MM-DD>)

Three pile files picked by size rank (<A> MB, <B> MB and <C> MB) were archived with 3 workers while a pile run was loading the machine: <P> GiB of plaintext became <Q> GiB of
archive (<R> x overall; <r1> x, <r2> x and <r3> x per file). The `archive` run took <S> s with a peak of <M> MB of memory; `verify --all` took <V> s; the three restored files
were identical to the originals (`cmp`), and the `zstd` binary decoded an archive file to the original.
```

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add docs/pile-import-runbook.md .gitignore .dockerignore docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md
git commit -m "docs(archive): the runbook procedure, ignore rules, and the measured rehearsal

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Merge (standing permission: merge to main and push once verified)**

Only when Steps 3 and 4 are clean and `git status` is empty:

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git fetch origin
git rebase origin/main            # expected: "Current branch reversible-pipeline is up to date" or a clean replay
npx tsc --noEmit && git push origin reversible-pipeline:main
```

Expected: the push is a fast-forward of `origin/main`; CI (npm ci, typecheck, test, lint, build) turns green on the new head. Nothing is deployed: this plan adds offline scripts, a library and docs only; the running app image does not change.

<!-- PLAN-END -->
