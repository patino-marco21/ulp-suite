import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn().mockResolvedValue([]),
}))

import { buildLegacyProbeQuery, resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { executeQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

const mockExecuteQuery = vi.mocked(executeQuery)

beforeEach(() => {
  vi.clearAllMocks()
  mockExecuteQuery.mockResolvedValue([])
})

const DOMAINS = [
  'bitbox.team', 'bitkey.world', 'blockstream.com', 'coldcard.com', 'cypherock.com', 'dcentwallet.com',
  'ellipal.com', 'foundation.xyz', 'gridplus.io', 'keepkey.com', 'keyst.one', 'ledger.com', 'ngrave.io',
  'onekey.so', 'safepal.com', 'tangem.com', 'trezor.io',
]

describe('buildLegacyProbeQuery — the legacy-normalization scan normalizes each row once', () => {
  test('filters the primary key on the RAW domain column in the innermost query', () => {
    const { sql } = buildLegacyProbeQuery(DOMAINS, 'both', 90)
    const innermost = sql.slice(sql.lastIndexOf('SELECT url, email, password, domain,'), sql.indexOf('WHERE domain IN {legacyDomains:Array(String)}'))
    expect(innermost).toContain('FROM ulp.credentials')
    expect(sql).toContain('WHERE domain IN {legacyDomains:Array(String)}')
    // A helper alias named like a stored column would shadow it inside the WHERE and defeat the pruning.
    expect(sql).not.toMatch(/\bAS (url|email|password)\b/i)
  })

  test('applies the set match to the precomputed columns, not per-domain NORM_* text', () => {
    const { sql, params } = buildLegacyProbeQuery(DOMAINS, 'both', 90)
    expect(sql).toContain('arrayExists((d, s) -> nd = d OR endsWith(nd, s)')
    expect(sql).not.toMatch(/\{domain\d+:String\}/)
    expect(params.matchDomains).toEqual(DOMAINS)
    expect((params.matchSuffixes as string[])[0]).toBe('.bitbox.team')
    // The SQL text must not grow with the number of domains (it used to repeat the NORM_* text per domain).
    const small = buildLegacyProbeQuery(['a.com'], 'both', 90).sql
    expect(sql).toBe(small)
  })

  test('still normalizes the displayed domain for the surviving rows, orders by the key prefix and limits', () => {
    const { sql, params } = buildLegacyProbeQuery(DOMAINS, 'url', 90)
    expect(sql.startsWith(`SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain`)).toBe(true)
    expect(sql).toContain('ORDER BY domain, email')
    expect(sql).toContain('LIMIT {matchLimit:UInt32}')
    expect(sql).toContain('http_wait_end_of_query = 1')
    expect(sql).toContain('max_execution_time = 90')
    expect(params.legacyDomains).toEqual(['', 'http', 'https'])
    expect(params.matchLimit).toBe(100)
  })

  test('credential mode does not compute the normalized url column it will not use', () => {
    const { sql } = buildLegacyProbeQuery(DOMAINS, 'credential', 90)
    expect(sql).not.toContain(' AS nd')
    expect(sql).toContain(' AS ne')
  })
})

describe('resolveMonitorMatches — the legacy probe goes through the normalize-once query', () => {
  test('sends the new query (with the array params) as the legacy scan', async () => {
    mockExecuteQuery.mockImplementation(async (sql: string) => (sql.includes('system.projection_parts') ? [{ parts: '8', with_projection: '8' }] : []))
    await resolveMonitorMatches('both', ['legacy-probe.example'])
    const legacyCall = mockExecuteQuery.mock.calls.find(([sql]) => String(sql).includes('domain IN {legacyDomains'))!
    expect(legacyCall).toBeDefined()
    expect(String(legacyCall[0])).toContain('arrayExists(')
    expect(legacyCall[1]).toMatchObject({ matchDomains: ['legacy-probe.example'], legacyDomains: ['', 'http', 'https'] })
  })
})
