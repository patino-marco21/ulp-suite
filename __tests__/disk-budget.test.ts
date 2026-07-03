import { describe, test, expect } from 'vitest'
import { diskBudgetBytes, buildLiveBytesSql, diskBudgetPct } from '@/lib/disk-budget'

describe('diskBudgetBytes', () => {
  test('defaults to 550GB', () => {
    expect(diskBudgetBytes({})).toBe(550 * 1024 ** 3)
  })
  test('honors an override', () => {
    expect(diskBudgetBytes({ DISK_BUDGET_BYTES: '1000' })).toBe(1000)
  })
  test('invalid/zero falls back to the default', () => {
    expect(diskBudgetBytes({ DISK_BUDGET_BYTES: '0' })).toBe(550 * 1024 ** 3)
    expect(diskBudgetBytes({ DISK_BUDGET_BYTES: 'nope' })).toBe(550 * 1024 ** 3)
  })
})

describe('buildLiveBytesSql', () => {
  test('sums both base table and projection compressed bytes', () => {
    const sql = buildLiveBytesSql()
    expect(sql).toContain('system.parts')
    expect(sql).toContain('system.projection_parts')
    expect(sql).toContain('data_compressed_bytes')
  })

  test('scopes the base-table (system.parts) subquery to ulp.credentials, not the whole database', () => {
    const sql = buildLiveBytesSql()
    // Isolate the system.parts subquery specifically (as opposed to
    // system.projection_parts, which only credentials has a projection for
    // and is therefore correctly scoped by construction). Without
    // `AND table = 'credentials'` here, this sums bytes across every table
    // in the ulp database (sources, domains, ...), not just the live
    // credentials store this module claims to measure.
    const partsClauseMatch = sql.match(/FROM system\.parts WHERE ([^)]*)\)/)
    expect(partsClauseMatch).not.toBeNull()
    const partsClause = partsClauseMatch![1]
    expect(partsClause).toContain("table = 'credentials'")
  })
})

describe('diskBudgetPct', () => {
  test('computes a rounded percentage', () => {
    expect(diskBudgetPct(275 * 1024 ** 3, 550 * 1024 ** 3)).toBe(50)
  })
  test('returns 0 when budget is 0 (avoids divide-by-zero)', () => {
    expect(diskBudgetPct(100, 0)).toBe(0)
  })
})
