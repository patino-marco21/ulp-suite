import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }), isAdmin: () => true }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let sourceRows: Array<Record<string, unknown>> = []
let jobRows: Array<Record<string, unknown>> = []
let jobsThrow = false

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/count\(\) AS total/.test(sql)) return [{ total: '2' }]
    if (/positionCaseInsensitiveUTF8/.test(sql)) return sourceRows
    if (/FROM ulp\.credentials/.test(sql)) return []
    return [{ filename: 'list-a.txt', line_count: '5', last_imported: '2026-11-08 10:00:00' }]
  }),
}))
vi.mock('@/lib/sqlite', () => ({
  dbQuery: vi.fn(() => {
    if (jobsThrow) throw new Error('database is locked')
    return jobRows
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/sources/route'

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/sources${qs}`))

beforeEach(() => {
  calls.length = 0
  jobsThrow = false
  sourceRows = [{ filename: 'term-a one.txt', line_count: '9', size_bytes: '123', last_imported: '2026-11-08 10:00:00' }]
  jobRows = [
    { id: 1, filename: 'term-a two.txt', status: 'held', imported: 0, created_at: '2026-11-02 00:00:00' },
    { id: 2, filename: 'unrelated.txt', status: 'failed', imported: 0, created_at: '2026-11-01 00:00:00' },
  ]
})

describe('GET /api/sources?q=', () => {
  test('searches ulp.sources case-insensitively with the query as a parameter and merges the job log', async () => {
    const res = await get('?q=%20Term-A%20')
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.query).toBe('Term-A')
    expect(json.sources.map((s: { filename: string; status: string }) => [s.filename, s.status])).toEqual([['term-a one.txt', 'ingested'], ['term-a two.txt', 'held']])
    expect(json.total).toBe(2)
    const search = calls.find(c => /positionCaseInsensitiveUTF8/.test(c.sql))!
    expect(search.params.q).toBe('Term-A')
    expect(search.sql).toMatch(/positionCaseInsensitiveUTF8\(filename, \{q:String\}\) > 0/)
    // The alias must not be imported_at: argMax(x, imported_at) would become a nested aggregate (see the note in the route).
    expect(search.sql).toMatch(/max\(imported_at\)\s+AS last_imported/)
    expect(search.sql).not.toMatch(/AS imported_at/)
  })

  test('does not scan ulp.credentials while searching', async () => {
    await get('?q=term')
    expect(calls.some(c => /FROM ulp\.credentials/.test(c.sql))).toBe(false)
  })

  test('pages the merged result', async () => {
    sourceRows = Array.from({ length: 5 }, (_, i) => ({ filename: `term-a ${i}.txt`, line_count: 1, size_bytes: 1, last_imported: `2026-11-0${i + 1} 00:00:00` }))
    jobRows = []
    const json = await (await get('?q=term-a&limit=2&page=3')).json()
    expect(json).toMatchObject({ total: 5, page: 3, pages: 3 })
    expect(json.sources.map((s: { filename: string }) => s.filename)).toEqual(['term-a 0.txt'])
  })

  test('nothing matching is a success with an empty list', async () => {
    sourceRows = []
    jobRows = []
    const json = await (await get('?q=zzz')).json()
    expect(json).toMatchObject({ success: true, sources: [], total: 0, pages: 0, query: 'zzz' })
  })

  test('a query under 2 characters is the plain list (with credential counts)', async () => {
    const json = await (await get('?q=a')).json()
    expect(json.query).toBeUndefined()
    expect(calls.some(c => /positionCaseInsensitiveUTF8/.test(c.sql))).toBe(false)
    expect(calls.some(c => /count\(\) AS total/.test(c.sql))).toBe(true)
    expect(calls.some(c => /FROM ulp\.credentials/.test(c.sql))).toBe(true)
  })

  test('an unreadable job log is an error, not a quiet "not found"', async () => {
    jobsThrow = true
    const res = await get('?q=term')
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
