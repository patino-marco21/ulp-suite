/**
 * The reduced archive writer (docs/superpowers/plans/2026-11-15-reduced-archive.md, tasks 4 and 5), over a real archive entry and a small in-memory stand-in for the database
 * side (ReduceDb). The SQL behind the real ReduceDb is proven on a real ClickHouse by scripts/e2e-reduced-archive.ts; what is proven here is the plumbing: which bytes are
 * kept, the proof, and that a failed proof leaves nothing behind. All data is invented.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  appendReduced, readReduced, reduceSource, reducedDir, type ClassifyResult, type LoadRow, type ProofCounts, type ReduceDb, type ReducedEntry,
} from '@/lib/reduced-archive'
import { appendManifest, archiveFile, latestByName, readManifest, archiveSource, type ManifestEntry } from '@/lib/source-archive'

let root: string
let archive: string
let work: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reduced-'))
  archive = join(root, 'archive')
  work = join(root, 'work')
  for (const d of [archive, work]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Archives `text` under `name` like the archive tool does and returns its manifest entry. */
function archived(name: string, text: string): ManifestEntry {
  const plain = join(root, `${name}.plain`)
  writeFileSync(plain, text, 'latin1')
  const entry = archiveFile(plain, { archiveDir: archive, name })
  appendManifest(archive, entry)
  rmSync(plain)
  return entry
}

const normKey = (url: string, email: string, password: string) =>
  `${url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase()}\0${email.toLowerCase()}\0${password}`

/** What the database holds: key -> the source files that have a row for it. */
type Holders = Map<string, Set<string>>
const holdersOf = (...rows: Array<[url: string, email: string, password: string, file: string]>): Holders => {
  const m: Holders = new Map()
  for (const [u, e, p, f] of rows) m.set(normKey(u, e, p), (m.get(normKey(u, e, p)) ?? new Set()).add(f))
  return m
}

/** The in-memory ReduceDb: the same questions the SQL answers, over a Map. */
function memoryDb(holders: Holders, log: string[] = []): ReduceDb & { cleaned: number; original: LoadRow[] } {
  const db = {
    cleaned: 0,
    original: [] as LoadRow[],
    classes: new Map<string, 'mine' | 'absent' | 'known'>(),
    async loadOriginal(rows: AsyncIterable<LoadRow[]>) {
      log.push('load')
      for await (const batch of rows) db.original.push(...batch)
      return db.original.length
    },
    async classify(name: string): Promise<ClassifyResult> {
      log.push('classify')
      const first = new Map<string, LoadRow>()
      for (const r of db.original) { const k = normKey(r.url, r.email, r.password); if (!first.has(k)) first.set(k, r) }
      const keep: number[] = []
      let mine = 0, absent = 0, known = 0
      for (const [k, r] of first) {
        const h = holders.get(k)
        const cls = !h ? 'absent' : h.has(name) ? 'mine' : 'known'
        db.classes.set(k, cls)
        if (cls === 'mine') mine++
        else if (cls === 'absent') absent++
        else known++
        if (cls !== 'known') keep.push(r.s, r.e)
      }
      return { keep: Float64Array.from(keep), distinct: first.size, mine, absent, known }
    },
    async prove(name: string, rows: AsyncIterable<LoadRow[]>): Promise<ProofCounts> {
      log.push('prove')
      const reduced = new Set<string>()
      for await (const batch of rows) for (const r of batch) reduced.add(normKey(r.url, r.email, r.password))
      const original = new Set(db.original.map(r => normKey(r.url, r.email, r.password)))
      const dbKeys = [...holders].filter(([, files]) => files.has(name)).map(([k]) => k)
      return {
        dbRows: dbKeys.length,
        dbKeys: dbKeys.length,
        notParsed: dbKeys.filter(k => !original.has(k)).length,
        missing: dbKeys.filter(k => original.has(k) && !reduced.has(k)).length,
        spurious: [...reduced].filter(k => !original.has(k)).length,
        extraKnown: [...reduced].filter(k => db.classes.get(k) === 'known').length,
        reducedKeys: reduced.size,
      }
    },
    async cleanup() { db.cleaned++; log.push('cleanup') },
  }
  return db
}

const T3 = (email: string) => email.startsWith('t3')
const NEW1 = 'https://new1.example.com:n1@x.test:pwnew1'
const OLD1 = 'https://old1.example.com:o1@x.test:pwold1'

const MIXED = [
  NEW1,                                    // new: kept
  OLD1,                                    // another file stored it first: dropped
  NEW1,                                    // repeat inside the file: dropped
  '',                                      // blank: dropped
  'free text that holds no credential',    // nobody explained it: kept
  'https://t3.example.com:t3user@x.test:pwt3333',   // tier-dropped: dropped
  'Host: https://blk.example.com', 'Login: blk@x.test', 'Password: blkpass1', '',    // a block, new: kept whole with its separator
  'https://p.example.com', 'pos@x.test', 'pospass1',                                   // a triple, new: kept whole
  'https://www.New1.example.com:N1@x.test:pwnew1',  // a look-alike of the first line: dropped as a repeat of that key
].join('\n') + '\n'

