import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

describe('processing_jobs.gate_report and gate_overrides', () => {
  it('the application database has a nullable gate_report column and a gate_overrides table keyed by file name', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Array<{ name: string; type: string; notnull: number }>
    expect(cols.find(c => c.name === 'gate_report')).toMatchObject({ type: 'TEXT', notnull: 0 })
    const overrides = dbQuery('PRAGMA table_info(gate_overrides)') as Array<{ name: string; pk: number }>
    expect(overrides.map(c => c.name).sort()).toEqual(['created_at', 'created_by', 'filename'])
    expect(overrides.find(c => c.name === 'filename')?.pk).toBe(1)
  })

  it('logJob stores a held job with its report, and NULL when there is none', () => {
    logJob({
      source: 'inbox', filename: 'gate-roundtrip-a.txt', status: 'held', imported: 0, skipped: 0, duration_ms: 5,
      error_message: 'Held by the quality gate: x.', gate_report: '{"level":"hold"}',
    })
    logJob({ source: 'inbox', filename: 'gate-roundtrip-b.txt', status: 'done', imported: 5, skipped: 0, duration_ms: 5 })
    expect(dbGet('SELECT status, gate_report FROM processing_jobs WHERE filename = ?', ['gate-roundtrip-a.txt'])).toEqual({ status: 'held', gate_report: '{"level":"hold"}' })
    expect(dbGet('SELECT gate_report FROM processing_jobs WHERE filename = ?', ['gate-roundtrip-b.txt'])).toEqual({ gate_report: null })
  })
})
