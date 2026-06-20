import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  buildStatsSql,
  buildDeleteSql,
  dedupCronHours,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'

describe('content-dedup', () => {
  test('CONTENT_KEY is url, email, password', () => {
    expect(CONTENT_KEY).toBe('url, email, password')
  })

  describe('buildDeleteSql', () => {
    const sql = buildDeleteSql()
    test('is an ALTER TABLE … DELETE on ulp.credentials', () => {
      expect(sql.startsWith('ALTER TABLE ulp.credentials DELETE WHERE')).toBe(true)
    })
    test('keeps one survivor per content group (min full-hash, grouped by content)', () => {
      expect(sql).toContain('NOT IN (SELECT min(')
      expect(sql).toContain('GROUP BY url, email, password')
    })
  })

  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without the duplicate subquery', () => {
      expect(sql).toContain('uniqExact(cityHash64(url, email, password))')
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
})
