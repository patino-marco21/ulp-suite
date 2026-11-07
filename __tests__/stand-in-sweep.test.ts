/**
 * The stand-in sweep on real temp files: a download whose bytes the ledger knows as ingested and the archive holds becomes a stand-in; everything else is left alone. Synthetic
 * content only; nothing here reads the owner's folders.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
    expect(hashCacheFile('/home/u/Desktop/ulp-ledger.tsv')).toBe('/home/u/Desktop/ulp-ledger-hashes.json')
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
