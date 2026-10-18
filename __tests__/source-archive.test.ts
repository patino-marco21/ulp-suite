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
    expect(defaultArchiveDir({ ULP_ARCHIVE_DIR: '/somewhere' })).toBe('/somewhere')
    expect(defaultArchiveDir({ ULP_ARCHIVE_DIR: '  ' })).toMatch(/ulp-archive$/)
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
