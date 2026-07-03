import { describe, test, expect } from 'vitest'
import {
  projectionScopeCronHours,
  projectionScopeWindowMonths,
  cutoffPartition,
  buildEligiblePartitionsSql,
  buildClearProjectionSql,
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
  test('buildClearProjectionSql targets the exact projection and partition', () => {
    expect(buildClearProjectionSql('202605')).toBe(
      `ALTER TABLE ulp.credentials CLEAR PROJECTION ${PROJECTION_NAME} IN PARTITION '202605'`,
    )
  })
})
