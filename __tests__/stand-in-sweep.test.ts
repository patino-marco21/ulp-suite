/**
 * The stand-in sweep on real temp files: a download whose bytes the ledger knows as ingested and the archive holds becomes a stand-in; everything else is left alone. Synthetic
 * content only; nothing here reads the owner's folders.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexLedger, isStandIn, type LedgerRow } from '@/lib/ledger-tools'
import { defaultDownloadDir, hashCacheFile, registryEntryFor, restoreStandIn, sweepDownloads, sweepEnabled, type SweepOptions } from '@/lib/stand-in-sweep'
import { appendManifest, archiveFile, verifyEntry, type ManifestEntry } from '@/lib/source-archive'

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const HOUR = 60 * 60_000

let root: string
let dl: string
let arc: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stand-in-sweep-'))
  dl = join(root, 'downloads'); arc = join(root, 'archive')
  mkdirSync(dl); mkdirSync(arc)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A download of `body`, modified `ageMs` ago (to the millisecond: the tests compare nanoseconds only against the file itself). */
function download(name: string, body: string, ageMs = HOUR): string {
  const p = join(dl, name)
  writeFileSync(p, body)
  const when = new Date(Date.now() - ageMs)
  utimesSync(p, when, when)
  return p
}
const ledgerRow = (name: string, body: string, o: Partial<LedgerRow> = {}): LedgerRow =>
  ({ kind: 'ledger', filename: name, size: Buffer.byteLength(body), sha256: sha(body), lines: 3, revision: 65, when: '2026-11-06 20:00:00', archived: true, ...o })
const entryFor = (name: string, body: string): ManifestEntry =>
  ({ name, id: sha(body).slice(0, 24), size: Buffer.byteLength(body), sha256: sha(body), lines: 3, frames: [], archive_bytes: 0, archive_sha256: '', level: 12, created_at: '2026-11-06T20:00:00.000Z' })

function options(rows: LedgerRow[], held: ManifestEntry[], o: Partial<SweepOptions> = {}): SweepOptions {
  const byHash = new Map(held.map(e => [e.sha256, e]))
  return {
    dir: dl, index: indexLedger(rows), holds: s => byHash.get(s), verify: () => ({ ok: true, problems: [] }),
    registry: join(root, 'standins.tsv'), hashCache: join(root, 'hashes.json'), minSize: 1, apply: true, ...o,
  }
}

