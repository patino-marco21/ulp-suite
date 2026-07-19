import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffTimestampSql,
  buildContentKeyStatsSqlForBucket,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildEnsureSearchIndexesSql,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'

describe('content-dedup', () => {
  test('does not claim that an import-time hook still triggers content dedup', () => {
    const source = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('post-import hook')
  })
  test('CONTENT_KEY ignores url scheme/trailing-slash (email, password stay exact)', () => {
    expect(CONTENT_KEY).toBe(`${URL_CONTENT_KEY}, email, password`)
  })

  describe('AUTO_DEDUP_TABLE / AUTO_PREDUP_TABLE', () => {
    test('are distinct from the manual script\'s _cdedup/_predup table names', () => {
      expect(AUTO_DEDUP_TABLE).toBe('ulp.credentials_cdedup_auto')
      expect(AUTO_PREDUP_TABLE).toBe('ulp.credentials_predup_auto')
    })
  })

  describe('CONTENT_DEDUP_SURVIVOR_ORDER', () => {
    test('mirrors scripts/dedup-credentials-content.sh\'s ORDER exactly', () => {
      expect(CONTENT_DEDUP_SURVIVOR_ORDER).toBe('url, email, password, imported_at')
    })
  })

  describe('rewriteCreateTableDdl', () => {
    const fixture = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials', '{replica}')
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)`

    test('rewrites the CREATE TABLE line to the target table name', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result.split('\n')[0]).toBe(`CREATE TABLE ${AUTO_DEDUP_TABLE}`)
    })

    test('rewrites the ReplicatedMergeTree ZooKeeper path to match', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result).toContain(`/ulp/credentials_cdedup_auto'`)
      expect(result).not.toContain(`/ulp/credentials'`)
    })

    test('leaves the rest of the DDL unchanged', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result).toContain('`url` String CODEC(ZSTD(3))')
      expect(result).toContain('PARTITION BY toYYYYMM(imported_at)')
    })

    test('only rewrites the first occurrence of the table name (the CREATE TABLE line), not incidental matches elsewhere', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result.match(/ulp\.credentials_cdedup_auto/g)?.length).toBe(1)
    })
  })

  describe('CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES', () => {
    test('is 4 GiB', () => {
      expect(CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES).toBe(4_294_967_296)
    })
  })

  describe('CONTENT_DEDUP_MAX_THREADS', () => {
    test('is 2', () => {
      expect(CONTENT_DEDUP_MAX_THREADS).toBe(2)
    })
  })

  describe('contentDedupBucketCount', () => {
    test('defaults to 32', () => {
      expect(contentDedupBucketCount({})).toBe(32)
    })
    test('honors a positive override', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '16' })).toBe(16)
    })
    test('invalid or non-positive falls back to 32', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '0' })).toBe(32)
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: 'nope' })).toBe(32)
    })
  })

  describe('buildPopulateDedupedTableSqlForBucket', () => {
    test('inserts a deduped copy of one bucket, keeping the earliest imported_at per content key, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(5, 32)
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain('SELECT * FROM ulp.credentials')
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 5`)
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
      expect(sql).toContain(`max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
      expect(sql).not.toContain('max_block_size')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(0, 32)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 0`)
    })
  })

  describe('buildEnsureSearchIndexesSql', () => {
    test('targets AUTO_DEDUP_TABLE (the still-empty clone), not the live table', () => {
      const stmts = buildEnsureSearchIndexesSql()
      expect(stmts.length).toBeGreaterThan(0)
      for (const stmt of stmts) {
        expect(stmt).toContain(AUTO_DEDUP_TABLE)
      }
    })

    test('emits a DROP then an ADD for every index in SEARCH_INDEX_DEFINITIONS', () => {
      const stmts = buildEnsureSearchIndexesSql()
      expect(stmts).toHaveLength(SEARCH_INDEX_DEFINITIONS.length * 2)
      for (const def of SEARCH_INDEX_DEFINITIONS) {
        expect(stmts).toContain(def.dropIndexSql(AUTO_DEDUP_TABLE))
        expect(stmts).toContain(def.addIndexSql(AUTO_DEDUP_TABLE))
      }
    })

    test('never includes MATERIALIZE INDEX (the clone is empty; the populate insert builds each index as it writes rows)', () => {
      const stmts = buildEnsureSearchIndexesSql()
      expect(stmts.every(s => !s.includes('MATERIALIZE'))).toBe(true)
    })
  })

  describe('buildCutoffTimestampSql', () => {
    test('captures ClickHouse\'s own clock, nothing else', () => {
      const sql = buildCutoffTimestampSql()
      expect(sql).toBe('SELECT now() AS cutoff')
    })
  })

  describe('buildContentKeyStatsSqlForBucket', () => {
    test('counts one bucket\'s row total and distinct content keys together, bounded by max_execution_time only', () => {
      const sql = buildContentKeyStatsSqlForBucket(5, 32)
      expect(sql).toContain('count() AS bucket_total')
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct`)
      expect(sql).toContain('FROM ulp.credentials')
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 5`)
      expect(sql).toContain('max_execution_time = 300')
      expect(sql).not.toContain('max_threads')
      expect(sql).not.toContain('max_bytes_before_external_group_by')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildContentKeyStatsSqlForBucket(0, 32)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 0`)
    })
  })

  describe('buildVerifyDedupedTableSql', () => {
    test('reports the deduped table\'s own row count and internal excess only -- does not separately query the original table', () => {
      const sql = buildVerifyDedupedTableSql()
      expect(sql).toContain(`FROM ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY}))`)
      expect(sql).toContain('AS cdedup_rows')
      expect(sql).toContain('AS excess_after')
      // Exactly one data source (AUTO_DEDUP_TABLE) -- the old design queried
      // the original ulp.credentials too, which is what caused the
      // moving-target verification bug this shape fixes.
      expect(sql.match(/FROM/g)?.length).toBe(1)
      expect(sql).not.toContain('expected_rows')
    })
  })

  describe('buildRenameSwapSql', () => {
    test('atomically renames the original to the predup name and the deduped copy into place', () => {
      const sql = buildRenameSwapSql()
      expect(sql).toBe(`RENAME TABLE ulp.credentials TO ${AUTO_PREDUP_TABLE}, ${AUTO_DEDUP_TABLE} TO ulp.credentials`)
    })
  })

  describe('buildCatchupInsertSql', () => {
    test('copies rows imported after cutoff, excluding content keys already present, deduplicated against itself, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildCatchupInsertSql('2026-07-07 15:07:51')
      expect(sql).toContain('INSERT INTO ulp.credentials')
      expect(sql).toContain(`FROM ${AUTO_PREDUP_TABLE}`)
      expect(sql).toContain("WHERE imported_at > '2026-07-07 15:07:51'")
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) NOT IN (SELECT cityHash64(${CONTENT_KEY}) FROM ulp.credentials)`)
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
      expect(sql).toContain(`max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
      expect(sql).not.toContain('max_block_size')
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
