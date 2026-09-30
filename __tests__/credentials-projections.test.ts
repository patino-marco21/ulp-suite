import { readFileSync } from 'fs'
import { describe, test, expect, vi } from 'vitest'
import { DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
import {
  IMPORTED_DESC_PROJECTION_BODY,
  stripProjectionsFromCreateTableDdl,
  buildAddImportedDescProjectionSql,
  buildRecentPartitionsSql,
  buildMaterializeProjectionSql,
  restoreImportedDescProjection,
} from '@/lib/credentials-projections'

// Mirrors the exact formatting ClickHouse 26.3's SHOW CREATE TABLE produced for
// the live ulp.credentials on 2026-09-30 -- columns and most indexes trimmed
// for brevity, but both PROJECTION blocks are verbatim (including
// proj_domain_reversed, an orphan from an abandoned experiment that only this
// instance has -- see lib/credentials-projections.ts).
const LIVE_DDL = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`domain\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1)),
    INDEX idx_bf_email email TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_ngram_domain domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1,
    PROJECTION proj_imported_desc
    (
        SELECT
            url,
            email,
            password,
            source_file,
            breach_name,
            country_tier,
            login_type,
            password_length,
            password_mask,
            url_scheme,
            is_corporate_email,
            email_domain,
            url_host,
            password_entropy_band,
            imported_at,
            domain
        ORDER BY
            negate(toUnixTimestamp(imported_at)),
            domain,
            email,
            url,
            password
    ),
    PROJECTION proj_domain_reversed
    (
        SELECT
            url,
            email,
            password,
            domain,
            email_domain,
            imported_at
        ORDER BY reverse(domain)
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials_cdedup_auto_1784508692786', '{replica}')
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

const LIVE_DDL_WITHOUT_PROJECTIONS = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`domain\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1)),
    INDEX idx_bf_email email TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_ngram_domain domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials_cdedup_auto_1784508692786', '{replica}')
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

