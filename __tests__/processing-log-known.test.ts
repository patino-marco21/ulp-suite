import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

describe('processing_jobs.known', () => {
  it('exists in the application database, as an integer that defaults to 0', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    expect(cols.find(c => c.name === 'known')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
  })

  it('logJob stores the known count, and 0 when the caller has none', () => {
    logJob({ source: 'http', filename: 'known-roundtrip-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, known: 42 })
    logJob({ source: 'http', filename: 'known-roundtrip-b.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10 })
    expect(dbGet('SELECT known, imported FROM processing_jobs WHERE filename = ?', ['known-roundtrip-a.txt'])).toEqual({ known: 42, imported: 5 })
    expect(dbGet('SELECT known FROM processing_jobs WHERE filename = ?', ['known-roundtrip-b.txt'])).toEqual({ known: 0 })
  })
})
