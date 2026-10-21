import { describe, expect, it } from 'vitest'
import { applyImportProgress, computeProgress, progressRows, type InboxProgressFields } from '@/lib/inbox-progress'

const fresh = (): InboxProgressFields => ({ rows_imported: 0 })

describe('applyImportProgress', () => {
  it('copies the phase, the staged rows and the slab, and the running new / known counts of a plain file', () => {
    const p = fresh()
    applyImportProgress(p, { phase: 'inserting', staged: 900, skipped: 4, known: 300, inserted: 500, slab: 2, slabs: 5 }, { imported: 0, known: 0 })
    expect(p).toEqual({ rows_imported: 500, phase: 'inserting', rows_staged: 900, rows_known: 300, slab: 2, slabs: 5 })
  })

  it('adds what the finished entries of an archive already contributed', () => {
    const p = fresh()
    applyImportProgress(p, { phase: 'checking', staged: 100, skipped: 0, known: 10, inserted: 20, slab: 1, slabs: 1 }, { imported: 1000, known: 400 })
    expect(p).toMatchObject({ rows_imported: 1020, rows_known: 410, rows_staged: 100 })
  })

  it('clears the slab when the event has none (parsing)', () => {
    const p: InboxProgressFields = { rows_imported: 0, slab: 3, slabs: 4 }
    applyImportProgress(p, { phase: 'parsing', staged: 50, skipped: 0, known: 0, inserted: 0 }, { imported: 0, known: 0 })
    expect(p.slab).toBeUndefined()
    expect(p.slabs).toBeUndefined()
    expect(p.phase).toBe('parsing')
  })
})

describe('progressRows', () => {
  it('is the staged rows while novelty-aware ingest is working and the imported rows otherwise', () => {
    expect(progressRows({ rows_imported: 7 })).toBe(7)
    expect(progressRows({ rows_imported: 7, phase: 'parsing', rows_staged: 4000 })).toBe(4000)
    expect(progressRows({ rows_imported: 7, phase: 'inserting' })).toBe(0)
  })
})

// The bar used to assume 80 bytes per line. The 2026-10-21 files had 47-74 bytes per line, so it sat at 99% with a negative ETA for the last 14-30% of three of six files.
describe('computeProgress', () => {
  const NOW = 1_000_000
  const sample = (over: Record<string, unknown> = {}) => ({ started_at: NOW - 100_000, file_size_bytes: 1_000_000_000, rows_imported: 0, phase: 'parsing' as const, rows_staged: 5_000_000, ...over })

  it('measures the reading of a file by the bytes read, and estimates the rows and the time left from them', () => {
    const v = computeProgress(sample({ bytes_read: 250_000_000 }), NOW)
    expect(v).toEqual({ rows_per_sec: 50_000, est_total_rows: 20_000_000, pct: 25, eta_ms: 300_000 })
  })

  it('does not depend on the length of a line: the same rows read from the same share of the file give the same answer for short and long lines', () => {
    const short = computeProgress(sample({ file_size_bytes: 47 * 20_000_000, bytes_read: 47 * 5_000_000 }), NOW)
    const long = computeProgress(sample({ file_size_bytes: 74 * 20_000_000, bytes_read: 74 * 5_000_000 }), NOW)
    expect(short.pct).toBe(25)
    expect(long.pct).toBe(25)
    expect(short.est_total_rows).toBe(20_000_000)
    expect(long.est_total_rows).toBe(20_000_000)
  })

  it('never shows 100% before the job is done, and has no time left once the file is read', () => {
    const v = computeProgress(sample({ bytes_read: 1_000_000_000 }), NOW)
    expect(v.pct).toBe(99)
    expect(v.eta_ms).toBeNull()
  })

  it('clamps a read count past the size (the file grew while it was read)', () => {
    expect(computeProgress(sample({ bytes_read: 1_200_000_000 }), NOW).pct).toBe(99)
  })

  it('after the file is read (checking, writing) the total is the staged rows, the bar waits at 99% and there is no ETA', () => {
    for (const phase of ['checking', 'inserting'] as const) {
      expect(computeProgress(sample({ phase, bytes_read: 1_000_000_000 }), NOW)).toEqual({ rows_per_sec: 50_000, est_total_rows: 5_000_000, pct: 99, eta_ms: null })
    }
  })

  it('has nothing to say before the first batch', () => {
    expect(computeProgress(sample({ rows_staged: 0, bytes_read: 65_536 }), NOW)).toEqual({ rows_per_sec: 0, est_total_rows: null, pct: null, eta_ms: null })
  })

  it('keeps the old estimate (80 bytes a line) where the importer cannot count bytes, a ZIP', () => {
    expect(computeProgress({ started_at: NOW - 100_000, file_size_bytes: 800_000_000, rows_imported: 0, phase: 'parsing', rows_staged: 4_000_000 }, NOW))
      .toEqual({ rows_per_sec: 40_000, est_total_rows: 10_000_000, pct: 40, eta_ms: 150_000 })
  })
})
