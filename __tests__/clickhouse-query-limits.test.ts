import { describe, test, expect } from 'vitest'
import {
  EXPORT_GROUP_BY_MAX_MEMORY_BYTES, exportGroupBySettings,
  EXPORT_SORT_MAX_MEMORY_BYTES, exportSortSettings,
} from '@/lib/clickhouse-query-limits'

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

  test('EXPORT_SORT_MAX_MEMORY_BYTES is 4 GiB', () => {
    expect(EXPORT_SORT_MAX_MEMORY_BYTES).toBe(4_294_967_296)
  })

  describe('exportSortSettings', () => {
    test('forces external (disk-spill) sort at the 4 GiB threshold', () => {
      // Confirmed live against ulp.credentials (91M rows): dedupe's LIMIT BY
      // makes ClickHouse fully sort the filtered set before applying LIMIT BY,
      // regardless of the final LIMIT — this converts the resulting
      // MEMORY_LIMIT_EXCEEDED crash into a slower, successful query instead.
      expect(exportSortSettings()).toBe(
        'SETTINGS max_bytes_before_external_sort = 4294967296',
      )
    })
  })
})
