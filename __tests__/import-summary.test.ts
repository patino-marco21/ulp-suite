import { describe, expect, it } from 'vitest'
import { importRatePct, keptRows, newKnownLabel, phaseLine } from '@/lib/import-summary'

describe('keptRows / importRatePct', () => {
  it('counts the new, the already-known and the repeated rows as accepted', () => {
    expect(keptRows({ imported: 2, known: 6, inFileDuplicates: 1 })).toBe(9)
    expect(keptRows({ imported: 5 })).toBe(5)
  })

  it('is the accepted share of all lines, to one decimal, and 0 for an empty file', () => {
    expect(importRatePct({ imported: 2, known: 6, inFileDuplicates: 1, skipped: 3 })).toBe(75)
    expect(importRatePct({ imported: 1, skipped: 2 })).toBe(33.3)
    expect(importRatePct({ imported: 0, skipped: 0 })).toBe(0)
  })

  it('is the same ratio as before on the direct path (known and repeated are 0)', () => {
    expect(importRatePct({ imported: 900, known: 0, inFileDuplicates: 0, skipped: 100 })).toBe(90)
  })
})

describe('phaseLine', () => {
  it('says nothing without a phase (the direct path)', () => {
    expect(phaseLine({})).toBeNull()
    expect(phaseLine({ phase: null, staged: 5 })).toBeNull()
  })

  it('describes reading, checking and writing', () => {
    expect(phaseLine({ phase: 'parsing', staged: 1234567 })).toBe('Reading the file: 1,234,567 rows so far')
    expect(phaseLine({ phase: 'checking', staged: 20000000 })).toBe('Checking 20,000,000 rows against the database')
    expect(phaseLine({ phase: 'inserting', imported: 500, known: 1500 })).toBe('Writing the new rows: 500 new, 1,500 already in the database so far')
  })

  it('names the part when a file is committed in several', () => {
    expect(phaseLine({ phase: 'checking', staged: 60000000, slab: 2, slabs: 3 })).toBe('Checking 60,000,000 rows against the database (part 2 of 3)')
    expect(phaseLine({ phase: 'inserting', imported: 1, known: 2, slab: 3, slabs: 3 })).toBe('Writing the new rows (part 3 of 3): 1 new, 2 already in the database so far')
    expect(phaseLine({ phase: 'checking', staged: 5, slab: 1, slabs: 1 })).toBe('Checking 5 rows against the database')
  })
})

describe('newKnownLabel', () => {
  const fmt = (n: number) => `<${n}>`
  it('keeps the old wording when nothing was known', () => {
    expect(newKnownLabel(1000, 0, fmt)).toBe('<1000> rows')
    expect(newKnownLabel(1000, undefined, fmt)).toBe('<1000> rows')
  })
  it('shows new and known side by side otherwise', () => {
    expect(newKnownLabel(1000, 250, fmt)).toBe('<1000> new · <250> known')
    expect(newKnownLabel(0, 250, fmt)).toBe('<0> new · <250> known')
  })
})
