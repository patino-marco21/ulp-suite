import { describe, test, expect } from 'vitest'
import {
  projectionScopeCronHours,
  projectionScopeWindowMonths,
  cutoffPartition,
  buildEligiblePartitionsSql,
  buildClearProjectionSql,
  clearProjectionNeedBytes,
  CLEAR_RESERVE_MARGIN_BYTES,
  PROJECTION_NAME,
} from '@/lib/projection-scope'

describe('projection-scope config', () => {
  test('projectionScopeCronHours defaults to 24', () => {
    expect(projectionScopeCronHours({})).toBe(24)
  })
  test('projectionScopeCronHours honors a positive override', () => {
    expect(projectionScopeCronHours({ PROJECTION_SCOPE_CRON_HOURS: '6' })).toBe(6)
  })
  test('projectionScopeCronHours 0/invalid disables (returns 0)', () => {
    expect(projectionScopeCronHours({ PROJECTION_SCOPE_CRON_HOURS: '0' })).toBe(0)
    expect(projectionScopeCronHours({ PROJECTION_SCOPE_CRON_HOURS: 'nope' })).toBe(0)
  })

  test('projectionScopeWindowMonths defaults to 2', () => {
    expect(projectionScopeWindowMonths({})).toBe(2)
  })
  test('projectionScopeWindowMonths honors an override', () => {
    expect(projectionScopeWindowMonths({ PROJECTION_SCOPE_WINDOW_MONTHS: '3' })).toBe(3)
  })
})

describe('cutoffPartition', () => {
  test('subtracts the window in months, across a year boundary', () => {
    expect(cutoffPartition(2, new Date('2026-01-15T00:00:00Z'))).toBe('202511')
  })
  test('same-year subtraction', () => {
    expect(cutoffPartition(2, new Date('2026-07-03T00:00:00Z'))).toBe('202605')
  })
})

describe('SQL builders', () => {
  test('buildEligiblePartitionsSql filters to partitions older than cutoff', () => {
    const sql = buildEligiblePartitionsSql('202605')
    expect(sql).toContain("partition < '202605'")
    expect(sql).toContain("database = 'ulp'")
    expect(sql).toContain("table = 'credentials'")
  })
  test('buildEligiblePartitionsSql never lists the newest partition, however old it is', () => {
    // The window is measured from the calendar, but nothing may have been imported for months: the newest-first read
    // (lib/newest-first.ts) starts in the newest partition, so that one keeps its projection.
    const sql = buildEligiblePartitionsSql('202605')
    expect(sql).toMatch(/partition < \(SELECT max\(partition\) FROM system\.parts WHERE database = 'ulp' AND table = 'credentials' AND active\)/)
  })
  test('buildClearProjectionSql targets the exact projection and partition', () => {
    expect(buildClearProjectionSql('202605')).toBe(
      `ALTER TABLE ulp.credentials CLEAR PROJECTION ${PROJECTION_NAME} IN PARTITION '202605'`,
    )
  })
})

describe('eligibility asks which parts really carry the projection', () => {
  test('reads system.projection_parts and joins the parent part for its size', () => {
    const sql = buildEligiblePartitionsSql('202605')
    expect(sql).toContain('FROM system.projection_parts AS pp')
    expect(sql).toContain('INNER JOIN system.parts AS pa ON pa.database = pp.database AND pa.table = pp.table AND pa.name = pp.parent_name')
    expect(sql).toContain(`pp.name = '${PROJECTION_NAME}'`)
    expect(sql).toContain('pp.active AND pa.active')
    expect(sql).toContain('max(pa.bytes_on_disk) AS largest_part_bytes')
  })
})

describe('clearProjectionNeedBytes', () => {
  test('is the largest part x 1.1 plus a 5 GiB margin', () => {
    const GiB = 1024 ** 3
    expect(CLEAR_RESERVE_MARGIN_BYTES).toBe(5 * GiB)
    expect(clearProjectionNeedBytes(58.64 * GiB)).toBe(Math.ceil(58.64 * GiB * 1.1) + 5 * GiB)
    expect(clearProjectionNeedBytes(0)).toBe(5 * GiB)
  })
})
