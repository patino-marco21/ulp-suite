import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ progress: null as null | Record<string, unknown>, dbQuery: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/sqlite', () => ({ dbQuery: h.dbQuery }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 1, pendingCount: 0 }, getCurrentJob: () => 'big.txt' }))
vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getDoneCount: () => 0 }))
vi.mock('@/lib/inbox-watcher', () => ({ getInboxJobProgress: () => h.progress, getInFlightCount: () => 1 }))

import { GET } from '@/app/api/inbox/status/route'

const get = async () => (await GET(new NextRequest('http://localhost/api/inbox/status'))).json()

beforeEach(() => {
  h.progress = null
  h.dbQuery.mockReset()
  h.dbQuery.mockReturnValue([])
})

describe('GET /api/inbox/status with novelty-aware ingest', () => {
  it('measures progress by the rows staged while the file is being read, and passes the phase on', async () => {
    h.progress = {
      filename: 'big.txt', started_at: Date.now() - 100_000, rows_imported: 0, file_size_bytes: 800_000_000,
      phase: 'parsing', rows_staged: 4_000_000, rows_known: 0,
    }
    const json = await get()
    expect(json.current_progress).toMatchObject({
      filename: 'big.txt', phase: 'parsing', rows_imported: 0, rows_staged: 4_000_000, rows_known: 0, est_total_rows: 10_000_000, pct: 40,
    })
    expect(json.current_progress.rows_per_sec).toBeGreaterThan(30_000)
    expect(json.current_progress.rows_per_sec).toBeLessThan(40_100)
  })

  it('reports the slab and the running new / known counts while committing', async () => {
    h.progress = {
      filename: 'big.txt', started_at: Date.now() - 1_000, rows_imported: 300, file_size_bytes: 8_000,
      phase: 'inserting', rows_staged: 100, rows_known: 200, slab: 2, slabs: 3,
    }
    const json = await get()
    expect(json.current_progress).toMatchObject({ phase: 'inserting', rows_imported: 300, rows_known: 200, slab: 2, slabs: 3 })
  })

  it('shows a file that has not staged a batch yet, with a zero phase block', async () => {
    h.progress = { filename: 'big.txt', started_at: Date.now(), rows_imported: 0, file_size_bytes: 100, phase: 'parsing', rows_staged: 0 }
    const json = await get()
    expect(json.current_progress).toMatchObject({ phase: 'parsing', rows_staged: 0, rows_imported: 0, pct: null, eta_ms: null })
  })

  it('still works for the direct path: no phase, progress from the imported rows', async () => {
    h.progress = { filename: 'big.txt', started_at: Date.now() - 10_000, rows_imported: 500_000, file_size_bytes: 80_000_000 }
    const json = await get()
    expect(json.current_progress).toMatchObject({ rows_imported: 500_000, rows_staged: 0, rows_known: 0, phase: null, est_total_rows: 1_000_000, pct: 50 })
  })

  it('lists the known count of each finished file', async () => {
    h.dbQuery.mockReturnValue([{ id: 1, filename: 'a.txt', status: 'done', imported: 5, known: 9, skipped: 0, duration_ms: 1, error_message: null, created_at: 'x' }])
    const json = await get()
    expect(h.dbQuery.mock.calls[0][0]).toMatch(/SELECT[^;]*\bknown\b/)
    expect(json.done_recent[0]).toMatchObject({ imported: 5, known: 9 })
  })
})
