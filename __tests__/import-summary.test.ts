import { describe, expect, it } from 'vitest'
import { ALREADY_IMPORTED_NOTE, addToTally, importRatePct, jobAccounting, jobAccountingTitle, jobLabel, keptRows, newJobTally, newKnownLabel, phaseLine, tallyOf } from '@/lib/import-summary'

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

const entry = (over: Partial<{ inFileDuplicates: number; alreadyImported: boolean; errors: number }> = {}) => ({ inFileDuplicates: 0, alreadyImported: false, errors: 0, ...over })

describe('the job tally (what processing_jobs records besides the counts)', () => {
  it('adds up the rows repeated inside the file over every entry', () => {
    const t = newJobTally()
    addToTally(t, entry({ inFileDuplicates: 22 }))
    addToTally(t, entry({ inFileDuplicates: 20 }))
    expect(jobAccounting(t)).toEqual({ repeats: 42 })
  })

  it('notes "already imported" when every entry was skipped by the same-name check', () => {
    const one = newJobTally()
    addToTally(one, entry({ alreadyImported: true }))
    expect(jobAccounting(one)).toEqual({ repeats: 0, note: ALREADY_IMPORTED_NOTE })
    const many = newJobTally()
    addToTally(many, entry({ alreadyImported: true }))
    addToTally(many, entry({ alreadyImported: true }))
    expect(jobAccounting(many).note).toBe(ALREADY_IMPORTED_NOTE)
  })

  it('has no note when one entry was imported, when there were no entries, or when only entries that failed were seen', () => {
    const mixed = newJobTally()
    addToTally(mixed, entry({ alreadyImported: true }))
    addToTally(mixed, entry())
    expect(jobAccounting(mixed).note).toBeUndefined()
    expect(jobAccounting(newJobTally())).toEqual({ repeats: 0 })
    const failed = newJobTally()
    addToTally(failed, entry({ errors: 1 }))
    expect(jobAccounting(failed).note).toBeUndefined()
  })

  it('does not count an entry that failed as a skipped file', () => {
    const t = newJobTally()
    addToTally(t, entry({ alreadyImported: true }))
    addToTally(t, entry({ errors: 1 }))
    expect(jobAccounting(t).note).toBe(ALREADY_IMPORTED_NOTE)
  })
})

describe('jobAccountingTitle', () => {
  it('says where every line went', () => {
    expect(jobAccountingTitle({ imported: 100, known: 40, repeats: 50, skipped: 10 }))
      .toBe('200 lines: 100 new · 40 already in the database · 50 repeated inside the file · 10 rejected')
  })

  it('leaves out the repeated rows and the total for a job from before they were recorded', () => {
    expect(jobAccountingTitle({ imported: 100, known: 40, repeats: null, skipped: 10 })).toBe('100 new · 40 already in the database · 10 rejected')
    expect(jobAccountingTitle({ imported: 100, skipped: 10 })).toBe('100 new · 0 already in the database · 10 rejected')
  })

  it('names the skip of a file that was already imported', () => {
    expect(jobAccountingTitle({ imported: 0, known: 0, repeats: 0, skipped: 0, note: ALREADY_IMPORTED_NOTE }))
      .toBe('A file with this name (and size) was imported before, so it was not read again')
  })
})

describe('jobLabel', () => {
  const fmt = (n: number) => `<${n}>`
  it('says a file was skipped instead of showing an empty "0 rows"', () => {
    expect(jobLabel({ imported: 0, known: 0, note: ALREADY_IMPORTED_NOTE }, fmt)).toBe('already imported · skipped')
  })
  it('is the new / known wording for every other job, with or without a note field', () => {
    expect(jobLabel({ imported: 1000, known: 250, note: null }, fmt)).toBe('<1000> new · <250> known')
    expect(jobLabel({ imported: 1000 }, fmt)).toBe('<1000> rows')
  })
})

describe('tallyOf', () => {
  it('is the tally of one file imported on its own', () => {
    expect(jobAccounting(tallyOf({ inFileDuplicates: 3, alreadyImported: false, errors: 0 }))).toEqual({ repeats: 3 })
    expect(jobAccounting(tallyOf({ inFileDuplicates: 0, alreadyImported: true, errors: 0 })).note).toBe(ALREADY_IMPORTED_NOTE)
  })
})