describe('the sweep', () => {
  it('swaps an ingested, archived, old download for a stand-in: same size and time to the nanosecond, no blocks, and a line in the registry', async () => {
    const body = 'alpha\nbeta\ngamma\n'
    const p = download('one.txt', body)
    const before = statSync(p, { bigint: true })
    const r = await sweepDownloads(options([ledgerRow('one.txt', body)], [entryFor('one.txt', body)]))
    expect(r.swapped).toEqual(['one.txt'])
    const after = statSync(p, { bigint: true })
    expect(after.size).toBe(before.size)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.blocks).toBe(0n)
    expect(isStandIn(p)).toBe(true)
    expect(readdirSync(dl)).toEqual(['one.txt'])   // no temp or aside file left
    expect(registryEntryFor(join(root, 'standins.tsv'), p)).toEqual({ size: Number(before.size), mtimeNs: before.mtimeNs, sha256: sha(body) })
  })

  it('also recognises the bytes under another name: the ledger knows the content, not the name', async () => {
    const body = 'same\nbytes\nhere\n'
    download('renamed (2).txt', body)
    const r = await sweepDownloads(options([ledgerRow('original.txt', body)], [entryFor('original.txt', body)]))
    expect(r.swapped).toEqual(['renamed (2).txt'])
  })

  it('a dry run changes nothing and says what it would do', async () => {
    const body = 'a\nb\nc\n'
    const p = download('dry.txt', body)
    const r = await sweepDownloads(options([ledgerRow('dry.txt', body)], [entryFor('dry.txt', body)], { apply: false }))
    expect(r.wouldSwap).toEqual(['dry.txt'])
    expect(r.swapped).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe(body)
    expect(existsSync(join(root, 'standins.tsv'))).toBe(false)
    expect(existsSync(join(root, 'hashes.json'))).toBe(false)
  })

  it('leaves a file the ledger does not know, one ingested but not archived yet, and one the archive does not hold', async () => {
    const fresh = 'never seen\n'
    const ingested = 'ingested only\n'
    const flagged = 'ledger says archived, manifest disagrees\n'
    download('new.txt', fresh); download('kept.txt', ingested); download('flag.txt', flagged)
    const r = await sweepDownloads(options(
      [ledgerRow('kept.txt', ingested, { archived: false }), ledgerRow('flag.txt', flagged)],
      [entryFor('kept.txt', ingested)],   // the archive holds `ingested` but not `flagged`
    ))
    expect(r.swapped).toEqual([])
    expect(r.notIngested).toEqual(['new.txt'])
    expect(r.notArchivedYet.sort()).toEqual(['flag.txt', 'kept.txt'])
    for (const n of ['new.txt', 'kept.txt', 'flag.txt']) expect(isStandIn(join(dl, n))).toBe(false)
  })

  it('leaves a file modified in the last 10 minutes: it may still be downloading', async () => {
    const body = 'still growing\n'
    download('young.txt', body, 60_000)
    const r = await sweepDownloads(options([ledgerRow('young.txt', body)], [entryFor('young.txt', body)]))
    expect(r.waiting).toEqual(['young.txt'])
    expect(r.hashed).toBe(0)   // it is not even read
    expect(isStandIn(join(dl, 'young.txt'))).toBe(false)
  })

  it('a partial download of an archived file is never swapped: its hash is not the archive\'s', async () => {
    const whole = 'line one\nline two\nline three\n'
    download('partial.txt', whole.slice(0, 15))
    const r = await sweepDownloads(options([ledgerRow('partial.txt', whole)], [entryFor('partial.txt', whole)]))
    expect(r.swapped).toEqual([])
    expect(r.notIngested).toEqual(['partial.txt'])
    expect(readFileSync(join(dl, 'partial.txt'), 'utf8')).toBe(whole.slice(0, 15))
  })

  it('leaves the file when the archive does not verify, and reports it', async () => {
    const body = 'archive is damaged\n'
    const p = download('bad.txt', body)
    const r = await sweepDownloads(options([ledgerRow('bad.txt', body)], [entryFor('bad.txt', body)], { verify: () => ({ ok: false, problems: ['archive size is 5, the manifest says 9'] }) }))
    expect(r.swapped).toEqual([])
    expect(r.failed).toEqual([{ name: 'bad.txt', error: 'the archive does not verify: archive size is 5, the manifest says 9' }])
    expect(readFileSync(p, 'utf8')).toBe(body)
  })

  it('refuses a file that changes after it was checked, and leaves it whole', async () => {
    const body = 'checked, then it grew\n'
    const p = download('grows.txt', body)
    const r = await sweepDownloads(options([ledgerRow('grows.txt', body)], [entryFor('grows.txt', body)], {
      verify: () => { appendFileSync(p, 'more bytes arrive\n'); return { ok: true, problems: [] } },   // the download resumed while the archive was being decoded
    }))
    expect(r.swapped).toEqual([])
    expect(r.failed[0].name).toBe('grows.txt')
    expect(r.failed[0].error).toMatch(/changed after it was checked/)
    expect(readFileSync(p, 'utf8')).toBe(`${body}more bytes arrive\n`)
    expect(readdirSync(dl)).toEqual(['grows.txt'])
  })

  it('skips stand-ins, other extensions and files under the minimum size', async () => {
    const body = 'big enough\n'
    download('real.txt', body)
    download('notes.csv', body)
    download('tiny.txt', 'x')
    await sweepDownloads(options([ledgerRow('real.txt', body)], [entryFor('real.txt', body)], { minSize: 5 }))   // real.txt becomes a stand-in
    const r = await sweepDownloads(options([ledgerRow('real.txt', body)], [entryFor('real.txt', body)], { minSize: 5 }))
    expect(r.standIns).toBe(1)
    expect(r.swapped).toEqual([])
    expect(r.notIngested).toEqual([])   // notes.csv and tiny.txt were never looked at
    expect(isStandIn(join(dl, 'notes.csv'))).toBe(false)
  })

  it('remembers hashes by name, size and time: a file left alone is read once, and read again when it changes', async () => {
    const body = 'waiting for the owner\n'
    const p = download('waits.txt', body)
    const opts = (): SweepOptions => options([], [])
    expect((await sweepDownloads(opts())).hashed).toBe(1)
    expect((await sweepDownloads(opts())).hashed).toBe(0)
    appendFileSync(p, 'a line more\n')
    const old = new Date(Date.now() - HOUR); utimesSync(p, old, old)
    expect((await sweepDownloads(opts())).hashed).toBe(1)
    const cache = JSON.parse(readFileSync(join(root, 'hashes.json'), 'utf8')) as { v: number; files: Array<{ name: string; sha256: string }> }
    expect(cache.v).toBe(1)
    expect(cache.files.map(f => f.name)).toEqual(['waits.txt'])
    expect(cache.files[0].sha256).toBe(sha(`${body}a line more\n`))   // the entry of the changed file replaced the old one
  })
})

