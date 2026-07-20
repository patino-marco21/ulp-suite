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
  buildVerifyDedupedTableSqlForBucket,
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
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '1234567890')
      expect(result.split('\n')[0]).toBe(`CREATE TABLE ${AUTO_DEDUP_TABLE}`)
    })

    test('rewrites the ReplicatedMergeTree ZooKeeper path to match, suffixed with the given uniqueSuffix', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '1234567890')
      expect(result).toContain(`/ulp/credentials_cdedup_auto_1234567890'`)
      expect(result).not.toContain(`/ulp/credentials'`)
    })

    test('leaves the rest of the DDL unchanged', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '1234567890')
      expect(result).toContain('`url` String CODEC(ZSTD(3))')
      expect(result).toContain('PARTITION BY toYYYYMM(imported_at)')
    })

    test('only rewrites the first occurrence of the table name (the CREATE TABLE line), not incidental matches elsewhere', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '1234567890')
      expect(result.match(/ulp\.credentials_cdedup_auto/g)?.length).toBe(1)
    })

    test('different uniqueSuffix values produce different ZK paths for the same target table -- the property that fixes REPLICA_ALREADY_EXISTS across successive cycles', () => {
      const first = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '1111111111')
      const second = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '2222222222')
      expect(first).toContain(`/ulp/credentials_cdedup_auto_1111111111'`)
      expect(second).toContain(`/ulp/credentials_cdedup_auto_2222222222'`)
      expect(first).not.toBe(second)
    })

    // Confirmed live 2026-07-20: after a successful swap, ulp.credentials'
    // REAL SHOW CREATE TABLE output has a ZK path already ending in
    // /ulp/credentials_cdedup_auto (not /ulp/credentials) -- RENAME TABLE
    // never moves a table's ZK registration, so a table that was ever the
    // build target keeps that path forever, even after being renamed to
    // ulp.credentials. A live retry against this exact shape silently
    // failed to rewrite the ZK path at all (no exception -- a literal
    // string .replace() targeting '/ulp/credentials\'' simply found no
    // match and returned the DDL unchanged), reproducing
    // REPLICA_ALREADY_EXISTS via a completely different mechanism than the
    // bug this file's uniqueSuffix parameter was built to fix. This fixture
    // mirrors that real shape so this exact regression can't recur silently.
    const alreadySwappedFixture = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials_cdedup_auto', '{replica}')
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)`

    test('rewrites the ZK path correctly even when the source table\'s CURRENT path already ends in something other than plain "credentials" (post-swap shape)', () => {
      const result = rewriteCreateTableDdl(alreadySwappedFixture, AUTO_DEDUP_TABLE, '1234567890')
      expect(result).toContain(`/ulp/credentials_cdedup_auto_1234567890'`)
      expect(result).not.toContain(`/ulp/credentials_cdedup_auto'`)
    })

    test('the same uniqueSuffix produces the identical target ZK path regardless of which shape the source table\'s current path was in -- the target path only ever depends on targetTable and uniqueSuffix', () => {
      const fromNeverSwapped = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE, '1234567890')
      const fromAlreadySwapped = rewriteCreateTableDdl(alreadySwappedFixture, AUTO_DEDUP_TABLE, '1234567890')
      const zkPath = (s: string) => s.match(/ReplicatedMergeTree\('([^']+)'/)?.[1]
      expect(zkPath(fromNeverSwapped)).toBe(zkPath(fromAlreadySwapped))
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

  describe('buildVerifyDedupedTableSqlForBucket', () => {
    test('counts one bucket\'s row total and distinct content keys together, against AUTO_DEDUP_TABLE only', () => {
      const sql = buildVerifyDedupedTableSqlForBucket(5, 32)
      expect(sql).toContain('count() AS bucket_total')
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct`)
      expect(sql).toContain(`FROM ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 5`)
      expect(sql).toContain('max_execution_time = 300')
      // Exactly one data source (AUTO_DEDUP_TABLE) -- the old design queried
      // the original ulp.credentials too, which is what caused the
      // moving-target verification bug this shape fixes.
      expect(sql.match(/FROM/g)?.length).toBe(1)
      expect(sql).not.toContain('expected_rows')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildVerifyDedupedTableSqlForBucket(0, 32)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 0`)
    })
  })

  describe('bucket_total/bucket_distinct alias consistency', () => {
    test('buildContentKeyStatsSqlForBucket and buildVerifyDedupedTableSqlForBucket use the same field aliases -- sumBucketedTotalAndDistinct depends on this to stay generic across both', () => {
      const statsSql = buildContentKeyStatsSqlForBucket(0, 8)
      const verifySql = buildVerifyDedupedTableSqlForBucket(0, 8)
      expect(statsSql).toContain('AS bucket_total')
      expect(statsSql).toContain('AS bucket_distinct')
      expect(verifySql).toContain('AS bucket_total')
      expect(verifySql).toContain('AS bucket_distinct')
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
