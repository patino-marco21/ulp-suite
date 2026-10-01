import { readFileSync } from 'fs'
import { describe, test, expect, vi } from 'vitest'
import { DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
import {
  DOMAIN_REV_PROJECTION_NAME,
  DOMAIN_REV_PROJECTION_BODY,
  EMAIL_DOMAIN_REV_PROJECTION_NAME,
  buildAddDomainRevProjectionSql,
  buildPartitionsMissingDomainRevSql,
  buildMaterializeDomainRevProjectionSql,
  buildDomainRevProjectionReadySql,
  buildEmailDomainRevProjectionReadySql,
  isDomainRevProjectionReady,
  reversedKeyProjectionReady,
  restoreDomainRevProjection,
  stripProjectionsFromCreateTableDdl,
} from '@/lib/credentials-projections'

// Shape of the live SHOW CREATE TABLE (ClickHouse 26.3.17, 2026-09-30) with all three projections:
// the partial ones print `SELECT _part_offset` on one line (checked verbatim on a sandbox table).
const DDL_WITH_THREE_PROJECTIONS = `CREATE TABLE ulp.zz_fixture_proj
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
            domain
        ORDER BY
            negate(toUnixTimestamp(imported_at)),
            domain
    ),
    PROJECTION proj_email_domain_rev
    (
        SELECT _part_offset
        ORDER BY reverse(email_domain)
    ),
    PROJECTION proj_domain_rev
    (
        SELECT _part_offset
        ORDER BY reverse(domain)
    )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

const DDL_STRIPPED = `CREATE TABLE ulp.zz_fixture_proj
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

describe('credentials-projections — proj_domain_rev', () => {
  describe('definition', () => {
    const normalize = (s: string) => s.replace(/\s+/g, '')

    test('is named proj_domain_rev and ordered by the reversed domain', () => {
      expect(DOMAIN_REV_PROJECTION_NAME).toBe('proj_domain_rev')
      expect(normalize(DOMAIN_REV_PROJECTION_BODY)).toBe('SELECT_part_offsetORDERBYreverse(domain)')
    })

    test('is exactly what the live table prints for the projection (whitespace aside) -- restore must reproduce what the strip removes', () => {
      const liveBlock = DDL_WITH_THREE_PROJECTIONS.match(/PROJECTION proj_domain_rev\s*\(([\s\S]*?)\n    \)\n\)/)?.[1]
      expect(liveBlock).toBeDefined()
      expect(normalize(DOMAIN_REV_PROJECTION_BODY)).toBe(normalize(liveBlock!))
    })

    test('is a partial projection: it stores no columns, so the planner cannot use it as a thin covering copy', () => {
      // The retired proj_domain_reversed was a covering copy and made the monitor's scans ~6x slower.
      expect(DOMAIN_REV_PROJECTION_BODY).toMatch(/^SELECT _part_offset\b/)
    })
  })

  test('stripProjectionsFromCreateTableDdl removes all three projections and fixes the trailing comma', () => {
    expect(stripProjectionsFromCreateTableDdl(DDL_WITH_THREE_PROJECTIONS)).toBe(DDL_STRIPPED)
  })

  describe('SQL builders', () => {
    test('ADD is idempotent (IF NOT EXISTS) and embeds the shared body', () => {
      const sql = buildAddDomainRevProjectionSql()
      expect(sql).toContain('ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_domain_rev')
      expect(sql).toContain(DOMAIN_REV_PROJECTION_BODY)
    })

    test('the partition query returns only partitions with a part lacking THIS projection, newest first', () => {
      const sql = buildPartitionsMissingDomainRevSql()
      expect(sql).toContain(`database = 'ulp' AND table = 'credentials' AND active`)
      expect(sql).toContain('NOT IN')
      expect(sql).toContain('parent_name')
      expect(sql).toContain('system.projection_parts')
      expect(sql).toContain(`name = 'proj_domain_rev'`)
      expect(sql).not.toContain('proj_email_domain_rev')
      expect(sql).toContain('ORDER BY partition DESC')
    })

    test('MATERIALIZE targets one partition, waits, and stays under the client 1h request timeout', () => {
      const sql = buildMaterializeDomainRevProjectionSql('202608')
      expect(sql).toContain(`MATERIALIZE PROJECTION proj_domain_rev IN PARTITION '202608'`)
      expect(sql).toContain('mutations_sync = 1')
      expect(sql).toContain('max_execution_time = 3300')
      expect(sql).toContain(`timeout_overflow_mode = 'throw'`)
    })

    test('the readiness query compares active parts with active parts carrying THIS projection', () => {
      const sql = buildDomainRevProjectionReadySql()
      expect(sql).toContain('FROM system.parts')
      expect(sql).toContain('FROM system.projection_parts')
      expect(sql).toContain(`name = 'proj_domain_rev'`)
      expect(sql).toContain('AS parts')
      expect(sql).toContain('AS with_projection')
    })

    test('the two reversed-key projections never share a readiness query (one being built must not unlock the other)', () => {
      expect(buildDomainRevProjectionReadySql()).not.toBe(buildEmailDomainRevProjectionReadySql())
      expect(buildEmailDomainRevProjectionReadySql()).toContain(`name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}'`)
    })
  })

  describe('readiness decision (shared by both projections)', () => {
    test('ready only when there are parts and every one carries the projection', () => {
      expect(reversedKeyProjectionReady({ parts: 8, withProjection: 8 })).toBe(true)
      expect(reversedKeyProjectionReady({ parts: 8, withProjection: 5 })).toBe(false)
      expect(reversedKeyProjectionReady({ parts: 0, withProjection: 0 })).toBe(false)
      expect(reversedKeyProjectionReady({ parts: NaN, withProjection: NaN })).toBe(false)
    })
  })

  describe('isDomainRevProjectionReady', () => {
    test('runs the domain readiness query and reads the UInt64-as-string counts', async () => {
      const run = vi.fn().mockResolvedValue([{ parts: '8', with_projection: '8' }])
      await expect(isDomainRevProjectionReady(run)).resolves.toBe(true)
      expect(run).toHaveBeenCalledWith(buildDomainRevProjectionReadySql())
    })
    test('false for a partly built projection', async () => {
      const run = vi.fn().mockResolvedValue([{ parts: '8', with_projection: '3' }])
      await expect(isDomainRevProjectionReady(run)).resolves.toBe(false)
    })
    test('false for an empty result', async () => {
      const run = vi.fn().mockResolvedValue([])
      await expect(isDomainRevProjectionReady(run)).resolves.toBe(false)
    })
    test('fails closed (false, with a warning naming the projection) when the query throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = vi.fn().mockRejectedValue(new Error('connection refused'))
      await expect(isDomainRevProjectionReady(run)).resolves.toBe(false)
      expect(warn.mock.calls.some(c => String(c[0]).includes('proj_domain_rev readiness check failed'))).toBe(true)
      warn.mockRestore()
    })
  })

  describe('restoreDomainRevProjection', () => {
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

      const result = await restoreDomainRevProjection(client as any, guard)

      expect(result.partitions).toEqual(['202608', '202607'])
      expect(client.query.mock.calls[0][0].query).toBe(buildPartitionsMissingDomainRevSql())
      expect(client.exec.mock.calls.map(c => c[0].query)).toEqual([
        buildAddDomainRevProjectionSql(),
        buildMaterializeDomainRevProjectionSql('202608'),
        buildMaterializeDomainRevProjectionSql('202607'),
      ])
      expect(guard.preflight).toHaveBeenCalledTimes(1)
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(1, undefined, { index: 0, total: 2 })
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(2, undefined, { index: 1, total: 2 })
    })

    test('is a no-op beyond the idempotent ADD when every partition already has the projection', async () => {
      const client = fakeClient([])
      const guard = fakeGuard()

      const result = await restoreDomainRevProjection(client as any, guard)

      expect(result.partitions).toEqual([])
      expect(client.exec).toHaveBeenCalledTimes(1)
      expect(client.exec).toHaveBeenCalledWith({ query: buildAddDomainRevProjectionSql() })
      expect(guard.preflight).not.toHaveBeenCalled()
    })

    test('re-throws a disk-guard trip WITHOUT dropping anything -- this is the live table -- and stops before the next partition', async () => {
      const client = fakeClient(['202608', '202607'])
      const tripError = new DiskHeadroomError('projected-breach', 'nope', null, null)
      const guard = fakeGuard({
        checkBeforeIteration: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(tripError),
      })

      await expect(restoreDomainRevProjection(client as any, guard)).rejects.toBe(tripError)

      const statements = client.exec.mock.calls.map(c => c[0].query as string)
      expect(statements).toEqual([
        buildAddDomainRevProjectionSql(),
        buildMaterializeDomainRevProjectionSql('202608'),
      ])
      expect(statements.some(s => /DROP/i.test(s))).toBe(false)
    })
  })
})

