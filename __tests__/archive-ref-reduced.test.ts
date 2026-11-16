/**
 * Stage D (docs/superpowers/plans/2026-11-16-reduced-archive-stage-d.md, task 5): an archive reference may point at a reduced entry. It then carries `of`, the size and
 * sha256 of the original file, so the importer can check the stream against the reduced entry and still record the original's identity. And the re-feed plan builds such a
 * reference for a name whose whole entry was swapped.
 */
import { describe, expect, test } from 'vitest'
import { ArchiveRefError, parseArchiveRef, serializeArchiveRef } from '@/lib/archive-ref'
import { planRefeeds } from '@/lib/refeed-plan'
import type { LedgerRow } from '@/lib/ledger-tools'
import type { ReducedEntry } from '@/lib/reduced-archive'
import type { ManifestEntry } from '@/lib/source-archive'

const sha = (c: string) => c.repeat(64)
const base = { id: 'a'.repeat(24), name: 'file.txt', size: 100, sha256: 'a'.repeat(64) }

describe('archive reference with `of`', () => {
  test('round-trips, and a reference without it serializes and parses exactly as before', () => {
    const of = { size: 5000, sha256: sha('b') }
    expect(parseArchiveRef(serializeArchiveRef({ ...base, of }))).toEqual({ v: 1, ...base, of })
    expect(serializeArchiveRef(base)).toBe(JSON.stringify({ v: 1, ...base }) + '\n')
    expect(parseArchiveRef(serializeArchiveRef(base))).toEqual({ v: 1, ...base })
  })

  test('refuses an `of` that is not a size and a sha256', () => {
    for (const of of [{ size: -1, sha256: sha('b') }, { size: 5, sha256: 'xyz' }, { size: 'a', sha256: sha('b') }, 'text', []]) {
      expect(() => parseArchiveRef(JSON.stringify({ v: 1, ...base, of }))).toThrow(ArchiveRefError)
    }
  })
})

describe('planRefeeds with a swapped entry', () => {
  const whole = (name: string, shaHex: string, extra: Partial<ManifestEntry> = {}): ManifestEntry =>
    ({ name, id: shaHex.slice(0, 24), size: 1000, sha256: shaHex, lines: 10, frames: [], archive_bytes: 300, archive_sha256: 'x', level: 12, created_at: '2026-10-01T00:00:00Z', ...extra })
  const reducedOf = (e: ManifestEntry): ReducedEntry => ({
    ...e, id: sha('c').slice(0, 24), size: 80, sha256: sha('c'), archive_bytes: 30, of: { sha256: e.sha256, size: e.size, lines: e.lines }, credentials: 1, kept_lines: 1, absent: 0,
    extra_known: 0, db_rows: 1, db_keys: 1, db_drift: 0, verified_at: '2026-11-16T00:00:00Z',
  })
  const row = (filename: string, shaHex: string, revision = 50): LedgerRow =>
    ({ kind: 'ledger', filename, size: 1000, sha256: shaHex, lines: 10, revision, when: '2026-10-01 00:00:00', archived: true })
  const opts = { inboxNames: new Set<string>(), current: 70 }

  test('a name whose whole entry was swapped is planned from its reduced entry', () => {
    const w = whole('s.txt', sha('d'))
    const r = reducedOf(w)
    const manifest = [w, { ...w, reduced_id: r.id, whole_removed_at: '2026-11-17T00:00:00Z' }]
    const plan = planRefeeds([row('s.txt', w.sha256)], manifest, { ...opts, reduced: [r] })
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].reduced?.id).toBe(r.id)
    expect(plan.items[0].entry.sha256).toBe(w.sha256)
  })

  test('a swapped name whose reduced entry cannot be found is left out as not in the archive', () => {
    const w = whole('s.txt', sha('d'))
    const manifest = [w, { ...w, reduced_id: sha('c').slice(0, 24), whole_removed_at: '2026-11-17T00:00:00Z' }]
    const plan = planRefeeds([row('s.txt', w.sha256)], manifest, { ...opts, reduced: [] })
    expect(plan.items).toHaveLength(0)
    expect(plan.skipped['not-in-archive']).toBe(1)
  })

  test('with nothing swapped the plan is what it was, and carries no reduced entry', () => {
    const w = whole('s.txt', sha('d'))
    const plan = planRefeeds([row('s.txt', w.sha256)], [w], opts)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].reduced).toBeUndefined()
  })

  test('a whole entry that another name still holds is preferred over a swapped line of the same bytes', () => {
    const a = whole('a.txt', sha('d'))
    const b = whole('b.txt', sha('d'))
    const manifest = [a, b, { ...a, reduced_id: sha('c').slice(0, 24), whole_removed_at: '2026-11-17T00:00:00Z' }]
    const plan = planRefeeds([row('a.txt', a.sha256)], manifest, { ...opts, reduced: [] })
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].reduced).toBeUndefined()
  })
})
