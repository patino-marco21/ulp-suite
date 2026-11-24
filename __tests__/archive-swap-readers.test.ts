/**
 * Stage D (docs/superpowers/plans/2026-11-16-reduced-archive-stage-d.md, task 3): the readers of the archive on a manifest that holds a swapped entry. Each one must
 * give its old answer when nothing is swapped (pinned by the existing tests of those readers) and a clear answer when something is: never reduced text as if it were the
 * original, never an error about a missing file that was removed on purpose.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readyToReplace } from '@/lib/archive-auto'
import { openReducedSource, runSwap, standInHolder, swapCandidates, verifyStandInHolder } from '@/lib/archive-swap'
import { createStandIn } from '@/lib/ledger-tools'
import { restoreStandIn } from '@/lib/stand-in-sweep'
import { appendReduced, reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import { appendManifest, archiveFile, isSwapped, latestByName, openSource, readManifest, type ManifestEntry } from '@/lib/source-archive'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'archive-sources.ts')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'swap-readers-')); mkdirSync(reducedDir(dir), { recursive: true }) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `https://site${i}.example/${tag}:user${i}@mail${(i * 7919) % 997}.example:pw${(i * 104729) % 100003}${tag}`).join('\n') + '\n'

function addWhole(name: string, text: string): ManifestEntry {
  const src = join(dir, `src-${name}`)
  writeFileSync(src, text)
  const e = archiveFile(src, { archiveDir: dir, name })
  appendManifest(dir, e)
  rmSync(src)
  return e
}

function addReduced(whole: ManifestEntry, text: string): ReducedEntry {
  const src = join(dir, `red-${whole.name}`)
  writeFileSync(src, text)
  const e = archiveFile(src, { archiveDir: reducedDir(dir), name: whole.name })
  rmSync(src)
  const r: ReducedEntry = {
    ...e, of: { sha256: whole.sha256, size: whole.size, lines: whole.lines }, credentials: 1, kept_lines: e.lines, absent: 0, extra_known: 0,
    db_rows: 1, db_keys: 1, db_drift: 0, verified_at: '2026-11-16T00:00:00.000Z',
  }
  appendReduced(dir, r)
  return r
}

/** One swapped name and one that stays whole. */
function swappedBox() {
  const text = lines(400, 'a')
  const w = addWhole('swapped.txt', text)
  const r = addReduced(w, lines(40, 'a'))
  const stays = addWhole('whole.txt', lines(30, 'w'))
  const eligible = swapCandidates({ wholes: latestByName(readManifest(dir)), reduced: [r], log: [], wholeOnDisk: e => existsSync(join(dir, `${e.id}.zst`)) }).eligible
  const out = runSwap({ archiveDir: dir, eligible, apply: true })
  expect(out).toMatchObject({ swapped: 1, problems: [] })
  return { w, r, stays, text }
}

const cli = (args: string[]) => spawnSync(TSX, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ULP_ARCHIVE_DIR: dir, CH_CONTAINER: 'fake-clickhouse' }, timeout: 120_000 })

describe('readyToReplace', () => {
  test('a swapped name in done/ is counted nowhere: there is nothing of it to archive again and nothing to replace on a reduced entry', () => {
    const { w, stays } = swappedBox()
    const done = join(dir, 'done'); mkdirSync(done)
    writeFileSync(join(done, 'swapped.txt'), 'x'.repeat(w.size))
    writeFileSync(join(done, 'whole.txt'), 'y'.repeat(stays.size))
    const r = readyToReplace(done, dir, latestByName(readManifest(dir)))
    expect(r).toEqual({ ready_files: 1, ready_bytes: stays.size, unarchived_files: 0, unarchived_bytes: 0, other_files: 0, other_bytes: 0, empty_files: 0 })
  })
})

describe('openSource', () => {
  test('refuses a swapped name, by name and by id, and says why; a name that stays whole still opens', async () => {
    const { w } = swappedBox()
    expect(() => openSource('swapped.txt', { archiveDir: dir })).toThrow(/swapped for its reduced entry/)
    expect(() => openSource(w.id, { archiveDir: dir })).toThrow(/swapped for its reduced entry/)
    expect((await openSource('whole.txt', { archiveDir: dir }).readAll()).length).toBeGreaterThan(0)
  })

  test('an id that a swapped name and a whole name share opens the whole one', async () => {
    const text = lines(400, 's')
    const first = addWhole('first.txt', text)
    const second = addWhole('second.txt', text)
    expect(second.id).toBe(first.id)
    const r = addReduced(first, lines(40, 's'))
    const eligible = swapCandidates({ wholes: latestByName(readManifest(dir)), reduced: [r], log: [], wholeOnDisk: () => true }).eligible
    runSwap({ archiveDir: dir, eligible, apply: true })   // only "first" has a reduced entry
    expect((await openSource(first.id, { archiveDir: dir }).readAll()).toString('utf8')).toBe(text)
  })

  test('openReducedSource reads the reduced text of a swapped name, and refuses a name that is not swapped', async () => {
    const { r } = swappedBox()
    const s = openReducedSource('swapped.txt', dir)
    expect(s.size).toBe(r.size)
    expect((await s.readAll()).toString('utf8')).toBe(lines(40, 'a'))
    expect(() => openReducedSource('whole.txt', dir)).toThrow(/not swapped/)
  })
})

