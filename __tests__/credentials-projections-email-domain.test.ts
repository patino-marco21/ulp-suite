import { describe, test, expect, vi } from 'vitest'
import { DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
import {
  EMAIL_DOMAIN_REV_PROJECTION_NAME,
  EMAIL_DOMAIN_REV_PROJECTION_BODY,
  buildAddEmailDomainRevProjectionSql,
  buildPartitionsMissingEmailDomainRevSql,
  buildMaterializeEmailDomainRevProjectionSql,
  buildEmailDomainRevProjectionReadySql,
  emailDomainRevProjectionReady,
  isEmailDomainRevProjectionReady,
  restoreEmailDomainRevProjection,
  stripProjectionsFromCreateTableDdl,
} from '@/lib/credentials-projections'

// Verbatim SHOW CREATE TABLE (ClickHouse 26.3.17, 2026-09-30): the partial projection
// prints `SELECT _part_offset` on one line, unlike a normal projection's one-column-per-line body.
const DDL_WITH_PARTIAL_PROJECTION = `CREATE TABLE ulp.zz_fixture_proj
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`domain\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1)),
    \`email_domain\` String MATERIALIZED lower(substringIndex(email, '@', -1)),
    INDEX idx_bf_email email TYPE bloom_filter(0.05) GRANULARITY 1,
    PROJECTION proj_imported_desc
    (
        SELECT
            url,
            email,
            email_domain,
            imported_at,
            domain
        ORDER BY
            negate(toUnixTimestamp(imported_at)),
            domain,
            email,
            url
    ),
    PROJECTION proj_email_domain_rev
    (
        SELECT _part_offset
        ORDER BY reverse(email_domain)
    )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

const DDL_WITH_PARTIAL_PROJECTION_STRIPPED = `CREATE TABLE ulp.zz_fixture_proj
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`domain\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1)),
    \`email_domain\` String MATERIALIZED lower(substringIndex(email, '@', -1)),
    INDEX idx_bf_email email TYPE bloom_filter(0.05) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

describe('credentials-projections — proj_email_domain_rev', () => {
  describe('definition', () => {
    const normalize = (s: string) => s.replace(/\s+/g, '')

    test('is named proj_email_domain_rev and ordered by the reversed email_domain', () => {
      expect(EMAIL_DOMAIN_REV_PROJECTION_NAME).toBe('proj_email_domain_rev')
      expect(normalize(EMAIL_DOMAIN_REV_PROJECTION_BODY)).toBe('SELECT_part_offsetORDERBYreverse(email_domain)')
    })

    test('is exactly what the live table prints for the partial projection (whitespace aside) -- restore must reproduce what the strip removes', () => {
      const liveBlock = DDL_WITH_PARTIAL_PROJECTION.match(/PROJECTION proj_email_domain_rev\s*\(([\s\S]*?)\n    \)\n\)/)?.[1]
      expect(liveBlock).toBeDefined()
      expect(normalize(EMAIL_DOMAIN_REV_PROJECTION_BODY)).toBe(normalize(liveBlock!))
    })
  })

  describe('stripProjectionsFromCreateTableDdl with a partial projection (real SHOW CREATE TABLE shape)', () => {
    test('strips both the normal and the partial projection and fixes the trailing comma', () => {
      expect(stripProjectionsFromCreateTableDdl(DDL_WITH_PARTIAL_PROJECTION)).toBe(DDL_WITH_PARTIAL_PROJECTION_STRIPPED)
    })
  })

  describe('SQL builders', () => {
    test('ADD is idempotent (IF NOT EXISTS) and embeds the shared body', () => {
      const sql = buildAddEmailDomainRevProjectionSql()
      expect(sql).toContain('ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_email_domain_rev')
      expect(sql).toContain(EMAIL_DOMAIN_REV_PROJECTION_BODY)
    })

    test('the partition query returns only partitions that still have a part without the projection, newest first', () => {
      const sql = buildPartitionsMissingEmailDomainRevSql()
      expect(sql).toContain(`database = 'ulp' AND table = 'credentials' AND active`)
      expect(sql).toContain('NOT IN')
      expect(sql).toContain('parent_name')
      expect(sql).toContain('system.projection_parts')
      expect(sql).toContain(`name = 'proj_email_domain_rev'`)
      expect(sql).toContain('ORDER BY partition DESC')
    })

    test('MATERIALIZE targets one partition, waits, and stays under the client 1h request timeout', () => {
      const sql = buildMaterializeEmailDomainRevProjectionSql('202608')
      expect(sql).toContain(`MATERIALIZE PROJECTION proj_email_domain_rev IN PARTITION '202608'`)
      expect(sql).toContain('mutations_sync = 1')
      expect(sql).toContain('max_execution_time = 3300')
      expect(sql).toContain(`timeout_overflow_mode = 'throw'`)
    })

    test('the readiness query compares active parts with active projection parts', () => {
      const sql = buildEmailDomainRevProjectionReadySql()
      expect(sql).toContain('FROM system.parts')
      expect(sql).toContain('FROM system.projection_parts')
      expect(sql).toContain(`name = 'proj_email_domain_rev'`)
      expect(sql).toContain('AS parts')
      expect(sql).toContain('AS with_projection')
    })
  })

  describe('readiness decision', () => {
    test('ready only when there are parts and every one carries the projection', () => {
      expect(emailDomainRevProjectionReady({ parts: 8, withProjection: 8 })).toBe(true)
    })
    test('not ready when only some parts carry it (mixed state: the rewritten predicate would partly full-scan)', () => {
      expect(emailDomainRevProjectionReady({ parts: 8, withProjection: 5 })).toBe(false)
    })
    test('not ready with no parts or none carrying it', () => {
      expect(emailDomainRevProjectionReady({ parts: 0, withProjection: 0 })).toBe(false)
      expect(emailDomainRevProjectionReady({ parts: 8, withProjection: 0 })).toBe(false)
    })
    test('not ready for non-numeric input', () => {
      expect(emailDomainRevProjectionReady({ parts: NaN, withProjection: NaN })).toBe(false)
    })
  })

  describe('isEmailDomainRevProjectionReady', () => {
    test('runs the readiness query and reads the UInt64-as-string counts', async () => {
      const run = vi.fn().mockResolvedValue([{ parts: '8', with_projection: '8' }])
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(true)
      expect(run).toHaveBeenCalledWith(buildEmailDomainRevProjectionReadySql())
    })
    test('false for a partly built projection', async () => {
      const run = vi.fn().mockResolvedValue([{ parts: '8', with_projection: '3' }])
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(false)
    })
    test('false for an empty result', async () => {
      const run = vi.fn().mockResolvedValue([])
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(false)
    })
    test('fails closed (false, with a warning) when the query throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = vi.fn().mockRejectedValue(new Error('connection refused'))
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(false)
      expect(warn.mock.calls.some(c => String(c[0]).includes('readiness check failed'))).toBe(true)
      warn.mockRestore()
    })
  })

  describe('restoreEmailDomainRevProjection', () => {
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

    test('adds the projection first, then materializes each partition that still lacks it, guarding each one', async () => {
      const client = fakeClient(['202608', '202607'])
      const guard = fakeGuard()

      const result = await restoreEmailDomainRevProjection(client as any, guard)

      expect(result.partitions).toEqual(['202608', '202607'])
      expect(client.query.mock.calls[0][0].query).toBe(buildPartitionsMissingEmailDomainRevSql())
      expect(client.exec.mock.calls.map(c => c[0].query)).toEqual([
        buildAddEmailDomainRevProjectionSql(),
        buildMaterializeEmailDomainRevProjectionSql('202608'),
        buildMaterializeEmailDomainRevProjectionSql('202607'),
      ])
      expect(guard.preflight).toHaveBeenCalledTimes(1)
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(1, undefined, { index: 0, total: 2 })
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(2, undefined, { index: 1, total: 2 })
    })

    test('is a no-op beyond the idempotent ADD when every partition already has the projection', async () => {
      const client = fakeClient([])
      const guard = fakeGuard()

      const result = await restoreEmailDomainRevProjection(client as any, guard)

      expect(result.partitions).toEqual([])
      expect(client.exec).toHaveBeenCalledTimes(1)
      expect(client.exec).toHaveBeenCalledWith({ query: buildAddEmailDomainRevProjectionSql() })
      expect(guard.preflight).not.toHaveBeenCalled()
    })

    test('re-throws a disk-guard trip WITHOUT dropping anything -- this is the live table -- and stops before the next partition', async () => {
      const client = fakeClient(['202608', '202607'])
      const tripError = new DiskHeadroomError('projected-breach', 'nope', null, null)
      const guard = fakeGuard({
        checkBeforeIteration: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(tripError),
      })

      await expect(restoreEmailDomainRevProjection(client as any, guard)).rejects.toBe(tripError)

      const statements = client.exec.mock.calls.map(c => c[0].query as string)
      expect(statements).toEqual([
        buildAddEmailDomainRevProjectionSql(),
        buildMaterializeEmailDomainRevProjectionSql('202608'),
      ])
      expect(statements.some(s => /DROP/i.test(s))).toBe(false)
    })
  })
})
