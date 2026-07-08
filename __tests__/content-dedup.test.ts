import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  buildStatsSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffSql,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  CONTENT_DEDUP_MAX_BLOCK_SIZE,
  buildPopulateDedupedTableSql,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
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

  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without a duplicate subquery', () => {
      expect(sql).toContain(`uniqExact(cityHash64(${URL_CONTENT_KEY}, email, password))`)
      expect(sql).toContain('AS excess')
      expect(sql).not.toContain('AS deletable')
      expect(sql).not.toContain('countIf(')
    })
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

  describe('CONTENT_DEDUP_MAX_BLOCK_SIZE', () => {
    test('is 16,384', () => {
      expect(CONTENT_DEDUP_MAX_BLOCK_SIZE).toBe(16_384)
    })
  })

  describe('buildPopulateDedupedTableSql', () => {
    test('inserts a deduped copy keeping the earliest imported_at per content key, with disk-spill, bounded threads, a capped block size, and a raised timeout', () => {
      const sql = buildPopulateDedupedTableSql()
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain('SELECT * FROM ulp.credentials')
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
      expect(sql).toContain(`max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_block_size = ${CONTENT_DEDUP_MAX_BLOCK_SIZE}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
    })
  })

  describe('buildCutoffSql', () => {
    test('captures the clock time and the distinct content-key count together, in one query', () => {
      const sql = buildCutoffSql()
      expect(sql).toContain('now() AS cutoff')
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS expected_rows`)
      expect(sql).toContain('FROM ulp.credentials')
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
    test('copies rows imported after cutoff, excluding content keys already present, deduplicated against itself, with disk-spill, bounded threads, a capped block size, and a raised timeout', () => {
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
      expect(sql).toContain(`max_block_size = ${CONTENT_DEDUP_MAX_BLOCK_SIZE}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
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
