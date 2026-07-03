import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ role: 'admin' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn() }))
vi.mock('@/lib/ingest-metrics', () => ({
  getIngestMetrics: vi.fn().mockReturnValue({
    filename: 'x.txt', batchSize: 100000, parserRowsPerSec: 2_000_000,
    insertRowsPerSec: 500_000, lastBatchInsertMs: 200, imported: 100000,
    tierDropped: 5, bottleneck: 'insert', updatedAt: Date.now(),
  }),
}))

import { executeQuery } from '@/lib/clickhouse'
import { GET } from '@/app/api/monitoring/ingest-health/route'

const mockEQ = executeQuery as ReturnType<typeof vi.fn>
beforeEach(() => {
  mockEQ.mockReset()
  // Re-arm a default resolved value after reset (matches the pattern used in
  // __tests__/upload-processor.test.ts). A bare mockReset() with no follow-up
  // implementation leaves the spy in a state where, on this Vitest/Node combo,
  // a later mockRejectedValue() in a sibling test is misreported as an
  // unhandled rejection even though the route's own try/catch handles it
  // correctly (verified by direct inspection of the caught error and the
  // resulting response body).
  mockEQ.mockResolvedValue([])
})

describe('GET /api/monitoring/ingest-health', () => {
  it('returns the store snapshot + clickhouse parts/merges/memory + disk budget', async () => {
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }])                          // parts
      .mockResolvedValueOnce([{ c: 3 }])                           // merges
      .mockResolvedValueOnce([{ v: 8_000_000_000 }])                // memory
      .mockResolvedValueOnce([{ bytes: 275 * 1024 ** 3 }])          // disk budget
    const res = await GET({} as any)
    const json = await res.json()
    expect(json.app.bottleneck).toBe('insert')
    expect(json.clickhouse.activeParts).toBe(42)
    expect(json.clickhouse.partsThreshold).toBe(1000)
    expect(json.clickhouse.activeMerges).toBe(3)
    expect(json.clickhouse.memoryBytes).toBe(8_000_000_000)
    expect(json.diskBudget.usedBytes).toBe(275 * 1024 ** 3)
    expect(json.diskBudget.budgetBytes).toBe(550 * 1024 ** 3)
    expect(json.diskBudget.pct).toBe(50)
  })

  it('degrades to zeros + note when system tables are unavailable', async () => {
    mockEQ.mockRejectedValue(new Error('UNKNOWN_TABLE'))
    const res = await GET({} as any)
    const json = await res.json()
    expect(json.clickhouse.activeParts).toBe(0)
    expect(json.clickhouse.note).toBeTruthy()
    expect(json.diskBudget.usedBytes).toBe(0)
    expect(json.diskBudget.note).toBeTruthy()
    expect(json.app.filename).toBe('x.txt')
  })
})
