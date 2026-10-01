import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
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

// Each test uses its own domain: the resolver caches phase-1 results per (mode, domains)
// in a module-level Map that clearAllMocks does not reset.
// Answers the readiness query for proj_email_domain_rev only; proj_domain_rev reports "not built"
// so these tests keep exercising today's domain plan (see monitor-match-resolver-domain-rev.test.ts).
function answerReadiness(result: unknown[] | Error) {
  mockExecuteQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('system.projection_parts')) {
      if (!sql.includes(`name = 'proj_email_domain_rev'`)) return [{ parts: '8', with_projection: '0' }]
      if (result instanceof Error) throw result
      return result as any[]
    }
    return []
  })
}
const sqlCalls = () => mockExecuteQuery.mock.calls.map(([sql]) => sql as string)
const emailScan = () => sqlCalls().find(sql => sql.includes('SELECT DISTINCT email_domain'))
const domainScan = () => sqlCalls().find(sql => sql.includes('SELECT DISTINCT domain'))

describe('resolveMonitorMatches — email_domain candidate scan plan', () => {
  test('uses the reversed-key prefix predicate, keeps projections on and prefers proj_email_domain_rev when every part carries it', async () => {
    answerReadiness([{ parts: '8', with_projection: '8' }])
    await resolveMonitorMatches('both', ['rev-ready.example'])
    const sql = emailScan()!
    expect(sql).toContain('reverse(email_domain)')
    expect(sql).toContain(`preferred_optimize_projection_name = 'proj_email_domain_rev'`)
    expect(sql).not.toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('endsWith(email_domain')
  })

  test('the domain scan is unaffected while proj_domain_rev is not built -- same endsWith predicate, projections still off', async () => {
    answerReadiness([{ parts: '8', with_projection: '8' }])
    await resolveMonitorMatches('both', ['rev-domain-unchanged.example'])
    const sql = domainScan()!
    expect(sql).toContain('endsWith(domain')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('reverse(')
  })

  test('falls back to today\'s skip-index scan when only some parts carry the projection', async () => {
    answerReadiness([{ parts: '8', with_projection: '5' }])
    await resolveMonitorMatches('both', ['rev-partial.example'])
    const sql = emailScan()!
    expect(sql).toContain('endsWith(email_domain')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('reverse(')
  })

  test('falls back when there are no parts', async () => {
    answerReadiness([{ parts: '0', with_projection: '0' }])
    await resolveMonitorMatches('both', ['rev-noparts.example'])
    expect(emailScan()!).toContain('optimize_use_projections = 0')
  })

  test('falls back (and does not throw) when the readiness query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    answerReadiness(new Error('connection refused'))
    await resolveMonitorMatches('both', ['rev-error.example'])
    expect(emailScan()!).toContain('endsWith(email_domain')
    warn.mockRestore()
  })

  test('does not run the email_domain readiness check for url-mode monitors (no email_domain scan at all)', async () => {
    answerReadiness([{ parts: '8', with_projection: '8' }])
    await resolveMonitorMatches('url', ['rev-url-mode.example'])
    expect(sqlCalls().some(sql => sql.includes(`name = 'proj_email_domain_rev'`))).toBe(false)
    expect(emailScan()).toBeUndefined()
  })
})
