/**
 * Stage D of the reduced archive (docs/superpowers/plans/2026-11-16-reduced-archive-stage-d.md, task 1): which whole-file entries may be swapped for their reduced
 * entry, and the order in which one swap is done. Real tiny archives in a temp directory (archiveFile, appendManifest, appendReduced), invented lines only.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { isSwapped, reducedFor, runSwap, swapCandidates, swapOne, swapReport } from '@/lib/archive-swap'
import { appendReduced, reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import type { ShadowLine } from '@/lib/reduced-shadow'
import { SKIP_REASON } from '@/lib/reduced-shadow'
import { appendManifest, archiveFile, latestByName, readManifest, type ManifestEntry } from '@/lib/source-archive'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'swap-')); mkdirSync(reducedDir(dir), { recursive: true }) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Deterministic lines that do not compress to nothing. */
const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `https://site${i}.example/${tag}:user${i}@mail${(i * 7919) % 997}.example:pw${(i * 104729) % 100003}${tag}`).join('\n') + '\n'

function addWhole(name: string, text: string): ManifestEntry {
  const src = join(dir, `src-${name}`)
  writeFileSync(src, text)
  const e = archiveFile(src, { archiveDir: dir, name })
  appendManifest(dir, e)
  rmSync(src)
  return e
}

function addReduced(whole: ManifestEntry, text: string, over: Partial<ReducedEntry['of']> = {}): ReducedEntry {
  const src = join(dir, `red-${whole.name}`)
  writeFileSync(src, text)
  const e = archiveFile(src, { archiveDir: reducedDir(dir), name: whole.name })
  rmSync(src)
  const r: ReducedEntry = {
    ...e, of: { sha256: whole.sha256, size: whole.size, lines: whole.lines, ...over }, credentials: 1, kept_lines: e.lines, absent: 0, extra_known: 0,
    db_rows: 1, db_keys: 1, db_drift: 0, verified_at: '2026-11-16T00:00:00.000Z',
  }
  appendReduced(dir, r)
  return r
}

const okLine = (e: ManifestEntry): ShadowLine => ({ name: e.name, sha256: e.sha256, at: '2026-11-16T01:00:00Z', kind: 'pilot', ok: true })
const wholes = () => latestByName(readManifest(dir))
const select = (log: ShadowLine[], minSavingPct?: number) => swapCandidates({
  wholes: wholes(), reduced: readManifestReduced(), log, wholeOnDisk: e => existsSync(join(dir, `${e.id}.zst`)), minSavingPct,
})
const readManifestReduced = (): ReducedEntry[] => readManifest(reducedDir(dir)) as ReducedEntry[]

