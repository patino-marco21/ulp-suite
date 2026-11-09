import { describe, expect, it } from 'vitest'
import { matchesName, mergeHits, normalizeQuery, utcDate, type JobRowInput, type SourceRowInput } from '@/lib/sources-search'

const src = (filename: string, over: Partial<SourceRowInput> = {}): SourceRowInput =>
  ({ filename, line_count: 10, size_bytes: 1000, last_imported: '2026-11-08 10:00:00', ...over })
const job = (id: number, filename: string, status: string, over: Partial<JobRowInput> = {}): JobRowInput =>
  ({ id, filename, status, imported: 0, created_at: '2026-11-01 00:00:00', ...over })

describe('normalizeQuery', () => {
  it('trims, and returns null under 2 characters or for nothing', () => {
    expect(normalizeQuery('  term A  ')).toBe('term A')
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery(' a ')).toBeNull()
    expect(normalizeQuery('')).toBeNull()
    expect(normalizeQuery(null)).toBeNull()
    expect(normalizeQuery(undefined)).toBeNull()
  })
  it('cuts a query at 200 characters', () => {
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(200)
  })
})

describe('matchesName', () => {
  it('is a case-insensitive contains', () => {
    expect(matchesName('File-A (2).TXT', 'file-a')).toBe(true)
    expect(matchesName('file-a.txt', '(2)')).toBe(false)
  })
  it('treats % and _ as plain characters', () => {
    expect(matchesName('file-a.txt', '%')).toBe(false)
    expect(matchesName('file_a.txt', '_a')).toBe(true)
    expect(matchesName('fileXa.txt', '_a')).toBe(false)
  })
  it('folds non-ASCII case', () => {
    expect(matchesName('Über-file.txt', 'über')).toBe(true)
  })
})

describe('mergeHits', () => {
  it('lists a ulp.sources row as ingested, with size and lines', () => {
    const [hit] = mergeHits([src('file-a.txt', { size_bytes: '4179297131', line_count: '77' })], [], 'file-a')
    expect(hit).toEqual({ filename: 'file-a.txt', status: 'ingested', size: 4179297131, line_count: 77, imported_at: '2026-11-08 10:00:00', cred_count: 0 })
  })

  it('an unfinished job-log name is Held or Failed (the latest unfinished job decides)', () => {
    const hits = mergeHits([], [job(1, 'file-b.txt', 'failed'), job(2, 'file-b.txt', 'held', { created_at: '2026-11-02 00:00:00' }), job(3, 'file-c.txt', 'failed')], 'file-')
    expect(hits.map(h => [h.filename, h.status])).toEqual([['file-b.txt', 'held'], ['file-c.txt', 'failed']])
    expect(hits[0].imported_at).toBe('2026-11-02 00:00:00')
  })

  it('a finished job beats an earlier failure and gives Processed earlier, summing what it added', () => {
    const [hit] = mergeHits([], [
      job(1, 'file-d.txt', 'failed', { created_at: '2026-06-01 00:00:00' }),
      job(2, 'file-d.txt', 'done', { imported: 100, created_at: '2026-06-02 00:00:00' }),
      job(3, 'file-d.txt', 'done', { imported: '50', created_at: '2026-06-03 00:00:00' }),
    ], 'file-d')
    expect(hit).toMatchObject({ filename: 'file-d.txt', status: 'processed', size: 0, line_count: 150, imported_at: '2026-06-03 00:00:00' })
  })

  it('a ulp.sources row beats the job log for the same name', () => {
    const hits = mergeHits([src('file-e.txt')], [job(1, 'file-e.txt', 'failed')], 'file-e')
    expect(hits).toHaveLength(1)
    expect(hits[0].status).toBe('ingested')
  })

  it('a job named like an archive reference stands for the file it points at', () => {
    const hits = mergeHits([src('file-f.txt')], [job(1, 'file-f.txt.archiveref', 'done', { imported: 5 }), job(2, 'file-g.txt.archiveref', 'done', { imported: 5 })], 'file-')
    expect(hits.map(h => [h.filename, h.status]).sort()).toEqual([['file-f.txt', 'ingested'], ['file-g.txt', 'processed']])
  })

  it('keeps only the job names that match, ignores other job statuses, and sorts newest first', () => {
    const hits = mergeHits(
      [src('file-h.txt', { last_imported: '2026-11-01 00:00:00' }), src('file-i.txt', { last_imported: '2026-11-05 00:00:00' })],
      [job(1, 'other.txt', 'failed'), job(2, 'file-j.txt', 'queued'), job(3, 'file-k.txt', 'held', { created_at: '2026-11-03 00:00:00' })],
      'file-',
    )
    expect(hits.map(h => h.filename)).toEqual(['file-i.txt', 'file-k.txt', 'file-h.txt'])
  })

  it('treats a missing size as 0', () => {
    const [hit] = mergeHits([src('file-l.txt', { size_bytes: '' })], [], 'file-l')
    expect(hit.size).toBe(0)
  })
})

describe('utcDate', () => {
  it('reads a ClickHouse / SQLite timestamp as UTC', () => {
    expect(utcDate('2026-11-09 02:11:01').toISOString()).toBe('2026-11-09T02:11:01.000Z')
  })
  it('leaves an ISO string with a zone alone', () => {
    expect(utcDate('2026-11-09T02:11:01Z').toISOString()).toBe('2026-11-09T02:11:01.000Z')
  })
})
