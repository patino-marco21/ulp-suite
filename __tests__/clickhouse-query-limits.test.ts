import { describe, test, expect } from 'vitest'
import { EXPORT_GROUP_BY_MAX_MEMORY_BYTES, exportGroupBySettings } from '@/lib/clickhouse-query-limits'

describe('clickhouse-query-limits', () => {
  test('EXPORT_GROUP_BY_MAX_MEMORY_BYTES is 4 GiB', () => {
    expect(EXPORT_GROUP_BY_MAX_MEMORY_BYTES).toBe(4_294_967_296)
  })

  describe('exportGroupBySettings', () => {
    test('caps max_memory_usage and applies the given execution time', () => {
      expect(exportGroupBySettings(120)).toBe(
        'SETTINGS max_memory_usage = 4294967296, max_execution_time = 120',
      )
    })
    test('honors a different execution time', () => {
      expect(exportGroupBySettings(60)).toBe(
        'SETTINGS max_memory_usage = 4294967296, max_execution_time = 60',
      )
    })
  })
})
