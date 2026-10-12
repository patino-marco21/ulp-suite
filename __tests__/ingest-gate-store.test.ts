import { beforeEach, describe, expect, it } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'
import { addGateOverride, consumeGateOverride, latestHeldReport, removeGateOverride } from '@/lib/ingest-gate-store'

beforeEach(() => {
  dbRun('DELETE FROM gate_overrides')
})

describe('gate overrides: a release is one-shot and belongs to one file name', () => {
  it('is consumed by the next claim of that name, once', () => {
    expect(addGateOverride('a.txt', 'admin@example.com')).toBe(true)
    expect(consumeGateOverride('a.txt')).toBe(true)
    expect(consumeGateOverride('a.txt')).toBe(false)
  })

  it('does not release another file', () => {
    addGateOverride('a.txt', null)
    expect(consumeGateOverride('b.txt')).toBe(false)
    expect(consumeGateOverride('a.txt')).toBe(true)
  })

  it('keeps one row when the same file is released twice', () => {
    addGateOverride('a.txt', 'one@example.com')
    addGateOverride('a.txt', 'two@example.com')
    expect(dbGet(`SELECT count(*) AS n, max(created_by) AS by FROM gate_overrides WHERE filename = 'a.txt'`)).toEqual({ n: 1, by: 'two@example.com' })
  })

  it('removeGateOverride withdraws a release', () => {
    addGateOverride('a.txt', null)
    removeGateOverride('a.txt')
    expect(consumeGateOverride('a.txt')).toBe(false)
  })

  it('a release older than a day is gone', () => {
    dbRun(`INSERT INTO gate_overrides (filename, created_by, created_at) VALUES (?, ?, datetime('now', '-2 days'))`, ['old.txt', null])
    expect(consumeGateOverride('old.txt')).toBe(false)
    expect(dbGet(`SELECT count(*) AS n FROM gate_overrides WHERE filename = 'old.txt'`)).toEqual({ n: 0 })
  })
})

describe('latestHeldReport', () => {
  const held = (filename: string, gate_report: string) =>
    logJob({ source: 'inbox', filename, status: 'held', imported: 0, skipped: 0, duration_ms: 1, gate_report })

  it('returns the report of the newest held job of the file, and null for a file that was never held', () => {
    held('held-report-a.txt', JSON.stringify({ v: 1, level: 'hold', junkPct: 3 }))
    held('held-report-a.txt', JSON.stringify({ v: 1, level: 'hold', junkPct: 9 }))
    expect(latestHeldReport('held-report-a.txt')).toMatchObject({ junkPct: 9 })
    expect(latestHeldReport('never-held.txt')).toBeNull()
  })

  it('does not take a report from a job that was not held', () => {
    logJob({ source: 'inbox', filename: 'held-report-b.txt', status: 'done', imported: 1, skipped: 0, duration_ms: 1, gate_report: JSON.stringify({ v: 1, level: 'warn' }) })
    expect(latestHeldReport('held-report-b.txt')).toBeNull()
  })

  it('survives a malformed report', () => {
    held('held-report-c.txt', '{not json')
    expect(latestHeldReport('held-report-c.txt')).toBeNull()
  })
})