const MIXED_HOLDERS = () => holdersOf(
  ['https://new1.example.com', 'n1@x.test', 'pwnew1', 'this.txt'],
  ['https://old1.example.com', 'o1@x.test', 'pwold1', 'other.txt'],
  ['https://blk.example.com', 'blk@x.test', 'blkpass1', 'this.txt'],
  ['https://p.example.com', 'pos@x.test', 'pospass1', 'this.txt'],
)

describe('the reduced manifest', () => {
  test('lives in reduced/, and the whole-file readers never see it', () => {
    const whole = archived('this.txt', MIXED)
    const reduced = { ...whole, name: 'this.txt', id: 'ffff', of: { sha256: whole.sha256, size: whole.size, lines: whole.lines } } as unknown as ReducedEntry
    appendReduced(archive, reduced)
    expect(existsSync(join(reducedDir(archive), 'manifest.jsonl'))).toBe(true)
    expect(readReduced(archive).map(e => e.id)).toEqual(['ffff'])
    expect([...latestByName(readManifest(archive)).values()].map(e => e.id)).toEqual([whole.id])
  })

  test('is empty when nothing was reduced yet', () => {
    expect(readReduced(archive)).toEqual([])
  })
})

describe('reduceSource', () => {
  test('keeps what was new, what nobody holds and what nobody explained, whole records included, and drops the proven rest', async () => {
    const whole = archived('this.txt', MIXED)
    const db = memoryDb(MIXED_HOLDERS())
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work, hardDrop: T3 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const kept = await readAll(archive, out.entry)
    // a blank line stands where lines were left out; the block and the triple touch, so nothing is between them
    expect(kept).toBe([
      NEW1, '',
      'free text that holds no credential', '',
      'Host: https://blk.example.com', 'Login: blk@x.test', 'Password: blkpass1', '',
      'https://p.example.com', 'pos@x.test', 'pospass1',
    ].join('\n') + '\n')
    expect(out.entry.of).toEqual({ sha256: whole.sha256, size: whole.size, lines: whole.lines })
    expect(out.entry.credentials).toBe(3)
    expect(out.entry.extra_known).toBe(0)
    expect(out.stats).toMatchObject({ parsed: 6, distinct: 4, mine: 3, known: 1, absent: 0, repeats: 2 })
    expect(readReduced(archive)).toHaveLength(1)
    expect(db.cleaned).toBe(1)
    expect(readdirSync(work)).toEqual([])
  })

  test('a credential no row holds is kept and counted as absent', async () => {
    const text = NEW1 + '\n' + OLD1 + '\n'
    const whole = archived('this.txt', text)
    const db = memoryDb(holdersOf(['https://old1.example.com', 'o1@x.test', 'pwold1', 'other.txt']))
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(await readAll(archive, out.entry)).toBe(NEW1 + '\n')
    expect(out.stats.absent).toBe(1)
  })

  test('a file that added nothing and has no unexplained line reduces to an empty entry', async () => {
    const whole = archived('this.txt', OLD1 + '\n' + OLD1 + '\n')
    const db = memoryDb(holdersOf(['https://old1.example.com', 'o1@x.test', 'pwold1', 'other.txt']))
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entry.size).toBe(0)
    expect(out.entry.credentials).toBe(0)
    expect(await readAll(archive, out.entry)).toBe('')
  })

  test('a known line inside a block comes along with the block and is counted, and the proof still holds', async () => {
    const text = ['Host: https://blk.example.com', OLD1, 'Login: blk@x.test', 'Password: blkpass1', ''].join('\n') + '\n'
    const whole = archived('this.txt', text)
    const db = memoryDb(holdersOf(
      ['https://blk.example.com', 'blk@x.test', 'blkpass1', 'this.txt'],
      ['https://old1.example.com', 'o1@x.test', 'pwold1', 'other.txt'],
    ))
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(await readAll(archive, out.entry)).toBe(text)
    expect(out.entry.extra_known).toBe(1)
  })

  test('a stored row that the parser no longer reads from the file is drift: reported, not a loss', async () => {
    // The database holds a row of this file that today's parser does not make from any of its lines (an older parser stored it). Re-importing the whole file would not make it
    // either, so reducing the file loses nothing the parser sees; the lines behind such a row are kept or dropped by what today's parser makes of them.
    const whole = archived('this.txt', MIXED)
    const holders = MIXED_HOLDERS()
    holders.set(normKey('https://ghost.example.com', 'g@x.test', 'ghostpw1'), new Set(['this.txt']))
    const out = await reduceSource({ entry: whole, archiveDir: archive, db: memoryDb(holders), workDir: work, hardDrop: T3 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entry.db_drift).toBe(1)
    expect(out.entry.db_keys).toBe(4)
    expect(out.stats.proof).toMatchObject({ missing: 0, notParsed: 1 })
  })

  test('a credential the file stored that the reduced entry would lose fails the proof and leaves nothing behind', async () => {
    const whole = archived('this.txt', MIXED)
    const db = memoryDb(MIXED_HOLDERS())
    const classify = db.classify.bind(db)
    db.classify = async name => { const r = await classify(name); return { ...r, keep: r.keep.slice(2) } }   // a writer that forgot the first credential it should keep
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work, hardDrop: T3 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('mismatch')
    expect(out.stats?.proof).toMatchObject({ missing: 1 })
    expect(readReduced(archive)).toEqual([])
    expect(existsSync(reducedDir(archive)) ? readdirSync(reducedDir(archive)).filter(n => n.endsWith('.zst') || n.endsWith('.part')) : []).toEqual([])
    expect(readdirSync(work)).toEqual([])
    expect(db.cleaned).toBe(1)
  })

  test('ulp.sources says rows were imported but the database holds none under this name: the lines would have no keeper, so no entry', async () => {
    // e.g. the rows were stored under another name (a re-feed): every credential would look "known", and neither entry would keep the lines
    const text = NEW1 + '\n' + OLD1 + '\n'
    const whole = archived('this.txt', text)
    const holders = holdersOf(['https://new1.example.com', 'n1@x.test', 'pwnew1', 'other-name.txt'], ['https://old1.example.com', 'o1@x.test', 'pwold1', 'other.txt'])
    const out = await reduceSource({ entry: whole, archiveDir: archive, db: memoryDb(holders), workDir: work, imported: 1 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('mismatch')
    expect(out.detail).toContain('ulp.sources')
    expect(readReduced(archive)).toEqual([])
    // the same file, recorded as having imported nothing, is simply a file that added nothing
    const none = await reduceSource({ entry: whole, archiveDir: archive, db: memoryDb(holders), workDir: work, imported: 0 })
    expect(none.ok).toBe(true)
  })

  test('an archive that no longer hashes to its manifest line is refused as a source', async () => {
    const whole = archived('this.txt', MIXED)
    const bad = { ...whole, sha256: 'f'.repeat(64) }
    const db = memoryDb(MIXED_HOLDERS())
    const out = await reduceSource({ entry: bad, archiveDir: archive, db, workDir: work, hardDrop: T3 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('source')
    expect(readReduced(archive)).toEqual([])
    expect(db.cleaned).toBe(1)
  })

  test('a failure in the database step is reported, cleans up, and writes no entry', async () => {
    const whole = archived('this.txt', MIXED)
    const db = memoryDb(MIXED_HOLDERS())
    db.classify = async () => { throw new Error('clickhouse-client failed (exit 3)') }
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work, hardDrop: T3 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('error')
    expect(out.detail).toContain('exit 3')
    expect(readReduced(archive)).toEqual([])
    expect(db.cleaned).toBe(1)
    expect(readdirSync(work)).toEqual([])
  })

  test('lines kept on both sides of a dropped one do not join into a record the original never had', async () => {
    // A lone url, a known credential, then two plain lines. In the original the url is rejected (the next line is a credential, not a login). With the known line gone, the
    // url, the login-looking line and the word behind it would read as one url / login / password record.
    const text = ['https://lone.example.com', OLD1, 'login-like@x.test', 'someword1', ''].join('\n') + '\n'
    const whole = archived('this.txt', text)
    const db = memoryDb(holdersOf(['https://old1.example.com', 'o1@x.test', 'pwold1', 'other.txt']))
    const out = await reduceSource({ entry: whole, archiveDir: archive, db, workDir: work })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.stats.proof?.spurious).toBe(0)
    expect(out.entry.credentials).toBe(0)
    expect(await readAll(archive, out.entry)).toBe(['https://lone.example.com', '', 'login-like@x.test', 'someword1'].join('\n') + '\n')
  })

  test('the reduced entry is a real archive entry: it verifies, and its frames decode to what was kept', async () => {
    const whole = archived('this.txt', MIXED)
    const out = await reduceSource({ entry: whole, archiveDir: archive, db: memoryDb(MIXED_HOLDERS()), workDir: work, hardDrop: T3, frameBytes: 64, searchBytes: 64 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entry.frames.length).toBeGreaterThan(1)
    expect((await readAll(archive, out.entry)).split('\n').length).toBe(out.entry.lines + 1)
  })
})

async function readAll(archiveDir: string, entry: ManifestEntry): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of archiveSource(reducedDir(archiveDir), entry).stream()) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString('latin1')
}