describe('swapCandidates', () => {
  test('an exact entry that saves at least 10% of its bytes on disk is eligible, with the bytes it frees', () => {
    const w = addWhole('a', lines(400, 'a'))
    const r = addReduced(w, lines(40, 'a'))
    const { eligible, left } = select([okLine(w)])
    expect(eligible.map(i => i.whole.name)).toEqual(['a'])
    expect(eligible[0].savedBytes).toBe(w.archive_bytes - r.archive_bytes)
    expect(left).toMatchObject({ 'below-threshold': 0, 'no-reduced': 0 })
  })

  test('an entry that saves less than 10% stays whole', () => {
    const text = lines(400, 'b')
    const w = addWhole('b', text)
    addReduced(w, text + lines(1, 'extra'))   // the reduced entry is not smaller
    const { eligible, left } = select([okLine(w)])
    expect(eligible).toHaveLength(0)
    expect(left['below-threshold']).toBe(1)
  })

  test('the threshold is a parameter', () => {
    const text = lines(400, 'c')
    const w = addWhole('c', text)
    addReduced(w, text.split('\n').slice(0, 300).join('\n') + '\n')   // saves about a quarter
    expect(select([okLine(w)], 10).eligible).toHaveLength(1)
    expect(select([okLine(w)], 60).eligible).toHaveLength(0)
  })

  test('a name with no reduced entry, a long-line name, a failed latest result and a name without its whole file each stay, with their own reason', () => {
    const none = addWhole('none', lines(50, 'n'))
    const longLine = addWhole('long', lines(50, 'l'))
    const failed = addWhole('failed', lines(200, 'f'))
    addReduced(failed, lines(10, 'f'))
    const gone = addWhole('gone', lines(200, 'g'))
    addReduced(gone, lines(10, 'g'))
    rmSync(join(dir, `${gone.id}.zst`))
    const log: ShadowLine[] = [
      { name: 'long', sha256: longLine.sha256, at: 'x', kind: 'pilot', ok: false, reason: SKIP_REASON },
      { name: 'failed', sha256: failed.sha256, at: 'x', kind: 'pilot', ok: false, reason: 'mismatch' },
      okLine(gone),
    ]
    const { eligible, left } = select(log)
    expect(eligible).toHaveLength(0)
    expect(left).toMatchObject({ 'no-reduced': 1, 'long-line': 1, 'not-exact': 1, 'no-whole-file': 1 })
    expect(none.name).toBe('none')
  })

  test('a failure that a later retry fixed does not count: the latest result of the bytes decides', () => {
    const w = addWhole('d', lines(300, 'd'))
    addReduced(w, lines(20, 'd'))
    const log: ShadowLine[] = [{ name: 'd', sha256: w.sha256, at: '1', kind: 'pilot', ok: false, reason: 'mismatch' }, { ...okLine(w), at: '2' }]
    expect(select(log).eligible).toHaveLength(1)
  })

  test('a reduced entry whose `of` is not this whole entry is not used', () => {
    const w = addWhole('e', lines(300, 'e'))
    addReduced(w, lines(20, 'e'), { sha256: 'f'.repeat(64) })
    const { eligible, left } = select([okLine(w)])
    expect(eligible).toHaveLength(0)
    expect(left['no-reduced']).toBe(1)
  })
})

describe('swapOne', () => {
  test('appends the manifest line first, then removes the whole file; the readers see a swapped entry that points at the reduced one', () => {
    const w = addWhole('a', lines(400, 'a'))
    const r = addReduced(w, lines(40, 'a'))
    const item = select([okLine(w)]).eligible[0]
    const out = swapOne({ archiveDir: dir, item, now: () => new Date('2026-11-17T00:00:00Z') })
    expect(out).toEqual({ ok: true, freedBytes: w.archive_bytes })
    expect(existsSync(join(dir, `${w.id}.zst`))).toBe(false)
    const latest = wholes().get('a')!
    expect(isSwapped(latest)).toBe(true)
    expect(latest).toMatchObject({ reduced_id: r.id, whole_removed_at: '2026-11-17T00:00:00.000Z', sha256: w.sha256, size: w.size })
    expect(reducedFor(dir, latest)?.id).toBe(r.id)
  })

  test('is a no-op the second time', () => {
    const w = addWhole('a', lines(400, 'a'))
    addReduced(w, lines(40, 'a'))
    const item = select([okLine(w)]).eligible[0]
    swapOne({ archiveDir: dir, item })
    const again = swapOne({ archiveDir: dir, item })
    expect(again).toEqual({ ok: true, freedBytes: 0 })
    expect(readManifest(dir).filter(e => e.name === 'a')).toHaveLength(2)
  })

  test('refuses, and removes nothing, when the reduced entry does not decode to what its manifest says', () => {
    const w = addWhole('a', lines(400, 'a'))
    const r = addReduced(w, lines(40, 'a'))
    writeFileSync(join(reducedDir(dir), `${r.id}.zst`), 'damaged')
    const item = select([okLine(w)]).eligible[0]
    const out = swapOne({ archiveDir: dir, item })
    expect(out.ok).toBe(false)
    expect(existsSync(join(dir, `${w.id}.zst`))).toBe(true)
    expect(isSwapped(wholes().get('a')!)).toBe(false)
  })

  test('a whole file that another name still uses stays on disk until the last of them is swapped', () => {
    const text = lines(400, 's')
    const first = addWhole('first', text)
    const second = addWhole('second', text)   // the same bytes: the archive shares one file
    expect(second.id).toBe(first.id)
    addReduced(first, lines(40, 's'))
    addReduced(second, lines(40, 's'))
    const items = select([okLine(first), okLine(second)]).eligible
    expect(items).toHaveLength(2)
    const a = swapOne({ archiveDir: dir, item: items.find(i => i.whole.name === 'first')! })
    expect(a).toEqual({ ok: true, freedBytes: 0 })
    expect(existsSync(join(dir, `${first.id}.zst`))).toBe(true)
    const b = swapOne({ archiveDir: dir, item: items.find(i => i.whole.name === 'second')! })
    expect(b).toEqual({ ok: true, freedBytes: first.archive_bytes })
    expect(existsSync(join(dir, `${first.id}.zst`))).toBe(false)
  })

  test('a crash between the manifest line and the unlink leaves a swapped entry whose orphan the next run removes', () => {
    const w = addWhole('a', lines(400, 'a'))
    addReduced(w, lines(40, 'a'))
    const item = select([okLine(w)]).eligible[0]
    swapOne({ archiveDir: dir, item })
    writeFileSync(join(dir, `${w.id}.zst`), 'orphan')   // as if the unlink never ran
    const again = swapOne({ archiveDir: dir, item })
    expect(again.ok).toBe(true)
    expect(existsSync(join(dir, `${w.id}.zst`))).toBe(false)
  })
})

