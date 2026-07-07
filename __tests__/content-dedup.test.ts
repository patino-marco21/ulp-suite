import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  FULL_HASH,
  buildStatsSql,
  contentDuplicatePredicateForBucket,
  buildDeleteSqlForBucket,
  buildDeleteExecSqlForBucket,
  CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
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

  describe('FULL_HASH', () => {
    test('includes _part and _part_offset so exact full-tuple duplicates never tie', () => {
      expect(FULL_HASH).toBe(
        'cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)',
      )
    })
  })

  describe('contentDuplicatePredicateForBucket', () => {
    const sql = contentDuplicatePredicateForBucket(5, 1024)
    test('scopes the outer filter to the given bucket', () => {
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) % 1024 = 5`)
    })
    test('scopes the tie-break subquery to the same bucket', () => {
      expect(sql).toContain(
        `NOT IN (SELECT min(${FULL_HASH}) FROM ulp.credentials WHERE cityHash64(${CONTENT_KEY}) % 1024 = 5 GROUP BY ${CONTENT_KEY})`,
      )
    })
    test('preserves the literal "GROUP BY <CONTENT_KEY>" substring the in-flight mutation check matches on', () => {
      expect(sql).toContain(`GROUP BY ${CONTENT_KEY}`)
    })
    test('a different bucket index/count changes both the filter and the subquery scope', () => {
      const other = contentDuplicatePredicateForBucket(0, 8)
      expect(other).toContain(`cityHash64(${CONTENT_KEY}) % 8 = 0`)
      expect(other).not.toContain('% 1024 = 5')
    })
  })

  describe('buildDeleteSqlForBucket', () => {
    const sql = buildDeleteSqlForBucket(2, 16)
    test('is a heavyweight ALTER TABLE DELETE on ulp.credentials, not a lightweight DELETE FROM', () => {
      expect(sql.startsWith('ALTER TABLE ulp.credentials DELETE WHERE')).toBe(true)
      expect(sql).not.toContain('DELETE FROM')
    })
    test('embeds this bucket\'s predicate', () => {
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) % 16 = 2`)
    })
    test('never includes its own SETTINGS clause', () => {
      // buildDeleteExecSqlForBucket() appends the real SETTINGS clause -- a
      // second one here would make the combined statement invalid SQL.
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

  describe('buildDeleteExecSqlForBucket', () => {
    test('combines the bucketed delete with mutations_sync, nondeterministic-mutations allowance, bounded threads, and external group-by spill in exactly one SETTINGS clause', () => {
      const sql = buildDeleteExecSqlForBucket(2, 16)
      expect(sql).toContain('ALTER TABLE ulp.credentials DELETE WHERE')
      expect(sql).toContain(
        'SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1, max_threads = 2, max_bytes_before_external_group_by = 4294967296',
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

  describe('contentDedupBucketCount', () => {
    test('defaults to 1024', () => {
      expect(contentDedupBucketCount({})).toBe(1024)
    })
    test('honors a configured count', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '256' })).toBe(256)
    })
    test('invalid or non-positive falls back to 1024', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '0' })).toBe(1024)
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: 'nope' })).toBe(1024)
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
