import { describe, expect, it } from 'vitest'
import { applyImportProgress, progressRows, type InboxProgressFields } from '@/lib/inbox-progress'

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