describe('swapReport', () => {
  const report = (log: ShadowLine[], extra: { barBytes?: number; verify?: boolean } = {}) => swapReport({
    wholes: wholes(), reduced: readManifestReduced(), log, wholeOnDisk: e => existsSync(join(dir, `${e.id}.zst`)), archiveDir: dir, ...extra,
  })

  test('counts the names, the eligible and the left, and sums the bytes the removal frees', () => {
    const a = addWhole('a', lines(400, 'a'))
    const ra = addReduced(a, lines(40, 'a'))
    const b = addWhole('b', lines(300, 'b'))
    addReduced(b, lines(30, 'b'))
    addWhole('c', lines(50, 'c'))   // no reduced entry
    const r = report([okLine(a), okLine(b)])
    expect(r).toMatchObject({ names: 3, swapped: 0, eligible: 2 })
    expect(r.left['no-reduced']).toBe(1)
    expect(r.wholeBytesFreed).toBe(a.archive_bytes + wholes().get('b')!.archive_bytes)
    expect(r.reducedBytesKept).toBe(ra.archive_bytes + readManifestReduced().find(x => x.name === 'b')!.archive_bytes)
  })

  test('a file that a name outside the eligible set still uses frees nothing yet', () => {
    const text = lines(400, 's')
    const first = addWhole('first', text)
    addWhole('second', text)   // shares the file, has no reduced entry
    addReduced(first, lines(40, 's'))
    const r = report([okLine(first)])
    expect(r.eligible).toBe(1)
    expect(r.wholeBytesFreed).toBe(0)
  })

  test('the go/no-go lines: all eligible entries verify, the freed bytes reach the bar, the restore proof is left to the end-to-end run', () => {
    const a = addWhole('a', lines(400, 'a'))
    addReduced(a, lines(40, 'a'))
    const ok = report([okLine(a)], { barBytes: 1 })
    expect(ok.checks.map(c => [c.id, c.ok])).toEqual([['exact', true], ['freed', true], ['restore', null]])
    const low = report([okLine(a)], { barBytes: 10 ** 12 })
    expect(low.checks.find(c => c.id === 'freed')!.ok).toBe(false)
  })

  test('a reduced entry that no longer verifies turns the "exact" line off and is listed by id', () => {
    const a = addWhole('a', lines(400, 'a'))
    const r = addReduced(a, lines(40, 'a'))
    writeFileSync(join(reducedDir(dir), `${r.id}.zst`), 'damaged')
    const rep = report([okLine(a)], { barBytes: 1 })
    expect(rep.checks.find(c => c.id === 'exact')!.ok).toBe(false)
    expect(rep.verifyFailed).toEqual([r.id])
  })

  test('sums the drift of the eligible entries', () => {
    const a = addWhole('a', lines(400, 'a'))
    addReduced(a, lines(40, 'a'))
    const m = readManifestReduced()
    writeFileSync(join(reducedDir(dir), 'manifest.jsonl'), m.map(e => JSON.stringify({ ...e, db_drift: 7 })).join('\n') + '\n')
    const rep = report([okLine(a)], { barBytes: 1 })
    expect(rep).toMatchObject({ driftFiles: 1, driftKeys: 7 })
  })
})