describe('archive-sources on a manifest with a swapped entry', () => {
  test('status counts the swapped name and leaves its removed file out of the archive size', () => {
    swappedBox()
    const st = cli(['status'])
    expect(st.status).toBe(0)
    expect(st.stdout).toMatch(/names 2 \(0 replaced\), archives 1,/)
    expect(st.stdout).toMatch(/1 name\(s\) swapped for their reduced entry/)
  })

  test('verify checks the reduced entry of a swapped name instead of failing on the removed file', () => {
    swappedBox()
    const v = cli(['verify', '--all'])
    expect(v.status).toBe(0)
    expect(v.stdout).toMatch(/verified 2, failed 0/)
  })

  test('verify fails a swapped name whose reduced entry is damaged', () => {
    const { r } = swappedBox()
    writeFileSync(join(reducedDir(dir), `${r.id}.zst`), 'damaged')
    const v = cli(['verify', '--all'])
    expect(v.status).toBe(1)
    expect(v.stdout).toMatch(/FAIL .*swapped\.txt/)
  })

  test('restore refuses a swapped name, writes nothing, and --reduced writes the reduced text', () => {
    swappedBox()
    const to = join(dir, 'out.txt')
    const refused = cli(['restore', 'swapped.txt', '--to', to])
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toMatch(/swapped for its reduced entry/)
    expect(existsSync(to)).toBe(false)
    const reduced = cli(['restore', 'swapped.txt', '--to', to, '--reduced'])
    expect(reduced.status).toBe(0)
    expect(reduced.stdout).toMatch(/REDUCED entry/)
    expect(readFileSync(to, 'utf8')).toBe(lines(40, 'a'))
  })

  test('a plain restore of a name that stays whole is unchanged', () => {
    swappedBox()
    const to = join(dir, 'whole-out.txt')
    const ok = cli(['restore', 'whole.txt', '--to', to])
    expect(ok.status).toBe(0)
    expect(readFileSync(to, 'utf8')).toBe(lines(30, 'w'))
  })
})

describe('the stand-in gate', () => {
  test('standInHolder gives the entry of bytes the archive holds, whole or swapped for a reduced entry (the swapped one says which), and nothing for unknown bytes', () => {
    const { w, r, stays } = swappedBox()
    const holds = standInHolder(readManifest(dir))
    expect(holds(stays.sha256)?.id).toBe(stays.id)
    expect(isSwapped(holds(stays.sha256)!)).toBe(false)
    expect(holds(w.sha256)).toMatchObject({ name: 'swapped.txt', reduced_id: r.id })
    expect(isSwapped(holds(w.sha256)!)).toBe(true)
    expect(holds('0'.repeat(64))).toBeUndefined()
  })

  test('verifyStandInHolder decodes the whole entry of a whole name, and the reduced entry of a swapped one', () => {
    const { w, stays } = swappedBox()
    const holds = standInHolder(readManifest(dir))
    expect(verifyStandInHolder(dir, holds(stays.sha256)!)).toEqual({ ok: true, problems: [] })
    expect(verifyStandInHolder(dir, holds(w.sha256)!)).toEqual({ ok: true, problems: [] })
  })

  test('verifyStandInHolder refuses a swapped entry whose reduced file is gone, damaged, or was made from other bytes', () => {
    const { w, r } = swappedBox()
    const swapped = standInHolder(readManifest(dir))(w.sha256)!
    expect(verifyStandInHolder(dir, { ...swapped, reduced_id: 'f'.repeat(24) })).toMatchObject({ ok: false, problems: [expect.stringMatching(/reduced entry.*missing or was made from other bytes/)] })
    expect(verifyStandInHolder(dir, { ...swapped, sha256: 'e'.repeat(64) })).toMatchObject({ ok: false, problems: [expect.stringMatching(/other bytes/)] })
    const file = join(reducedDir(dir), `${r.id}.zst`)
    const bytes = readFileSync(file)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    writeFileSync(file, bytes)
    expect(verifyStandInHolder(dir, swapped).ok).toBe(false)
    rmSync(file)
    expect(verifyStandInHolder(dir, swapped)).toMatchObject({ ok: false, problems: [expect.stringMatching(/archive file missing/)] })
  })

  test('with nothing swapped it answers exactly as the plain sha map did', () => {
    const a = addWhole('a.txt', lines(30, 'a'))
    const b = addWhole('b.txt', lines(30, 'b'))
    const holds = standInHolder(readManifest(dir))
    expect(holds(a.sha256)).toEqual(a)
    expect(holds(b.sha256)).toEqual(b)
  })

  test('restoreStandIn refuses a swapped entry before it touches anything, and says where the original is', () => {
    const { w } = swappedBox()
    const path = join(dir, 'stand-in.txt')
    createStandIn(path, w.size, 1_700_000_000_000_000_000n)
    const swapped = latestByName(readManifest(dir)).get('swapped.txt')!
    expect(() => restoreStandIn(path, swapped, dir, 1_700_000_000_000_000_000n)).toThrow(/swapped for its reduced entry.*chat service/)
    expect(existsSync(`${path}.restore-${process.pid}`)).toBe(false)
  })
})
