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
import { liveStateFromRow, encodeDictionaryComment, resetSearchDictionaryCache } from '@/lib/search-dictionary'

const mockEQ = executeQuery as ReturnType<typeof vi.fn>
beforeEach(() => {
  resetSearchDictionaryCache()
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

  it('reports the search dictionary: unknown when ClickHouse cannot say', async () => {
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }]).mockResolvedValueOnce([{ c: 3 }]).mockResolvedValueOnce([{ v: 1 }]).mockResolvedValueOnce([{ bytes: 1 }])
    const json = await (await GET({} as any)).json()
    expect(json.searchDictionary).toMatchObject({ state: 'unknown', builtAt: null, pairRows: null, bytes: null })
  })

  it('reports a fresh search dictionary with its size and build time', async () => {
    const liveRow = { table_uuid: 'u1', part_state: '202608:1:0:1', mutation_state: '', mutations_running: '0', builds_running: '0' }
    const fp = liveStateFromRow(liveRow)!.fingerprint
    const comment = (rows: number) => encodeDictionaryComment({ v: 1, fp, builtAt: '2026-10-03T12:00:00.000Z', rows })
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }]).mockResolvedValueOnce([{ c: 3 }]).mockResolvedValueOnce([{ v: 1 }]).mockResolvedValueOnce([{ bytes: 1 }])
      .mockImplementation(async (sql: string) => {
        if (sql.includes('AS table_uuid')) return [liveRow]
        if (sql.includes("name IN ('search_host_dict'")) {
          return [
            { name: 'search_host_dict', comment: comment(85), table_rows: '85', table_bytes: '2000' },
            { name: 'search_emaildomain_dict', comment: comment(13), table_rows: '13', table_bytes: '100' },
          ]
        }
        return []
      })
    const json = await (await GET({} as any)).json()
    expect(json.searchDictionary).toMatchObject({ state: 'fresh', builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100 })
    expect(json.searchDictionary).not.toHaveProperty('fingerprint')
  })
})
