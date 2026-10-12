import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ progress: null as null | Record<string, unknown>, dbQuery: vi.fn(), held: [] as Array<Record<string, unknown>>, latestHeldReport: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/sqlite', () => ({ dbQuery: h.dbQuery }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 1, pendingCount: 0 }, getCurrentJob: () => 'big.txt' }))
vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getHeld: () => h.held, getDoneCount: () => 0 }))
vi.mock('@/lib/ingest-gate-store', () => ({ latestHeldReport: h.latestHeldReport }))
vi.mock('@/lib/inbox-watcher', () => ({ getInboxJobProgress: () => h.progress, getInFlightCount: () => 1 }))

import { GET } from '@/app/api/inbox/status/route'

const get = async () => (await GET(new NextRequest('http://localhost/api/inbox/status'))).json()

beforeEach(() => {
  h.progress = null
  h.held = []
  h.latestHeldReport.mockReset()
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

  it('lists the files held by the quality gate with the report of their hold', async () => {
    h.held = [{ name: 'held.txt', size_bytes: 10, mtime: 'x' }, { name: 'noreport.txt', size_bytes: 5, mtime: 'y' }]
    h.latestHeldReport.mockImplementation((name: string) => (name === 'held.txt' ? { level: 'hold', junkPct: 7 } : null))
    const json = await get()
    expect(json.held).toEqual([
      { name: 'held.txt', size_bytes: 10, mtime: 'x', report: { level: 'hold', junkPct: 7 } },
      { name: 'noreport.txt', size_bytes: 5, mtime: 'y', report: null },
    ])
  })

  it('says nothing is held when nothing is', async () => {
    expect((await get()).held).toEqual([])
  })

  it('selects the gate level and the first reason of each recent job, and tolerates a malformed report', async () => {
    h.dbQuery.mockReturnValue([{ id: 1, filename: 'a.txt', status: 'held', imported: 0, known: 0, skipped: 0, duration_ms: 1, error_message: 'Held', created_at: 'x', gate_level: 'hold', gate_note: '7% break a rule' }])
    const json = await get()
    const sql = h.dbQuery.mock.calls[0][0] as string
    expect(sql).toMatch(/json_valid\(gate_report\)/)
    expect(sql).toMatch(/AS gate_level/)
    expect(sql).toMatch(/AS gate_note/)
    expect(json.done_recent[0]).toMatchObject({ status: 'held', gate_level: 'hold', gate_note: '7% break a rule' })
  })
})
