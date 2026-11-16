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
import { openReducedSource, runSwap, swapCandidates } from '@/lib/archive-swap'
import { appendReduced, reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import { appendManifest, archiveFile, latestByName, openSource, readManifest, type ManifestEntry } from '@/lib/source-archive'

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
