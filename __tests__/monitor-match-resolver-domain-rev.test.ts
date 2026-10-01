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

type Answer = unknown[] | Error

// Answers each projection's readiness query separately. Each test uses its own domain: the
// resolver caches phase-1 results per (mode, domains) in a module-level Map that clearAllMocks
// does not reset.
function answerReadiness(answers: { domain: Answer; email: Answer }) {
  mockExecuteQuery.mockImplementation(async (sql: string) => {
    if (!sql.includes('system.projection_parts')) return []
    const answer = sql.includes(`name = 'proj_domain_rev'`) ? answers.domain : answers.email
    if (answer instanceof Error) throw answer
    return answer as any[]
  })
}
const READY = [{ parts: '8', with_projection: '8' }]
const NOT_BUILT = [{ parts: '8', with_projection: '0' }]
const sqlCalls = () => mockExecuteQuery.mock.calls.map(([sql]) => sql as string)
const domainScan = () => sqlCalls().find(sql => sql.includes('SELECT DISTINCT domain'))
const emailScan = () => sqlCalls().find(sql => sql.includes('SELECT DISTINCT email_domain'))

describe('resolveMonitorMatches — domain candidate scan plan', () => {
  test('uses the reversed-key predicate, keeps projections on, prefers proj_domain_rev and turns off distinct-in-order when every part carries it', async () => {
    answerReadiness({ domain: READY, email: NOT_BUILT })
    await resolveMonitorMatches('both', ['domain-rev-ready.example'])
    const sql = domainScan()!
    expect(sql).toContain('reverse(domain)')
    expect(sql).toContain(`preferred_optimize_projection_name = 'proj_domain_rev'`)
    // domain leads the primary key, so without this the planner answers SELECT DISTINCT by an
    // in-order read of the base table and never touches the projection (measured: 1224/1224 granules).
    expect(sql).toContain('optimize_distinct_in_order = 0')
    expect(sql).not.toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('endsWith(domain')
  })

  test('the email_domain scan is unaffected while proj_email_domain_rev is not built', async () => {
    answerReadiness({ domain: READY, email: NOT_BUILT })
    await resolveMonitorMatches('both', ['domain-rev-email-unchanged.example'])
    const sql = emailScan()!
    expect(sql).toContain('endsWith(email_domain')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('reverse(')
    expect(sql).not.toContain('optimize_distinct_in_order')
  })

  test('each column decides independently: both ready means both go through their projection', async () => {
    answerReadiness({ domain: READY, email: READY })
    await resolveMonitorMatches('both', ['domain-rev-both.example'])
    expect(domainScan()!).toContain(`preferred_optimize_projection_name = 'proj_domain_rev'`)
    expect(emailScan()!).toContain(`preferred_optimize_projection_name = 'proj_email_domain_rev'`)
    expect(emailScan()!).not.toContain('optimize_distinct_in_order')
  })

  test('falls back to today\'s plan verbatim when only some parts carry the projection', async () => {
    answerReadiness({ domain: [{ parts: '8', with_projection: '5' }], email: READY })
    await resolveMonitorMatches('both', ['domain-rev-partial.example'])
    const sql = domainScan()!
    expect(sql).toContain('endsWith(domain')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('reverse(')
    expect(sql).not.toContain('optimize_distinct_in_order')
  })

  test('falls back when there are no parts', async () => {
    answerReadiness({ domain: [{ parts: '0', with_projection: '0' }], email: READY })
    await resolveMonitorMatches('both', ['domain-rev-noparts.example'])
    expect(domainScan()!).toContain('optimize_use_projections = 0')
  })

  test('falls back (and does not throw) when the readiness query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    answerReadiness({ domain: new Error('connection refused'), email: READY })
    await resolveMonitorMatches('both', ['domain-rev-error.example'])
    expect(domainScan()!).toContain('endsWith(domain')
    warn.mockRestore()
  })

  test('url-mode runs only the domain readiness check; credential-mode runs only the email_domain one', async () => {
    answerReadiness({ domain: READY, email: READY })
    await resolveMonitorMatches('url', ['domain-rev-url-mode.example'])
    expect(sqlCalls().some(sql => sql.includes(`name = 'proj_domain_rev'`))).toBe(true)
    expect(sqlCalls().some(sql => sql.includes(`name = 'proj_email_domain_rev'`))).toBe(false)

    vi.clearAllMocks()
    answerReadiness({ domain: READY, email: READY })
    await resolveMonitorMatches('credential', ['domain-rev-credential-mode.example'])
    expect(sqlCalls().some(sql => sql.includes(`name = 'proj_domain_rev'`))).toBe(false)
    expect(sqlCalls().some(sql => sql.includes(`name = 'proj_email_domain_rev'`))).toBe(true)
    expect(domainScan()).toBeUndefined()
  })
})
