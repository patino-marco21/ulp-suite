import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

type Column = { name: string; type: string; notnull: number; dflt_value: string | null }

describe('processing_jobs.repeats and processing_jobs.note', () => {
  it('exist in the application database as nullable columns, so an older row reads "not recorded" instead of 0', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Column[]
    expect(cols.find(c => c.name === 'repeats')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null })
    expect(cols.find(c => c.name === 'note')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  })

  it('logJob stores the rows repeated inside the file and the note', () => {
    logJob({ source: 'inbox', filename: 'repeats-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, repeats: 22_400_000, note: 'already-imported' })
    expect(dbGet('SELECT repeats, note, imported FROM processing_jobs WHERE filename = ?', ['repeats-a.txt'])).toEqual({ repeats: 22_400_000, note: 'already-imported', imported: 5 })
  })

  it('stores 0 repeats as 0 (a measurement) and a missing value as NULL (not recorded)', () => {
    logJob({ source: 'inbox', filename: 'repeats-b.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, repeats: 0 })
    logJob({ source: 'inbox', filename: 'repeats-c.txt', status: 'failed', imported: 0, skipped: 0, duration_ms: 10 })
    expect(dbGet('SELECT repeats, note FROM processing_jobs WHERE filename = ?', ['repeats-b.txt'])).toEqual({ repeats: 0, note: null })
    expect(dbGet('SELECT repeats, note FROM processing_jobs WHERE filename = ?', ['repeats-c.txt'])).toEqual({ repeats: null, note: null })
  })

  it('never loses the job over a bad count: NaN or a negative number is stored as NULL', () => {
    logJob({ source: 'inbox', filename: 'repeats-d.txt', status: 'done', imported: 2, skipped: 0, duration_ms: 10, repeats: Number.NaN })
    logJob({ source: 'inbox', filename: 'repeats-e.txt', status: 'done', imported: 3, skipped: 0, duration_ms: 10, repeats: -4 })
    expect(dbGet('SELECT repeats, imported FROM processing_jobs WHERE filename = ?', ['repeats-d.txt'])).toEqual({ repeats: null, imported: 2 })
    expect(dbGet('SELECT repeats, imported FROM processing_jobs WHERE filename = ?', ['repeats-e.txt'])).toEqual({ repeats: null, imported: 3 })
  })
})