describe('settings', () => {
  it('the sweep is on unless ULP_STANDIN_SWEEP=off', () => {
    expect(sweepEnabled({})).toBe(true)
    expect(sweepEnabled({ ULP_STANDIN_SWEEP: 'off' })).toBe(false)
    expect(sweepEnabled({ ULP_STANDIN_SWEEP: ' OFF ' })).toBe(false)
    expect(sweepEnabled({ ULP_STANDIN_SWEEP: 'on' })).toBe(true)
  })
  it('the download folder and the hash cache have defaults and can be set', () => {
    expect(defaultDownloadDir({ ULP_DOWNLOAD_DIR: '/x/y' })).toBe('/x/y')
    expect(defaultDownloadDir({})).toMatch(/Downloads\/AyuGram Desktop$/)
    expect(hashCacheFile('/home/u/Desktop/ulp-pipeline/ledger.tsv')).toBe('/home/u/Desktop/ulp-pipeline/hashes.json')
  })
})

describe('restore', () => {
  /** A real archive of a real file, then the sweep, then the way back. */
  async function archived(name: string, body: string): Promise<{ path: string; entry: ManifestEntry; mtimeNs: bigint }> {
    const path = download(name, body)
    const entry = archiveFile(path, { archiveDir: arc, name, lookupById: () => undefined })
    expect(verifyEntry(arc, entry).ok).toBe(true)
    appendManifest(arc, entry)
    return { path, entry, mtimeNs: statSync(path, { bigint: true }).mtimeNs }
  }

  it('the whole way: sweep with the real archive check, then restore gives the bytes and the time back', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} of the file\n`).join('')
    const { path, entry, mtimeNs } = await archived('round trip.txt', body)
    const r = await sweepDownloads(options([ledgerRow('round trip.txt', body)], [entry], { verify: e => verifyEntry(arc, e) }))
    expect(r.swapped).toEqual(['round trip.txt'])
    expect(isStandIn(path)).toBe(true)

    restoreStandIn(path, entry, arc, mtimeNs)
    expect(readFileSync(path, 'utf8')).toBe(body)
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(mtimeNs)
    expect(isStandIn(path)).toBe(false)
    expect(readdirSync(dl)).toEqual(['round trip.txt'])
  })

  it('refuses a path that is not a stand-in, and leaves no temp file behind', async () => {
    const body = 'real file, not a stand-in\n'
    const { path, entry, mtimeNs } = await archived('real.txt', body)
    expect(() => restoreStandIn(path, entry, arc, mtimeNs)).toThrow(/not a stand-in/)
    expect(readFileSync(path, 'utf8')).toBe(body)
  })

  it('leaves the stand-in when the archive does not decode to the manifest', async () => {
    const body = 'x\ny\nz\n'
    const { path, entry, mtimeNs } = await archived('lying.txt', body)
    await sweepDownloads(options([ledgerRow('lying.txt', body)], [entry]))
    expect(isStandIn(path)).toBe(true)
    expect(() => restoreStandIn(path, { ...entry, sha256: sha('something else') }, arc, mtimeNs)).toThrow(/do not match the manifest/)
    expect(isStandIn(path)).toBe(true)
    expect(readdirSync(dl)).toEqual(['lying.txt'])   // the temp file is gone
  })
})

// ── moving a finished new download ───────────────────────────────────────────────────────────────────────

describe('moving a finished new download into the inbox', () => {
  let inbox: string
  beforeEach(() => {
    inbox = join(root, 'inbox')
    for (const d of ['', 'processing', 'done', 'held', 'failed']) mkdirSync(join(inbox, d), { recursive: true })
  })
  const withInbox = (rows: LedgerRow[], held: ManifestEntry[], o: Partial<SweepOptions> = {}): SweepOptions => options(rows, held, { inbox, openFiles: () => new Map(), minAgeMs: 180_000, ...o })

  it('moves it, leaves a stand-in with the same size and time to the nanosecond and no blocks, and registers it', async () => {
    const body = 'new\nlines\nhere\n'
    const p = download('fresh.txt', body)
    const before = statSync(p, { bigint: true })
    const r = await sweepDownloads(withInbox([], []))
    expect(r.moved).toEqual(['fresh.txt'])
    expect(readFileSync(join(inbox, 'fresh.txt'), 'utf8')).toBe(body)   // the whole file arrived
    const after = statSync(p, { bigint: true })
    expect(after.size).toBe(before.size)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.blocks).toBe(0n)
    expect(registryEntryFor(join(root, 'standins.tsv'), p)).toEqual({ size: Number(before.size), mtimeNs: before.mtimeNs, sha256: sha(body) })
    // a second pass finds a stand-in and neither hashes nor moves anything
    const again = await sweepDownloads(withInbox([], []))
    expect(again).toMatchObject({ moved: [], standIns: 1, hashed: 0 })
  })

  it('does not move a file another program still has open, however long it has been quiet', async () => {
    const p = download('growing.txt', 'half a file\n')
    const r = await sweepDownloads(withInbox([], [], { openFiles: () => new Map([[p, [4242]]]) }))
    expect(r.moved).toEqual([])
    expect(r.pending).toEqual([expect.objectContaining({ name: 'growing.txt', state: 'downloading' })])
    expect(readFileSync(p, 'utf8')).toBe('half a file\n')
    expect(readdirSync(inbox).filter(n => n.endsWith('.txt'))).toEqual([])
  })

  it('looks again right before the move: a file opened while it was being hashed stays', async () => {
    const p = download('reopened.txt', 'data\n')
    let calls = 0
    const r = await sweepDownloads(withInbox([], [], { openFiles: () => (++calls === 1 ? new Map() : new Map([[p, [77]]])) }))
    expect(r.moved).toEqual([])
    expect(r.pending[0]).toMatchObject({ name: 'reopened.txt', state: 'downloading' })
    expect(readFileSync(p, 'utf8')).toBe('data\n')
  })

  it('a file that grew between the hash and the move stays where it is', async () => {
    const p = download('grew.txt', 'first part\n')
    let calls = 0
    const r = await sweepDownloads(withInbox([], [], { openFiles: () => { if (++calls === 2) appendFileSync(p, 'more\n'); return new Map() } }))
    expect(r.moved).toEqual([])
    expect(r.changed).toEqual(['grew.txt'])
    expect(readFileSync(p, 'utf8')).toBe('first part\nmore\n')
  })

  it('waits for the quiet period, and for the bytes of an interrupted download to be dealt with', async () => {
    download('just-now.txt', 'x\n', 5_000)
    const hole = download('cut.txt', 'head\n')
    truncateSync(hole, 8 * 1024 * 1024)
    const long = new Date(Date.now() - HOUR); utimesSync(hole, long, long)   // truncating set the time to now; the download stopped an hour ago
    const r = await sweepDownloads(withInbox([], []))
    expect(r.moved).toEqual([])
    expect(r.pending.map(x => [x.name, x.state]).sort()).toEqual([['cut.txt', 'interrupted'], ['just-now.txt', 'settling']])
  })

  it('a dry run says what it would move and changes nothing', async () => {
    const p = download('dry.txt', 'content\n')
    const r = await sweepDownloads(withInbox([], [], { apply: false }))
    expect(r.wouldMove).toEqual(['dry.txt'])
    expect(r.moved).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe('content\n')
    expect(existsSync(join(inbox, 'dry.txt'))).toBe(false)
    expect(existsSync(join(root, 'standins.tsv'))).toBe(false)
  })

  it('refuses a name that is already in the inbox or one of its folders, and leaves the download', async () => {
    const p = download('taken.txt', 'download\n')
    writeFileSync(join(inbox, 'done', 'taken.txt'), 'an earlier file\n')
    const r = await sweepDownloads(withInbox([], []))
    expect(r.moved).toEqual([])
    expect(r.refused).toEqual([{ name: 'taken.txt', reason: expect.stringMatching(/already in the inbox/) }])
    expect(readFileSync(p, 'utf8')).toBe('download\n')
    expect(readFileSync(join(inbox, 'done', 'taken.txt'), 'utf8')).toBe('an earlier file\n')
  })

  it('bytes the ledger knows are swapped for a stand-in, not moved again; bytes ingested but not archived yet stay', async () => {
    const a = 'ingested and archived\n', b = 'ingested, archive not yet\n'
    const pa = download('a.txt', a), pb = download('b.txt', b)
    const r = await sweepDownloads(withInbox([ledgerRow('a.txt', a), ledgerRow('b.txt', b, { archived: false })], [entryFor('a.txt', a)]))
    expect(r.swapped).toEqual(['a.txt'])
    expect(r.notArchivedYet).toEqual(['b.txt'])
    expect(r.moved).toEqual([])
    expect(isStandIn(pa)).toBe(true)
    expect(readFileSync(pb, 'utf8')).toBe(b)
    expect(readdirSync(inbox).filter(n => n.endsWith('.txt'))).toEqual([])
  })

  it('without an inbox nothing is moved: a new file is left and counted as not ingested (the by-hand sweep)', async () => {
    const p = download('lonely.txt', 'x\n')
    const r = await sweepDownloads(options([], [], { openFiles: () => new Map() }))
    expect(r.notIngested).toEqual(['lonely.txt'])
    expect(readFileSync(p, 'utf8')).toBe('x\n')
  })

  it('THE CASE THAT MATTERS: a file the client is still writing is not moved; once it closes it, the whole file arrives', async () => {
    const p = join(dl, 'streaming.txt')
    writeFileSync(p, 'line 1\n')
    const t = new Date(Date.now() - HOUR); utimesSync(p, t, t)
    // a real second process stands in for the client: it holds the file open and keeps writing lines into it
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(p)}, 'a');
      process.stdout.write('open\\n');
      process.stdin.on('data', d => { if (String(d).includes('write')) { fs.writeSync(fd, 'line 2\\nline 3\\n'); process.stdout.write('wrote\\n') } if (String(d).includes('close')) { fs.closeSync(fd); process.exit(0) } })`], { stdio: ['pipe', 'pipe', 'inherit'] })
    const said = (word: string) => new Promise<void>(resolve => { const on = (d: Buffer) => { if (String(d).includes(word)) { child.stdout.off('data', on); resolve() } }; child.stdout.on('data', on) })
    await said('open')
    // the real open-file scan, not a stub
    const during = await sweepDownloads(options([], [], { inbox, minAgeMs: 0 }))
    expect(during.moved).toEqual([])
    expect(during.pending[0]).toMatchObject({ name: 'streaming.txt', state: 'downloading' })
    child.stdin.write('write\n'); await said('wrote')                 // the client goes on writing
    child.stdin.write('close\n'); await new Promise<void>(resolve => child.once('exit', () => resolve()))
    const old = new Date(Date.now() - HOUR); utimesSync(p, old, old)  // the bytes are written; the quiet period is not what this test is about
    const after = await sweepDownloads(options([], [], { inbox, minAgeMs: 0 }))
    expect(after.moved).toEqual(['streaming.txt'])
    expect(readFileSync(join(inbox, 'streaming.txt'), 'utf8')).toBe('line 1\nline 2\nline 3\n')   // nothing written after the first look was lost
  })
})
