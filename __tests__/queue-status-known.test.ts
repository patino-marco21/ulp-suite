import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ dbQuery: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/sqlite', () => ({ dbQuery: h.dbQuery }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 0, pendingCount: 0 }, getCurrentJob: () => null }))

import { GET } from '@/app/api/upload/queue-status/route'

beforeEach(() => h.dbQuery.mockReset())

describe('GET /api/upload/queue-status: known rows', () => {
  it('selects the known column and totals it', async () => {
    h.dbQuery
      .mockReturnValueOnce([{ id: 1, source: 'http', filename: 'a.txt', status: 'done', imported: 5, known: 9, skipped: 0, duration_ms: 1, error_message: null, breach_name: null, created_at: 'x' }])
      .mockReturnValueOnce([{ status: 'done', file_count: 1, total_imported: 5, total_known: 9, total_skipped: 0 }])

    const res = await GET(new NextRequest('http://localhost/api/upload/queue-status'))
    const json = await res.json()

    expect(h.dbQuery.mock.calls[0][0]).toMatch(/SELECT[^;]*\bknown\b/)
    expect(h.dbQuery.mock.calls[1][0]).toContain('SUM(known)')
    expect(json.recent[0]).toMatchObject({ imported: 5, known: 9 })
    expect(json.totals).toMatchObject({ rows_imported: 5, rows_known: 9, files_done: 1 })
  })

  it('selects the repeated rows and the note of every recent job', async () => {
    h.dbQuery
      .mockReturnValueOnce([{ id: 1, source: 'http', filename: 'a.txt', status: 'done', imported: 0, known: 0, skipped: 0, duration_ms: 1, error_message: null, breach_name: null, created_at: 'x', repeats: 0, note: 'already-imported' }])
      .mockReturnValueOnce([])
    const json = await (await GET(new NextRequest('http://localhost/api/upload/queue-status'))).json()
    expect(h.dbQuery.mock.calls[0][0]).toMatch(/SELECT[^;]*\brepeats\b[^;]*\bnote\b/)
    expect(json.recent[0]).toMatchObject({ repeats: 0, note: 'already-imported' })
  })

  it('reports 0 known rows when there are no finished jobs yet', async () => {
    h.dbQuery.mockReturnValue([])
    const json = await (await GET(new NextRequest('http://localhost/api/upload/queue-status'))).json()
    expect(json.totals).toEqual({ files_done: 0, files_failed: 0, rows_imported: 0, rows_known: 0, rows_skipped: 0 })
  })
})
