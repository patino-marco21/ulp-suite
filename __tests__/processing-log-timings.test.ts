import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

const TIMING_COLUMNS = ['parse_ms', 'check_ms', 'insert_ms', 'lock_wait_ms']

describe('processing_jobs phase timings', () => {
  it('has parse_ms, check_ms, insert_ms and lock_wait_ms in the application database, as integers that default to 0', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    for (const name of TIMING_COLUMNS) {
      expect(cols.find(c => c.name === name), name).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
    }
  })

  it('logJob stores the three timings, rounded to whole milliseconds', () => {
    logJob({ source: 'inbox', filename: 'timings-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 900, parse_ms: 120.4, check_ms: 300.5, insert_ms: 99.9 })
    expect(dbGet('SELECT parse_ms, check_ms, insert_ms, imported FROM processing_jobs WHERE filename = ?', ['timings-a.txt']))
      .toEqual({ parse_ms: 120, check_ms: 301, insert_ms: 100, imported: 5 })
  })

  it('logJob stores the wait for the commit lock, which is in none of the three phases', () => {
    logJob({ source: 'inbox', filename: 'timings-lock.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 900, parse_ms: 100, check_ms: 200, insert_ms: 300, lock_wait_ms: 250.6 })
    expect(dbGet('SELECT lock_wait_ms, parse_ms FROM processing_jobs WHERE filename = ?', ['timings-lock.txt'])).toEqual({ lock_wait_ms: 251, parse_ms: 100 })
  })

  it('stores 0 for each timing the caller has none for', () => {
    logJob({ source: 'inbox', filename: 'timings-b.txt', status: 'failed', imported: 0, skipped: 0, duration_ms: 10 })
    logJob({ source: 'http', filename: 'timings-c.txt', status: 'done', imported: 1, skipped: 0, duration_ms: 10, check_ms: 7 })
    expect(dbGet('SELECT parse_ms, check_ms, insert_ms FROM processing_jobs WHERE filename = ?', ['timings-b.txt'])).toEqual({ parse_ms: 0, check_ms: 0, insert_ms: 0 })
    expect(dbGet('SELECT parse_ms, check_ms, insert_ms FROM processing_jobs WHERE filename = ?', ['timings-c.txt'])).toEqual({ parse_ms: 0, check_ms: 7, insert_ms: 0 })
  })

  it('never loses the job over a bad timing: NaN, a negative or a missing number is stored as 0', () => {
    logJob({ source: 'inbox', filename: 'timings-d.txt', status: 'done', imported: 2, skipped: 0, duration_ms: 10, parse_ms: Number.NaN, check_ms: -5, insert_ms: undefined })
    expect(dbGet('SELECT parse_ms, check_ms, insert_ms, imported FROM processing_jobs WHERE filename = ?', ['timings-d.txt']))
      .toEqual({ parse_ms: 0, check_ms: 0, insert_ms: 0, imported: 2 })
  })
})
