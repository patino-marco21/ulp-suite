/**
 * The shadow run of the reduced archive (docs/superpowers/plans/2026-11-15-reduced-archive.md, task 6): which archived files get a reduced entry, in what order, and
 * how many results in a row were exact. Plain values in, answers out, so every rule is tested without a ClickHouse or an archive.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  GATE_FILES, appendShadowLog, consecutiveExact, pickCandidates, readShadowLog, readShadowStart, summarize, type ShadowLine,
} from '@/lib/reduced-shadow'
import { reducedArchiveMode } from '@/lib/archive-auto'
import type { ReducedEntry } from '@/lib/reduced-archive'
import type { ManifestEntry } from '@/lib/source-archive'

const whole = (name: string, created: string, size = 1000, sha = `sha-${name}`): ManifestEntry =>
  ({ name, id: `id-${name}`, size, sha256: sha, lines: 10, frames: [], archive_bytes: 300, archive_sha256: 'x', level: 12, created_at: created })
const reducedOf = (e: ManifestEntry, size = 100): ReducedEntry =>
  ({ ...e, id: `r-${e.name}`, size, archive_bytes: 30, of: { sha256: e.sha256, size: e.size, lines: e.lines }, credentials: 1, kept_lines: 1, absent: 0, extra_known: 0, db_rows: 1, db_keys: 1, db_drift: 0, verified_at: '2026-11-16T00:00:00Z' })
const line = (name: string, ok: boolean, at: string, kind: 'new' | 'pilot' = 'new', sha = `sha-${name}`, reason = 'mismatch'): ShadowLine =>
  ({ name, sha256: sha, at, kind, ok, ...(ok ? {} : { reason }) })

const START = '2026-11-16T00:00:00.000Z'
const names = (es: ManifestEntry[]) => es.map(e => e.name)

describe('reducedArchiveMode', () => {
  test('only "shadow" turns anything on; the rest, including "on" which is not built, is off', () => {
    expect(reducedArchiveMode({})).toEqual({ mode: 'off' })
    expect(reducedArchiveMode({ ULP_REDUCED_ARCHIVE: 'off' })).toEqual({ mode: 'off' })
    expect(reducedArchiveMode({ ULP_REDUCED_ARCHIVE: ' Shadow ' })).toEqual({ mode: 'shadow' })
    expect(reducedArchiveMode({ ULP_REDUCED_ARCHIVE: 'on' })).toEqual({ mode: 'off', note: expect.stringContaining('not built') })
    expect(reducedArchiveMode({ ULP_REDUCED_ARCHIVE: 'typo' })).toEqual({ mode: 'off', note: expect.stringContaining('typo') })
  })
})

describe('pickCandidates', () => {
  const base = {
    startedAt: START, inSources: new Set(['a', 'b', 'c', 'old1', 'old2', 'old3']), reduced: [] as ReducedEntry[], log: [] as ShadowLine[], mode: 'new' as const, limit: 10, archiveHolds: () => true,
  }
  const entries = [
    whole('b', '2026-11-16T02:00:00Z'), whole('a', '2026-11-16T01:00:00Z'), whole('c', '2026-11-16T03:00:00Z'),
    whole('old1', '2026-10-01T00:00:00Z'), whole('old2', '2026-10-02T00:00:00Z'), whole('old3', '2026-10-03T00:00:00Z'),
  ]

  test('new mode takes the files archived since the shadow began, oldest first, up to the limit', () => {
    expect(names(pickCandidates({ ...base, entries }))).toEqual(['a', 'b', 'c'])
    expect(names(pickCandidates({ ...base, entries, limit: 2 }))).toEqual(['a', 'b'])
  })

  test('a file that is not in ulp.sources (not imported yet), an empty one, and one whose archive file is gone are left alone', () => {
    const e = [...entries, whole('z', '2026-11-16T04:00:00Z'), whole('empty', '2026-11-16T05:00:00Z', 0)]
    const sources = new Set([...base.inSources, 'empty', 'gone'])
    const gone = whole('gone', '2026-11-16T06:00:00Z')
    expect(names(pickCandidates({ ...base, entries: [...e, gone], inSources: sources, archiveHolds: x => x.name !== 'gone' }))).toEqual(['a', 'b', 'c'])
  })

  test('a file skipped for a line over 1 MiB is never tried again, retry or not: its bytes will not change', () => {
    const log = [line('a', false, '2026-11-16T01:30:00Z', 'new', 'sha-a', 'long_line'), line('b', false, '2026-11-16T02:30:00Z')]
    expect(names(pickCandidates({ ...base, entries, log }))).toEqual(['c'])
    expect(names(pickCandidates({ ...base, entries, log, retryFailed: true }))).toEqual(['b', 'c'])
  })

  test('a file that already has a reduced entry of the same bytes is done; the same name with other bytes is not', () => {
    const a = entries.find(e => e.name === 'a')!
    expect(names(pickCandidates({ ...base, entries, reduced: [reducedOf(a)] }))).toEqual(['b', 'c'])
    const changed = entries.map(e => (e.name === 'a' ? { ...e, sha256: 'other-bytes' } : e))
    expect(names(pickCandidates({ ...base, entries: changed, reduced: [reducedOf(a)] }))).toEqual(['a', 'b', 'c'])
  })

  test('a file whose last attempt failed is not tried again each run, unless asked', () => {
    const log = [line('b', false, '2026-11-16T05:00:00Z')]
    expect(names(pickCandidates({ ...base, entries, log }))).toEqual(['a', 'c'])
    expect(names(pickCandidates({ ...base, entries, log, retryFailed: true }))).toEqual(['a', 'b', 'c'])
    // a later success of the same bytes clears it
    expect(names(pickCandidates({ ...base, entries, log: [line('b', false, '2026-11-16T05:00:00Z'), line('b', true, '2026-11-16T06:00:00Z')] }))).toEqual(['a', 'b', 'c'])
  })

  test('pilot mode takes older files only, small ones first among a seeded shuffle, and is the same each time', () => {
    const olds = [whole('old1', '2026-10-01T00:00:00Z', 5e9), whole('old2', '2026-10-02T00:00:00Z', 100), whole('old3', '2026-10-03T00:00:00Z', 200)]
    const p1 = pickCandidates({ ...base, entries: [...entries.filter(e => !e.name.startsWith('old')), ...olds], mode: 'pilot', limit: 2, maxBytes: 1e9, seed: 'x' })
    const p2 = pickCandidates({ ...base, entries: [...olds, ...entries.filter(e => !e.name.startsWith('old'))], mode: 'pilot', limit: 2, maxBytes: 1e9, seed: 'x' })
    expect(names(p1).sort()).toEqual(['old2', 'old3'])   // old1 is over the size cap
    expect(names(p1)).toEqual(names(p2))
  })
})

describe('pickCandidates, named files', () => {
  test('any mode ignores the shadow start and the size cap, and still skips what is done, empty or not imported', () => {
    const e = [whole('x', '2026-10-01T00:00:00Z', 5e9), whole('y', '2026-11-16T05:00:00Z'), whole('n', '2026-11-16T06:00:00Z')]
    const got = pickCandidates({ entries: e, reduced: [], log: [], inSources: new Set(['x', 'y']), startedAt: START, mode: 'any', limit: 10, archiveHolds: () => true })
    expect(names(got)).toEqual(['x', 'y'])
  })
})

describe('the gate', () => {
  test('counts the exact results in a row from the newest, new files only, and stops at the first failure', () => {
    const log: ShadowLine[] = [
      line('p1', false, '2026-11-16T00:10:00Z', 'pilot'),
      line('a', true, '2026-11-16T01:00:00Z'), line('b', false, '2026-11-16T02:00:00Z'),
      line('c', true, '2026-11-16T03:00:00Z'), line('d', true, '2026-11-16T04:00:00Z'),
      line('p2', false, '2026-11-16T05:00:00Z', 'pilot'),
      line('e', true, '2026-11-16T06:00:00Z'),
    ]
    expect(consecutiveExact(log)).toBe(3)   // e, d, c; the pilot failure does not break the run, b does
    expect(consecutiveExact([])).toBe(0)
    expect(GATE_FILES).toBe(200)
  })

  test('a new file with drift (a stored row the parser no longer reads from it) is not exact, even though its entry was written', () => {
    const log: ShadowLine[] = [line('a', true, '2026-11-16T01:00:00Z'), { ...line('b', true, '2026-11-16T02:00:00Z'), drift: 3 }, line('c', true, '2026-11-16T03:00:00Z')]
    expect(consecutiveExact(log)).toBe(1)
  })

  test('a file skipped for a line over 1 MiB neither counts nor ends the run: skipping it is the right result', () => {
    const log: ShadowLine[] = [
      line('a', true, '2026-11-16T01:00:00Z'), line('s', false, '2026-11-16T02:00:00Z', 'new', 'sha-s', 'long_line'), line('c', true, '2026-11-16T03:00:00Z'),
    ]
    expect(consecutiveExact(log)).toBe(2)
  })

  test('the same file tried again counts once, by its latest result', () => {
    const log = [line('a', false, '2026-11-16T01:00:00Z'), line('a', true, '2026-11-16T02:00:00Z'), line('b', true, '2026-11-16T03:00:00Z')]
    expect(consecutiveExact(log)).toBe(2)
  })
})

describe('summarize', () => {
  test('sizes, share and failures by reason, from the entries and the log', () => {
    const a = whole('a', '2026-11-16T01:00:00Z', 1000)
    const b = whole('b', '2026-11-16T02:00:00Z', 3000)
    const s = summarize({ entries: [a, b, whole('c', '2026-11-16T03:00:00Z', 5000)], reduced: [reducedOf(a, 100), reducedOf(b, 600)], log: [line('c', false, '2026-11-16T04:00:00Z')] })
    expect(s.reducedFiles).toBe(2)
    expect(s.wholeBytes).toBe(4000)
    expect(s.reducedBytes).toBe(700)
    expect(s.sharePct).toBeCloseTo(17.5, 5)
    expect(s.failuresByReason).toEqual({ mismatch: 1 })
    expect(s.driftFiles).toBe(0)
  })

  test('files skipped for a line over 1 MiB are counted apart from the failures', () => {
    const a = whole('a', '2026-11-16T01:00:00Z', 1000)
    const s = summarize({
      entries: [a, whole('c', '2026-11-16T03:00:00Z', 5000), whole('d', '2026-11-16T04:00:00Z', 5000)], reduced: [reducedOf(a, 100)],
      log: [line('c', false, '2026-11-16T04:00:00Z'), line('d', false, '2026-11-16T05:00:00Z', 'new', 'sha-d', 'long_line')],
    })
    expect(s.failuresByReason).toEqual({ mismatch: 1 })
    expect(s.skippedLongLine).toBe(1)
  })
})

describe('the log and the start marker', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shadow-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('lines are appended and read back; the start is written once and kept', () => {
    expect(readShadowLog(dir)).toEqual([])
    appendShadowLog(dir, line('a', true, '2026-11-16T01:00:00Z'))
    appendShadowLog(dir, line('b', false, '2026-11-16T02:00:00Z'))
    expect(readShadowLog(dir).map(l => l.name)).toEqual(['a', 'b'])
    const first = readShadowStart(dir, () => new Date('2026-11-16T08:00:00Z'))
    expect(first).toBe('2026-11-16T08:00:00.000Z')
    expect(readShadowStart(dir, () => new Date('2027-01-01T00:00:00Z'))).toBe(first)
  })
})
