import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  eligible: [] as Array<{ partition: string; parts_with_projection: string; largest_part_bytes: string }>,
  free: 200 * 1024 ** 3,
  freeError: null as Error | null,
  exec: vi.fn(),
  query: vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ query: h.query, exec: h.exec }) }))

import { runProjectionScopeTick } from '@/lib/projection-scope'

const GiB = 1024 ** 3
const now = new Date('2026-10-11T05:00:00Z') // cutoff = 202608 with the default two-month window

beforeEach(() => {
  h.eligible = []
  h.free = 200 * GiB
  h.freeError = null
  h.exec.mockReset().mockResolvedValue(undefined)
  h.query.mockReset().mockImplementation(async ({ query }: { query: string }) => {
    if (query.includes('system.disks')) {
      if (h.freeError) throw h.freeError
      return { json: async () => [{ unreserved_space: h.free, total_space: 936.8 * GiB }] }
    }
    return { json: async () => h.eligible }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('runProjectionScopeTick', () => {
  it('issues no ALTER when no partition still carries the projection', async () => {
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res).toEqual({ cutoff: '202608', cleared: [], skipped: [] })
    expect(h.exec).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cleared=[none] skipped=[none]'))
  })

  it('queues the clear without waiting for it when there is room', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '3', largest_part_bytes: String(58.64 * GiB) }]
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.cleared).toEqual(['202607'])
    expect(res.skipped).toEqual([])
    expect(h.exec).toHaveBeenCalledTimes(1)
    expect(h.exec).toHaveBeenCalledWith({
      query: "ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '202607'",
      clickhouse_settings: { alter_sync: '0', mutations_sync: '0' },
    })
  })

  it('skips, and says why, when the disk cannot cover the part-sized reservation', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '3', largest_part_bytes: String(58.64 * GiB) }]
    h.free = 40 * GiB // needs about 69.5 GiB
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.cleared).toEqual([])
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0].partition).toBe('202607')
    expect(res.skipped[0].reason).toMatch(/needs about 6\d\.\d+ GiB free, has 40\.00 GiB/)
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('skips when free space cannot be read', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '1', largest_part_bytes: String(GiB) }]
    h.freeError = new Error('system.disks unavailable')
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.cleared).toEqual([])
    expect(res.skipped[0].reason).toContain('free space could not be read')
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('still goes on to the next partition after one is skipped', async () => {
    h.eligible = [
      { partition: '202606', parts_with_projection: '1', largest_part_bytes: String(300 * GiB) }, // cannot be afforded
      { partition: '202607', parts_with_projection: '1', largest_part_bytes: String(2 * GiB) },
    ]
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.skipped.map(s => s.partition)).toEqual(['202606'])
    expect(res.cleared).toEqual(['202607'])
  })

  it('never throws: a failing ALTER is logged and reported as an empty tick', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '1', largest_part_bytes: String(GiB) }]
    h.exec.mockRejectedValue(new Error('Code: 517'))
    await expect(runProjectionScopeTick({ trigger: 'test', now })).resolves.toEqual({ cutoff: '', cleared: [], skipped: [] })
    expect(console.error).toHaveBeenCalled()
  })
})
