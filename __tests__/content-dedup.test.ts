import { readFileSync } from 'fs'
import { describe, test, expect, vi } from 'vitest'
import { DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
import {
  CONTENT_KEY,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildDedupedTableCreateDdl,
  buildCutoffTimestampSql,
  buildContentKeyStatsSql,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildEnsureSearchIndexesSql,
  buildVerifyDedupedTableStatsSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
  populateDedupedTableWithGuard,
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
    test('is the earliest-imported_at tie-break order the retired manual script used (url, email, password, imported_at)', () => {
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

    // Defense-in-depth per the final whole-branch review: the structural
    // regex is confirmed correct against the real live schema today, but a
    // literal-string match was ALSO "confirmed correct" once before this
    // session (see the alreadySwappedFixture comment above) and then wasn't.
    // Rather than trust the next fix to be right, this makes a no-op
    // rewrite fail loudly (an Error, caught safely by the existing outer
    // try/catch) instead of silently returning a DDL that would go on to
    // collide with an existing table's ZK path.
    test('throws if the ZK path could not be rewritten, instead of silently returning unrewritten DDL', () => {
      const noZkPathFixture = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3))
)
ENGINE = MergeTree()
ORDER BY url`
      expect(() => rewriteCreateTableDdl(noZkPathFixture, AUTO_DEDUP_TABLE, '1234567890')).toThrow()
    })
  })

  // The deferred-projection build (see lib/credentials-projections.ts): the
  // clone is created with the base table + skip indexes only, and
  // proj_imported_desc is restored on the live table after the swap. Building
  // with both projections cost ~18 GiB/bucket vs ~6.5 without, which is what
  // tripped the disk guard on the real 2.78B-row cutover.
  describe('buildDedupedTableCreateDdl', () => {
    const withProjection = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3)),
    INDEX idx_bf_url url TYPE bloom_filter(0.05) GRANULARITY 1,
    PROJECTION proj_imported_desc
    (
        SELECT url
        ORDER BY url
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials_cdedup_auto_1784508692786', '{replica}')
ORDER BY url`

    test('targets AUTO_DEDUP_TABLE with a fresh per-cycle ZK path AND carries no projections', () => {
      const ddl = buildDedupedTableCreateDdl(withProjection, '1234567890')
      expect(ddl.split('\n')[0]).toBe(`CREATE TABLE ${AUTO_DEDUP_TABLE}`)
      expect(ddl).toContain(`/ulp/credentials_cdedup_auto_1234567890'`)
      expect(ddl).not.toContain('PROJECTION')
    })

    test('keeps the skip indexes -- only projections are deferred', () => {
      expect(buildDedupedTableCreateDdl(withProjection, '1234567890')).toContain('INDEX idx_bf_url url TYPE bloom_filter(0.05)')
    })

    test('runContentDedupTick builds the clone through it, not through rewriteCreateTableDdl alone (which would silently bring the projections back)', () => {
      const source = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
      expect(source).toContain('buildDedupedTableCreateDdl(showCreateSql')
      expect(source).not.toContain('query: rewriteCreateTableDdl(')
    })

    test('runContentDedupTick restores the projection after the catch-up, and a failed restore does not flip the result to applied: false (the swap already happened)', () => {
      const source = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
      const catchupAt = source.indexOf('buildCatchupInsertSql(cutoff)')
      const restoreAt = source.indexOf('restoreImportedDescProjection(client')
      expect(catchupAt).toBeGreaterThan(-1)
      expect(restoreAt).toBeGreaterThan(catchupAt)
      expect(source).toContain('projectionsRestored')
    })
  })

  describe('CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES', () => {
    test('is 4 GiB', () => {
      expect(CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES).toBe(4_294_967_296)
    })
  })

  describe('CONTENT_DEDUP_MAX_THREADS', () => {
    test('is 6', () => {
      expect(CONTENT_DEDUP_MAX_THREADS).toBe(6)
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
    test('inserts one argMin-selected survivor row per content key in this bucket, via GROUP BY not a sort, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(5, 16)
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE} (url, email, password, domain, source_file, breach_name, imported_at, was_duplicated)`)
      expect(sql).toContain('argMin(url, imported_at)')
      expect(sql).toContain('argMin(email, imported_at)')
      expect(sql).toContain('argMin(password, imported_at)')
      expect(sql).toContain('argMin(domain, imported_at)')
      expect(sql).toContain('argMin(source_file, imported_at)')
      expect(sql).toContain('argMin(breach_name, imported_at)')
      expect(sql).toContain('min(imported_at)')
      expect(sql).toContain('FROM ulp.credentials')
      expect(sql).toContain('WHERE content_key_hash % 16 = 5')
      expect(sql).toContain('GROUP BY content_key_hash')
      expect(sql).toContain(`max_bytes_before_external_group_by = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
      expect(sql).not.toContain('ORDER BY')
      expect(sql).not.toContain('LIMIT 1 BY')
      expect(sql).not.toContain('max_bytes_before_external_sort')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(0, 16)
      expect(sql).toContain('WHERE content_key_hash % 16 = 0')
    })

    test('was_duplicated is cumulative: max() across the group preserves an already-true flag from a prior cycle even when this cycle sees no new duplicate for that group', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(5, 16)
      expect(sql).toContain('greatest(max(was_duplicated), if(count() > 1, 1, 0))')
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

  describe('buildContentKeyStatsSql', () => {
    test('counts the whole table\'s row total and distinct content keys in one pass via GROUP BY content_key_hash, disk-spilling, no bucket params', () => {
      const sql = buildContentKeyStatsSql()
      expect(sql).toContain('sum(c) AS total')
      expect(sql).toContain('count() AS distinctCreds')
      expect(sql).toContain('SELECT content_key_hash, count() AS c')
      expect(sql).toContain('FROM ulp.credentials')
      expect(sql).toContain('GROUP BY content_key_hash')
      expect(sql).toContain(`max_bytes_before_external_group_by = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain('max_execution_time = 900')
      expect(sql).not.toContain('cityHash64')
      expect(sql).not.toContain('WHERE')
    })
  })

  describe('buildVerifyDedupedTableStatsSql', () => {
    test('counts AUTO_DEDUP_TABLE\'s row total and distinct content keys in one pass, same shape as buildContentKeyStatsSql', () => {
      const sql = buildVerifyDedupedTableStatsSql()
      expect(sql).toContain('sum(c) AS total')
      expect(sql).toContain('count() AS distinctCreds')
      expect(sql).toContain(`FROM ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain('GROUP BY content_key_hash')
      expect(sql).toContain(`max_bytes_before_external_group_by = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      // Exactly one physical data source (AUTO_DEDUP_TABLE) -- the outer
      // aggregation's FROM is a subquery wrapper, not a second table. An
      // earlier design queried the original ulp.credentials too, which is
      // what caused the moving-target verification bug this shape fixes.
      // AUTO_DEDUP_TABLE itself starts with "ulp.credentials", so check for
      // the bare table name specifically (never followed by "_cdedup_auto").
      expect(sql.match(new RegExp(AUTO_DEDUP_TABLE.replace('.', '\\.'), 'g'))?.length).toBe(1)
      expect(sql).not.toMatch(/ulp\.credentials(?!_cdedup_auto)\b/)
      expect(sql).not.toContain('expected_rows')
    })
  })

  describe('total/distinctCreds alias consistency', () => {
    test('buildContentKeyStatsSql and buildVerifyDedupedTableStatsSql use the same field aliases -- queryContentKeyStats depends on this to stay generic across both', () => {
      const statsSql = buildContentKeyStatsSql()
      const verifySql = buildVerifyDedupedTableStatsSql()
      expect(statsSql).toContain('AS total')
      expect(statsSql).toContain('AS distinctCreds')
      expect(verifySql).toContain('AS total')
      expect(verifySql).toContain('AS distinctCreds')
    })
  })

  describe('buildRenameSwapSql', () => {
    test('atomically renames the original to the predup name and the deduped copy into place', () => {
      const sql = buildRenameSwapSql()
      expect(sql).toBe(`RENAME TABLE ulp.credentials TO ${AUTO_PREDUP_TABLE}, ${AUTO_DEDUP_TABLE} TO ulp.credentials`)
    })
  })

  describe('buildCatchupInsertSql', () => {
    // ClickHouse builds an IN-subquery's hash set fully in memory, with no disk
    // spill. A `NOT IN (SELECT <key> FROM ulp.credentials)` over the WHOLE live
    // table needs a set of every distinct content key: at 1.39B keys that is a
    // ~34 GB open-addressing table (8-byte slots, <= 50% fill) against this
    // server's 18 GiB per-query limit. It passed when the table had ~467M keys
    // (2026-07) and could not have passed at today's scale -- and the catch-up
    // runs AFTER the swap, so the failure would surface only at the very end of
    // a ~2h cutover. Only the recent rows' keys matter, so the set must be built
    // from THEM and the big table only probed against it.
    test('never builds an in-memory set over every key of the live table: the big table is only probed against the (tiny) set of candidate keys', () => {
      const sql = buildCatchupInsertSql('2026-07-07 15:07:51')
      expect(sql).not.toContain(`NOT IN (SELECT cityHash64(${CONTENT_KEY}) FROM ulp.credentials)`)
      expect(sql).toContain(
        `cityHash64(${CONTENT_KEY}) NOT IN (SELECT content_key_hash FROM ulp.credentials WHERE content_key_hash IN (SELECT cityHash64(${CONTENT_KEY}) FROM ${AUTO_PREDUP_TABLE} WHERE imported_at > '2026-07-07 15:07:51'))`,
      )
    })

    test('copies rows imported after cutoff, excluding content keys already present, deduplicated against itself, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildCatchupInsertSql('2026-07-07 15:07:51')
      expect(sql).toContain('INSERT INTO ulp.credentials')
      expect(sql).toContain(`SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0)) AS was_duplicated) FROM ${AUTO_PREDUP_TABLE}`)
      expect(sql).toContain("WHERE imported_at > '2026-07-07 15:07:51'")
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

  describe('populateDedupedTableWithGuard', () => {
    function fakeClient() {
      return { exec: vi.fn().mockResolvedValue(undefined) } as unknown as { exec: ReturnType<typeof vi.fn> }
    }

    function fakeGuard(overrides: Partial<DiskGuard> = {}): DiskGuard {
      return {
        preflight: vi.fn().mockResolvedValue(undefined),
        checkBeforeIteration: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      }
    }

    test('calls preflight once, then checkBeforeIteration + populate once per bucket, in order', async () => {
      const client = fakeClient()
      const guard = fakeGuard()

      await populateDedupedTableWithGuard(client as any, 3, guard)

      expect(guard.preflight).toHaveBeenCalledTimes(1)
      expect(guard.checkBeforeIteration).toHaveBeenCalledTimes(3)
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(1, undefined, { index: 0, total: 3 })
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(2, undefined, { index: 1, total: 3 })
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(3, undefined, { index: 2, total: 3 })
      expect(client.exec).toHaveBeenCalledTimes(3)
    })

    test('drops AUTO_DEDUP_TABLE and re-throws when the guard trips with a DiskHeadroomError', async () => {
      const client = fakeClient()
      const tripError = new DiskHeadroomError('floor-breached', 'nope', null, null)
      const guard = fakeGuard({
        checkBeforeIteration: vi.fn()
          .mockResolvedValueOnce(undefined) // bucket 0: fine
          .mockRejectedValueOnce(tripError), // bucket 1: trips
      })

      await expect(populateDedupedTableWithGuard(client as any, 5, guard)).rejects.toBe(tripError)

      // Only bucket 0's populate ran -- bucket 1's guard check threw before its populate call.
      expect(client.exec).toHaveBeenCalledTimes(2) // 1 populate (bucket 0) + 1 DROP TABLE cleanup
      expect(client.exec).toHaveBeenLastCalledWith({ query: expect.stringContaining(`DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE} SYNC`) })
    })

    test('re-throws without a DROP TABLE cleanup when the guard throws something other than DiskHeadroomError', async () => {
      const client = fakeClient()
      const otherError = new Error('unrelated failure')
      const guard = fakeGuard({
        checkBeforeIteration: vi.fn().mockRejectedValueOnce(otherError),
      })

      await expect(populateDedupedTableWithGuard(client as any, 5, guard)).rejects.toBe(otherError)

      expect(client.exec).not.toHaveBeenCalled() // no populate (failed before it), and no DROP TABLE (not a DiskHeadroomError)
    })
  })
})
