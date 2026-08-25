import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
  // lib/domain-match.ts's domainConditionSQL unconditionally references
  // NORM_EMAIL_EXPR too (even for mode 'url'), so Vitest's strict mock-export
  // binding throws without this — the brief's mock only stubbed
  // NORM_DOMAIN_EXPR. No test here asserts on its value.
  NORM_EMAIL_EXPR: 'email',
}))

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn().mockResolvedValue([]),
}))

import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { executeQuery } from '@/lib/clickhouse'

const mockExecuteQuery = vi.mocked(executeQuery)

beforeEach(() => {
  vi.clearAllMocks()
  mockExecuteQuery.mockResolvedValue([])
})

// Each test below that calls resolveMonitorMatches uses its own domain, never
// reused across tests in this file. The resolver caches phase-1 results
// per (mode, domains) in a module-level Map that beforeEach's
// vi.clearAllMocks() does NOT reset (it clears mock call history, not this
// module's own state) — reusing a domain would let one test's cached
// resolution silently starve a later test that expects a fresh scan.
describe('resolveMonitorMatches', () => {
  test('returns empty, not limited, when phase 1 finds nothing', async () => {
    mockExecuteQuery.mockResolvedValue([])
    const result = await resolveMonitorMatches('both', ['nomatch.example'])
    expect(result).toEqual({ rows: [], limited: false })
  })

  test('phase 1 domain-column scan uses the index-backed endsWith predicate (idx_ngram_domain, Task 4)', async () => {
    await resolveMonitorMatches('url', ['trezor.io'])
    const domainScanCall = mockExecuteQuery.mock.calls.find(
      ([sql]) => (sql as string).includes('SELECT DISTINCT domain')
    )
    expect(domainScanCall).toBeDefined()
    const [sql] = domainScanCall as [string]
    expect(sql).toContain('endsWith(domain')
  })

  test('mode "url" only scans the domain column, not email_domain', async () => {
    await resolveMonitorMatches('url', ['ledger.com'])
    const emailDomainScan = mockExecuteQuery.mock.calls.find(
      ([sql]) => (sql as string).includes('SELECT DISTINCT email_domain')
    )
    expect(emailDomainScan).toBeUndefined()
  })

  test('fetches and returns rows when phase 1 resolves a candidate value', async () => {
    const row = { url: 'https://metamask.io/login', email: 'user@metamask.io', password: 'hunter2', domain: 'metamask.io' }
    mockExecuteQuery.mockImplementation(async (sql: unknown) => {
      const s = sql as string
      if (s.includes('SELECT DISTINCT domain')) return [{ value: 'metamask.io' }]
      if (s.includes('domain IN {legacyDomains')) return []
      if (s.includes('FROM ulp.credentials')) return [row]
      return []
    })

    const result = await resolveMonitorMatches('url', ['metamask.io'])
    expect(result.rows).toEqual([row])
    expect(result.limited).toBe(false)
  })

  test('limited is true when the result hits the 100-row cap', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      url: `https://coinbase.com/${i}`, email: `u${i}@coinbase.com`, password: 'x', domain: 'coinbase.com',
    }))
    mockExecuteQuery.mockImplementation(async (sql: unknown) => {
      const s = sql as string
      if (s.includes('SELECT DISTINCT domain')) return [{ value: 'coinbase.com' }]
      if (s.includes('domain IN {legacyDomains')) return []
      if (s.includes('FROM ulp.credentials')) return rows
      return []
    })

    const result = await resolveMonitorMatches('url', ['coinbase.com'])
    expect(result.rows.length).toBe(100)
    expect(result.limited).toBe(true)
  })
})
