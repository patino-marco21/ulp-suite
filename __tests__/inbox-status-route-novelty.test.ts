import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ progress: null as null | Record<string, unknown>, jobs: null as null | Array<Record<string, unknown>>, dbQuery: vi.fn(), held: [] as Array<Record<string, unknown>>, latestHeldReport: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/sqlite', () => ({ dbQuery: h.dbQuery }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 1, pendingCount: 0 }, getCurrentJob: () => 'big.txt' }))
vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getHeld: () => h.held, getDoneCount: () => 0 }))
vi.mock('@/lib/ingest-gate-store', () => ({ latestHeldReport: h.latestHeldReport }))
vi.mock('@/lib/inbox-watcher', () => ({ getInboxJobsProgress: () => h.jobs ?? (h.progress ? [h.progress] : []), getInFlightCount: () => 1 }))

import { GET } from '@/app/api/inbox/status/route'

const get = async () => (await GET(new NextRequest('http://localhost/api/inbox/status'))).json()

beforeEach(() => {
  h.progress = null
  h.jobs = null
  h.held = []
  h.latestHeldReport.mockReset()
  h.dbQuery.mockReset()
  h.dbQuery.mockReturnValue([])
})

describe('GET /api/inbox/status: the files being imported', () => {
  it('measures a plain file by the bytes read, not by an assumed line length', async () => {
    h.progress = {
      filename: 'big.txt', started_at: Date.now() - 100_000, rows_imported: 0, file_size_bytes: 1_000_000_000,
      phase: 'parsing', rows_staged: 5_000_000, readBytes: () => 250_000_000,
    }
    const json = await get()
    expect(json.current_progress).toMatchObject({ filename: 'big.txt', pct: 25, est_total_rows: 20_000_000 })
    expect(json.current_progress.eta_ms).toBeGreaterThan(290_000)
    expect(json.current_progress.eta_ms).toBeLessThan(310_000)
    expect(json.current_progress).not.toHaveProperty('readBytes')
  })

  it('lists every file in flight, each with its own progress, and keeps current_progress as the first of them', async () => {
    const base = { rows_imported: 0, phase: 'parsing', file_size_bytes: 1_000_000_000 }
    h.jobs = [
      { ...base, filename: 'a.txt', started_at: Date.now() - 100_000, rows_staged: 5_000_000, readBytes: () => 250_000_000 },
      { ...base, filename: 'b.txt', started_at: Date.now() - 50_000, rows_staged: 1_000_000, readBytes: () => 500_000_000 },
    ]
    const json = await get()
    expect(json.jobs_progress.map((j: { filename: string }) => j.filename)).toEqual(['a.txt', 'b.txt'])
    expect(json.jobs_progress.map((j: { pct: number }) => j.pct)).toEqual([25, 50])
    expect(json.current_progress).toEqual(json.jobs_progress[0])
  })

  it('has an empty list and no current progress when nothing is being imported', async () => {
    const json = await get()
    expect(json.jobs_progress).toEqual([])
    expect(json.current_progress).toBeNull()
  })
})

describe('GET /api/inbox/status: the finished jobs', () => {
  it('selects the repeated rows and the note of every recent job', async () => {
    h.dbQuery.mockReturnValue([{ id: 1, filename: 'a.txt', status: 'done', imported: 0, known: 0, skipped: 0, duration_ms: 1, error_message: null, created_at: 'x', repeats: 4, note: null }])
    const json = await get()
    expect(h.dbQuery.mock.calls[0][0]).toMatch(/SELECT[^;]*\brepeats\b[^;]*\bnote\b/)
    expect(json.done_recent[0]).toMatchObject({ repeats: 4, note: null })
  })
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

describe('GET /api/inbox/status: the account of the automatic archive', () => {
  let arc = ''
  beforeEach(() => { arc = mkdtempSync(join(tmpdir(), 'inbox-status-arc-')); vi.stubEnv('ULP_ARCHIVE_DIR', arc) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(arc, { recursive: true, force: true }) })
  const status = (over: Record<string, unknown> = {}) => JSON.stringify({
    v: 1, at: '2026-11-05T22:00:00.000Z', ran: true, archived: 3, failed: 0, plain_bytes: 5 * 1024 ** 3, verify: { checked: 3, failed: 0 },
    ready_files: 3, ready_bytes: 5 * 1024 ** 3, unarchived_files: 0, unarchived_bytes: 0, other_files: 0, other_bytes: 0, empty_files: 0, free_bytes: 200 * 1024 ** 3, ...over,
  })

  it('carries the one-line account and when it was made', async () => {
    writeFileSync(join(arc, 'auto-archive-status.json'), status())
    const json = await get()
    expect(json.archive.at).toBe('2026-11-05T22:00:00.000Z')
    expect(json.archive.note).toMatch(/^Archive: 3 files archived \(5\.0 GiB\).*3 files are ready to replace.*would free about 5\.0 GiB.*Nothing is removed without you\.$/)
    expect(json.archive.problem).toBe(false)
  })

  it('flags a run that failed', async () => {
    writeFileSync(join(arc, 'auto-archive-status.json'), status({ failed: 1 }))
    expect((await get()).archive.problem).toBe(true)
  })

  it('is null when there is no status (no archive mounted, or no run yet) or the file is not one this version reads', async () => {
    expect((await get()).archive).toBeNull()
    writeFileSync(join(arc, 'auto-archive-status.json'), '{ broken')
    expect((await get()).archive).toBeNull()
  })
})
