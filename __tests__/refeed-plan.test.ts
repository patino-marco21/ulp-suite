import { describe, expect, test } from 'vitest'
import { PARSER_REVISION } from '@/lib/parser-version'
import { refeedNameFor, type LedgerRow } from '@/lib/ledger-tools'
import { planRefeeds } from '@/lib/refeed-plan'
import type { ManifestEntry } from '@/lib/source-archive'

const sha = (c: string): string => c.repeat(64).slice(0, 64)
const row = (filename: string, s: string, revision: number, over: Partial<LedgerRow> = {}): LedgerRow =>
  ({ kind: 'ledger', filename, size: 1000, sha256: s, lines: 10, revision, when: '2026-10-20 10:00:00', archived: true, ...over })
const entry = (name: string, s: string, size = 1000): ManifestEntry =>
  ({ name, id: s.slice(0, 24), size, sha256: s, lines: 10, frames: [], archive_bytes: 1, archive_sha256: '', level: 12, created_at: '2026-10-20T10:00:00Z' })
const none = new Set<string>()

describe('refeedNameFor', () => {
  test('puts the marker before the extension, or at the end when there is none', () => {
    expect(refeedNameFor('a b.txt', 65)).toBe('a b (refeed v6.5).txt')
    expect(refeedNameFor('noext', 65)).toBe('noext (refeed v6.5)')
    expect(refeedNameFor('x.tar.txt', 66)).toBe('x.tar (refeed v6.6).txt')
    expect(refeedNameFor('a.txt')).toBe(`a (refeed v${(PARSER_REVISION / 10).toFixed(1)}).txt`)
  })
})

describe('planRefeeds', () => {
  const A = sha('a'), B = sha('b'), C = sha('c')

  test('a file read by an older parser whose bytes are archived is fed under a re-feed name; one the current parser read is not', () => {
    const p = planRefeeds([row('old.txt', A, 50), row('new.txt', B, 65)], [entry('old.txt', A), entry('new.txt', B)], { inboxNames: none, current: 65 })
    expect(p.items.map(i => i.refFile)).toEqual(['old (refeed v6.5).txt.archiveref'])
    expect(p.items[0]).toMatchObject({ refName: 'old (refeed v6.5).txt', originalName: 'old.txt', revision: 50 })
    expect(p.items[0].entry.sha256).toBe(A)
    expect(p.skipped['already-current']).toBe(1)
  })

  test('the newest row of a hash decides: a re-feed row at the current revision means the file is done, whatever the old row says', () => {
    const p = planRefeeds([row('old.txt', A, 61), row('old (refeed v6.5).txt', A, 65, { when: '2026-11-08 10:00:00' })], [entry('old.txt', A)], { inboxNames: none, current: 65 })
    expect(p.items).toEqual([])
    expect(p.skipped['already-current']).toBe(1)
  })

  test('two names for one hash are one file, named after the newest row', () => {
    const p = planRefeeds([row('first.txt', A, 61, { when: '2026-10-20 10:00:00' }), row('second.txt', A, 62, { when: '2026-10-25 10:00:00' })], [entry('first.txt', A)], { inboxNames: none, current: 65 })
    expect(p.items).toHaveLength(1)
    expect(p.items[0].originalName).toBe('second.txt')
  })

  test('rows without a hash, and job-log rows, cannot be read again', () => {
    const p = planRefeeds([row('nohash.txt', '', 50, { size: 0 }), { ...row('jobs.txt', '', 0), kind: 'jobs', size: 0 }], [], { inboxNames: none, current: 65 })
    expect(p.items).toEqual([])
  })

  test('a hash the archive does not hold is counted, not fed', () => {
    const p = planRefeeds([row('gone.txt', A, 50)], [entry('other.txt', B)], { inboxNames: none, current: 65 })
    expect(p.items).toEqual([])
    expect(p.skipped['not-in-archive']).toBe(1)
  })

  test('the revision range keeps the files whose newest row is inside it', () => {
    const rows = [row('r50.txt', A, 50), row('r61.txt', B, 61), row('r63.txt', C, 63)]
    const man = [entry('r50.txt', A), entry('r61.txt', B), entry('r63.txt', C)]
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65, maxRevision: 50 }).items.map(i => i.originalName)).toEqual(['r50.txt'])
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65, minRevision: 61, maxRevision: 62 }).items.map(i => i.originalName)).toEqual(['r61.txt'])
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65, minRevision: 61 }).skipped['out-of-range']).toBe(1)
  })

  test('--only matches a name part (any case) or a sha256 prefix', () => {
    const rows = [row('Alpha Dump.txt', A, 50), row('beta.txt', B, 50)]
    const man = [entry('Alpha Dump.txt', A), entry('beta.txt', B)]
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65, only: ['alpha'] }).items.map(i => i.originalName)).toEqual(['Alpha Dump.txt'])
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65, only: ['bbbb'] }).items.map(i => i.originalName)).toEqual(['beta.txt'])
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65, only: ['alpha', 'bbbb'] }).items).toHaveLength(2)
  })

  test('a reference already in the inbox, processing, done, held or failed is not written again; neither is a plaintext with the re-feed name', () => {
    const rows = [row('a.txt', A, 50), row('b.txt', B, 50)]
    const man = [entry('a.txt', A), entry('b.txt', B)]
    const p = planRefeeds(rows, man, { current: 65, inboxNames: new Set(['a (refeed v6.5).txt.archiveref', 'b (refeed v6.5).txt']) })
    expect(p.items).toEqual([])
    expect(p.skipped['already-in-inbox']).toBe(2)
  })

  test('smallest first, so a problem shows before a big file is spent on it', () => {
    const rows = [row('big.txt', A, 50), row('small.txt', B, 50), row('mid.txt', C, 50)]
    const man = [entry('big.txt', A, 9000), entry('small.txt', B, 10), entry('mid.txt', C, 500)]
    expect(planRefeeds(rows, man, { inboxNames: none, current: 65 }).items.map(i => i.originalName)).toEqual(['small.txt', 'mid.txt', 'big.txt'])
  })

  test('a name the importer would refuse (over 255 characters) is counted, not fed', () => {
    const long = `${'x'.repeat(245)}.txt`
    const p = planRefeeds([row(long, A, 50)], [entry(long, A)], { inboxNames: none, current: 65 })
    expect(p.items).toEqual([])
    expect(p.skipped['name-too-long']).toBe(1)
  })
})