describe('credentials-projections', () => {
  describe('stripProjectionsFromCreateTableDdl', () => {
    test('removes every PROJECTION block and leaves everything else byte-for-byte intact, with no dangling comma before the closing paren', () => {
      expect(stripProjectionsFromCreateTableDdl(LIVE_DDL)).toBe(LIVE_DDL_WITHOUT_PROJECTIONS)
    })

    test('keeps every column and skip index -- only projections are deferred, not the search indexes', () => {
      const result = stripProjectionsFromCreateTableDdl(LIVE_DDL)
      expect(result).toContain('INDEX idx_bf_email')
      expect(result).toContain('INDEX idx_ngram_domain')
      expect(result).toContain('`imported_at` DateTime')
      expect(result).not.toContain('PROJECTION')
    })

    test('is a no-op on DDL that has no projections, and idempotent', () => {
      expect(stripProjectionsFromCreateTableDdl(LIVE_DDL_WITHOUT_PROJECTIONS)).toBe(LIVE_DDL_WITHOUT_PROJECTIONS)
      const once = stripProjectionsFromCreateTableDdl(LIVE_DDL)
      expect(stripProjectionsFromCreateTableDdl(once)).toBe(once)
    })

    test('removes a projection that is not the last element without leaving a doubled or missing comma', () => {
      const midList = `CREATE TABLE ulp.credentials
(
    \`url\` String,
    INDEX a url TYPE minmax GRANULARITY 1,
    PROJECTION p
    (
        SELECT url
        ORDER BY url
    ),
    INDEX b url TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree()
ORDER BY url`
      const expected = `CREATE TABLE ulp.credentials
(
    \`url\` String,
    INDEX a url TYPE minmax GRANULARITY 1,
    INDEX b url TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree()
ORDER BY url`
      expect(stripProjectionsFromCreateTableDdl(midList)).toBe(expected)
    })

    // Defense in depth, same rationale as rewriteCreateTableDdl's "throws if the
    // rewrite didn't land": if a future ClickHouse prints projections in a shape
    // this line-based strip doesn't recognise, silently returning DDL that still
    // has them would just rebuild the full-size table the strip exists to avoid
    // -- fail loudly instead (runContentDedupTick's outer try/catch handles it).
    test('throws if a PROJECTION survives because its formatting was not recognised', () => {
      const unrecognised = `CREATE TABLE ulp.credentials
(
    \`url\` String,
    PROJECTION p (SELECT url ORDER BY url)
)
ENGINE = MergeTree()
ORDER BY url`
      expect(() => stripProjectionsFromCreateTableDdl(unrecognised)).toThrow(/PROJECTION/)
    })
  })

  describe('IMPORTED_DESC_PROJECTION_BODY', () => {
    const normalize = (s: string) => s.replace(/\s+/g, '')

    test('is exactly the proj_imported_desc definition the live table carries (whitespace aside) -- restore must reproduce what the strip removed', () => {
      const liveBlock = LIVE_DDL.match(/PROJECTION proj_imported_desc\s*\(([\s\S]*?)\n    \),\n    PROJECTION proj_domain_reversed/)?.[1]
      expect(liveBlock).toBeDefined()
      expect(normalize(IMPORTED_DESC_PROJECTION_BODY)).toBe(normalize(liveBlock!))
    })

    test('is shared with migration v14 rather than duplicated, so the two cannot drift apart', () => {
      const source = readFileSync(new URL('../lib/clickhouse-migrations.ts', import.meta.url), 'utf8')
      expect(source).toContain('IMPORTED_DESC_PROJECTION_BODY')
    })
  })

  describe('SQL builders', () => {
    test('buildAddImportedDescProjectionSql is idempotent (IF NOT EXISTS) and embeds the shared body', () => {
      const sql = buildAddImportedDescProjectionSql()
      expect(sql).toContain('ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_imported_desc')
      expect(sql).toContain(IMPORTED_DESC_PROJECTION_BODY)
    })

    test('buildRecentPartitionsSql selects partitions at or after the cutoff -- the complement of projection-scope\'s buildEligiblePartitionsSql', () => {
      const sql = buildRecentPartitionsSql('202608')
      expect(sql).toContain(`partition >= '202608'`)
      expect(sql).toContain(`database = 'ulp' AND table = 'credentials'`)
      expect(sql).toContain('active')
    })

    // Newest first: "browse newest first" is what the projection serves, so the
    // most recent data gets the speedup soonest -- and, since newer partitions
    // are usually the smaller ones, the disk guard's linear projection
    // (average growth so far x iterations remaining) is not thrown off by a big
    // partition going first and over-projecting the rest.
    test('buildRecentPartitionsSql orders newest partition first', () => {
      expect(buildRecentPartitionsSql('202608')).toContain('ORDER BY partition DESC')
    })

    test('buildMaterializeProjectionSql targets one partition, waits for completion, and stays under the client\'s 1h request timeout', () => {
      const sql = buildMaterializeProjectionSql('202608')
      expect(sql).toContain(`MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202608'`)
      expect(sql).toContain('mutations_sync = 1')
      expect(sql).toContain('max_execution_time = 3300')
      expect(sql).toContain(`timeout_overflow_mode = 'throw'`)
    })
  })

  describe('restoreImportedDescProjection', () => {
    function fakeClient(partitions: string[]) {
      return {
        exec: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ json: async () => partitions.map(partition => ({ partition })) }),
      }
    }

    function fakeGuard(overrides: Partial<DiskGuard> = {}): DiskGuard {
      return {
        preflight: vi.fn().mockResolvedValue(undefined),
        checkBeforeIteration: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      }
    }

    const now = new Date('2026-09-30T12:00:00Z')

    test('adds the projection first (metadata-only), then materializes each in-window partition in order, guarding each one', async () => {
      const client = fakeClient(['202608', '202609'])
      const guard = fakeGuard()

      const result = await restoreImportedDescProjection(client as any, guard, { now })

      expect(result.partitions).toEqual(['202608', '202609'])
      expect(client.exec.mock.calls.map(c => c[0].query)).toEqual([
        buildAddImportedDescProjectionSql(),
        buildMaterializeProjectionSql('202608'),
        buildMaterializeProjectionSql('202609'),
      ])
      expect(guard.preflight).toHaveBeenCalledTimes(1)
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(1, undefined, { index: 0, total: 2 })
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(2, undefined, { index: 1, total: 2 })
    })

    test('scopes to the same recency window projection-scope uses: default 2 months back from now', async () => {
      const client = fakeClient(['202608'])
      await restoreImportedDescProjection(client as any, fakeGuard(), { now })
      // now = 2026-09-30, window = 2 months -> cutoff 202607
      expect(client.query.mock.calls[0][0].query).toContain(`partition >= '202607'`)
    })

    test('with no in-window partitions it still adds the projection (so new inserts get it) but materializes nothing', async () => {
      const client = fakeClient([])
      const guard = fakeGuard()

      const result = await restoreImportedDescProjection(client as any, guard, { now })

      expect(result.partitions).toEqual([])
      expect(client.exec).toHaveBeenCalledTimes(1)
      expect(client.exec).toHaveBeenCalledWith({ query: buildAddImportedDescProjectionSql() })
    })

    // The opposite of populateDedupedTableWithGuard's trip handling: there the
    // half-built AUTO_DEDUP_TABLE is disposable, so a trip drops it. Here the
    // table IS the live ulp.credentials -- a trip must never drop anything.
    test('re-throws a disk-guard trip WITHOUT dropping anything -- this table is the live one -- and stops before the next partition', async () => {
      const client = fakeClient(['202608', '202609'])
      const tripError = new DiskHeadroomError('projected-breach', 'nope', null, null)
      const guard = fakeGuard({
        checkBeforeIteration: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(tripError),
      })

      await expect(restoreImportedDescProjection(client as any, guard, { now })).rejects.toBe(tripError)

      const statements = client.exec.mock.calls.map(c => c[0].query as string)
      expect(statements).toEqual([buildAddImportedDescProjectionSql(), buildMaterializeProjectionSql('202608')])
      expect(statements.some(s => /DROP/i.test(s))).toBe(false)
    })

    test('a failed preflight aborts before any partition is materialized', async () => {
      const client = fakeClient(['202608'])
      const tripError = new DiskHeadroomError('floor-breached', 'full', null, null)
      const guard = fakeGuard({ preflight: vi.fn().mockRejectedValue(tripError) })

      await expect(restoreImportedDescProjection(client as any, guard, { now })).rejects.toBe(tripError)

      expect(client.exec.mock.calls.map(c => c[0].query)).toEqual([buildAddImportedDescProjectionSql()])
    })
  })
})