describe('runSwap', () => {
  const setup = () => {
    const small = addWhole('small', lines(200, 'x'))
    addReduced(small, lines(20, 'x'))
    const big = addWhole('big', lines(600, 'y'))
    addReduced(big, lines(60, 'y'))
    const mid = addWhole('mid', lines(400, 'z'))
    addReduced(mid, lines(40, 'z'))
    const eligible = select([okLine(small), okLine(big), okLine(mid)]).eligible
    return { small, big, mid, eligible }
  }

  test('a dry run plans the smallest first and removes nothing', () => {
    const { small, eligible } = setup()
    const out = runSwap({ archiveDir: dir, eligible, apply: false })
    expect(out).toMatchObject({ planned: 3, swapped: 0, freedBytes: 0 })
    expect(existsSync(join(dir, `${small.id}.zst`))).toBe(true)
    expect(readManifest(dir)).toHaveLength(3)
  })

  test('--limit takes the smallest files; apply swaps them and checks each afterwards', () => {
    const { small, mid, big, eligible } = setup()
    const out = runSwap({ archiveDir: dir, eligible, apply: true, limit: 2 })
    expect(out).toMatchObject({ planned: 2, swapped: 2, checked: 2, problems: [] })
    expect(out.freedBytes).toBe(small.archive_bytes + mid.archive_bytes)
    expect(existsSync(join(dir, `${big.id}.zst`))).toBe(true)
    expect(isSwapped(wholes().get('small')!)).toBe(true)
    expect(isSwapped(wholes().get('big')!)).toBe(false)
  })

  test('--only names the files to swap', () => {
    const { big, eligible } = setup()
    const out = runSwap({ archiveDir: dir, eligible, apply: true, only: ['big'] })
    expect(out.swapped).toBe(1)
    expect(existsSync(join(dir, `${big.id}.zst`))).toBe(false)
  })

  test('stops at the first failure: nothing after it is touched', () => {
    const { small, mid, big, eligible } = setup()
    const r = readManifestReduced().find(x => x.name === 'mid')!
    writeFileSync(join(reducedDir(dir), `${r.id}.zst`), 'damaged')
    const out = runSwap({ archiveDir: dir, eligible, apply: true })
    expect(out.swapped).toBe(1)   // small was fine, mid failed, big was not tried
    expect(out.failed).toMatchObject({ id: mid.id })
    expect(existsSync(join(dir, `${small.id}.zst`))).toBe(false)
    expect(existsSync(join(dir, `${mid.id}.zst`))).toBe(true)
    expect(existsSync(join(dir, `${big.id}.zst`))).toBe(true)
  })

  test('a byte budget ends the run once enough was freed', () => {
    const { small, eligible } = setup()
    const out = runSwap({ archiveDir: dir, eligible, apply: true, batchBytes: 1 })
    expect(out.swapped).toBe(1)
    expect(out.freedBytes).toBe(small.archive_bytes)
  })
})
