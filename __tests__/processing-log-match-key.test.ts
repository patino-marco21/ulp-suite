import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

type Column = { name: string; type: string; notnull: number; dflt_value: string | null }

describe('processing_jobs.match_key', () => {
  it('exists in the application database as a nullable TEXT column, so a job from before reads NULL, which means the exact key', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Column[]
    expect(cols.find(c => c.name === 'match_key')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  })

  it('logJob stores the rule an import matched on', () => {
    logJob({ source: 'inbox', filename: 'mk-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, match_key: 'norm' })
    logJob({ source: 'inbox', filename: 'mk-b.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, match_key: 'exact' })
    expect(dbGet('SELECT match_key FROM processing_jobs WHERE filename = ?', ['mk-a.txt'])).toEqual({ match_key: 'norm' })
    expect(dbGet('SELECT match_key FROM processing_jobs WHERE filename = ?', ['mk-b.txt'])).toEqual({ match_key: 'exact' })
  })

  it('stores nothing for a job that was not matched (the direct path, a failed or held file)', () => {
    logJob({ source: 'inbox', filename: 'mk-c.txt', status: 'failed', imported: 0, skipped: 0, duration_ms: 10 })
    expect(dbGet('SELECT match_key FROM processing_jobs WHERE filename = ?', ['mk-c.txt'])).toEqual({ match_key: null })
  })
})