describe('schema plumbing for proj_domain_rev', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  test('DDL v24 adds the projection through the shared builder and does NOT materialize at deploy', () => {
    const src = read('../lib/clickhouse-migrations.ts')
    expect(src).toMatch(/const DDL_VERSION = (2[4-9]|[3-9]\d)\b/)
    const start = src.indexOf('if (lastDdl < 24)')
    // the v24 block ends where the next version's block begins
    const block = src.slice(start, src.indexOf('if (lastDdl <', start + 1))
    expect(block).toContain('buildAddDomainRevProjectionSql()')
    expect(block).not.toContain('MATERIALIZE')
  })

  test('the init SQL mirror carries the same projection body for fresh installs', () => {
    const sql = read('../docker/clickhouse/init/01-ulp-tables.sql')
    expect(sql).toContain('PROJECTION proj_domain_rev')
    expect(sql).toMatch(/SELECT _part_offset\s+ORDER BY reverse\(domain\)/)
  })

  test('the dedup tick restores the small reversed-key projections first, the large proj_imported_desc last', () => {
    const src = read('../lib/content-dedup.ts')
    const tick = src.slice(src.indexOf('export async function runContentDedupTick'))
    const email = tick.indexOf('restoreEmailDomainRevProjection(')
    const domain = tick.indexOf('restoreDomainRevProjection(')
    const imported = tick.indexOf('restoreImportedDescProjection(')
    expect(email).toBeGreaterThan(-1)
    expect(domain).toBeGreaterThan(email)
    expect(imported).toBeGreaterThan(domain)
  })

  test('the one-off script can restore just the domain projection, and --restore-projections covers all three', () => {
    const script = read('../scripts/run-content-dedup-once.ts')
    expect(script).toContain('--restore-domain-projection')
    expect(script).toContain('--restore-projections')
    expect(script).toContain('restoreDomainRevProjection')
    expect(script).toContain('restoreEmailDomainRevProjection')
    expect(script).toContain('restoreImportedDescProjection')
  })
})
