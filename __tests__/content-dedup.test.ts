import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  buildStatsSql,
  buildDeleteSql,
  buildDeleteExecSql,
  CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('content-dedup', () => {
  test('does not claim that an import-time hook still triggers content dedup', () => {
    const source = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('post-import hook')
  })
  test('CONTENT_KEY ignores url scheme/trailing-slash (email, password stay exact)', () => {
    expect(CONTENT_KEY).toBe(`${URL_CONTENT_KEY}, email, password`)
  })

  describe('buildDeleteSql', () => {
    const sql = buildDeleteSql()
    test('is a lightweight DELETE FROM on ulp.credentials, not a heavyweight ALTER TABLE', () => {
      expect(sql.startsWith('DELETE FROM ulp.credentials WHERE')).toBe(true)
      expect(sql).not.toContain('ALTER TABLE')
    })
    test('keeps one survivor per content group (min full-hash, grouped by content)', () => {
      expect(sql).toContain('NOT IN (SELECT min(')
      expect(sql).toContain(`GROUP BY ${URL_CONTENT_KEY}, email, password`)
    })
    test('never includes its own SETTINGS clause', () => {
      // runContentDedupTick() appends the real SETTINGS clause via
      // buildDeleteExecSql() — a second one here would make the combined
      // statement invalid SQL (two SETTINGS keywords).
      expect(sql).not.toContain('SETTINGS')
    })
  })

  describe('CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES', () => {
    test('is 4 GiB', () => {
      expect(CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES).toBe(4_294_967_296)
    })
  })

  describe('CONTENT_DEDUP_MAX_THREADS', () => {
    test('is 2', () => {
      expect(CONTENT_DEDUP_MAX_THREADS).toBe(2)
    })
  })

  describe('buildDeleteExecSql', () => {
    test('combines the delete statement with lightweight_deletes_sync, bounded threads, and external group-by spill in exactly one SETTINGS clause', () => {
      const sql = buildDeleteExecSql()
      expect(sql).toContain('DELETE FROM ulp.credentials WHERE')
      expect(sql).toContain(
        'SETTINGS lightweight_deletes_sync = 0, max_threads = 2, max_bytes_before_external_group_by = 4294967296',
      )
      expect(sql.match(/SETTINGS/g)?.length).toBe(1)
    })
  })

  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without the duplicate subquery', () => {
      expect(sql).toContain(`uniqExact(cityHash64(${URL_CONTENT_KEY}, email, password))`)
      expect(sql).toContain('AS excess')
      expect(sql).not.toContain('AS deletable')
      expect(sql).not.toContain('countIf(')
    })
  })

  describe('dedupCronHours', () => {
    test('defaults to 24h', () => {
      expect(dedupCronHours({})).toBe(24)
    })
    test('honors a positive value', () => {
      expect(dedupCronHours({ DEDUP_CRON_HOURS: '6' })).toBe(6)
    })
    test('0 / invalid disables (returns 0)', () => {
      expect(dedupCronHours({ DEDUP_CRON_HOURS: '0' })).toBe(0)
      expect(dedupCronHours({ DEDUP_CRON_HOURS: 'nope' })).toBe(0)
    })
  })

  describe('contentDedupApplyEnabled', () => {
    test('off by default (report-only)', () => {
      expect(contentDedupApplyEnabled({})).toBe(false)
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: 'false' })).toBe(false)
    })
    test('on for "true" or "1"', () => {
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: 'true' })).toBe(true)
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: '1' })).toBe(true)
    })
  })

  describe('minExcessToApply', () => {
    test('defaults to 1000', () => {
      expect(minExcessToApply({})).toBe(1000)
    })
    test('honors a custom threshold', () => {
      expect(minExcessToApply({ DEDUP_MIN_EXCESS: '50' })).toBe(50)
    })
  })

  describe('dedupCronHourUtc', () => {
    test('defaults to 4 (04:00 UTC)', () => {
      expect(dedupCronHourUtc({})).toBe(4)
    })
    test('honors a configured hour', () => {
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '9' })).toBe(9)
    })
    test('out-of-range or invalid falls back to 4', () => {
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '24' })).toBe(4)
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '-1' })).toBe(4)
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: 'nope' })).toBe(4)
    })
  })
})
