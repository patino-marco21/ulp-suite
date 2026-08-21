/**
 * Tests for lib/domain-monitor.ts — checkMonitorsForULPUpload.
 *
 * Coverage: match_mode-aware, subdomain-aware WHERE-clause construction,
 * and match_type persisted on the resulting monitor_alerts row.
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet:   vi.fn().mockReturnValue(undefined),
  dbRun:   vi.fn().mockReturnValue({ lastId: 1, changes: 1 }),
}))

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
  NORM_EMAIL_EXPR: 'email',
}))

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/webhook-outbox-worker', () => ({
  attemptDelivery: vi.fn().mockResolvedValue({ ok: true, status: 200, error: null }),
  enqueueFailedDelivery: vi.fn(),
}))

import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery } from '@/lib/clickhouse'
import { attemptDelivery } from '@/lib/webhook-outbox-worker'

const mockDbQuery = vi.mocked(dbQuery)
const mockDbGet   = vi.mocked(dbGet)
const mockDbRun   = vi.mocked(dbRun)
const mockExecuteQuery = vi.mocked(executeQuery)
const mockAttemptDelivery = vi.mocked(attemptDelivery)

function activeMonitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Test Monitor',
    domains: JSON.stringify(['aave.com']),
    match_mode: 'both',
    is_active: 1,
    created_by: null,
    last_triggered_at: null,
    total_alerts: 0,
    rescan_mode: 'dedup',
    rescan_interval_hours: 24,
    created_at: '2026-08-21',
    updated_at: '2026-08-21',
    ...overrides,
  }
}

const MATCHED_ROW = { url: 'https://app.aave.com/login', email: 'user@aave.com', password: 'hunter2', domain: 'app.aave.com' }
const WEBHOOK_ROW = { id: 5, name: 'hook', url: 'https://hook.example.com', secret: null, headers: null, is_active: 1, created_by: null, last_triggered_at: null, created_at: '', updated_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
  mockDbQuery.mockReturnValue([])
  mockDbGet.mockReturnValue(undefined)
  mockDbRun.mockReturnValue({ lastId: 1, changes: 1 })
  mockExecuteQuery.mockResolvedValue([])
  mockAttemptDelivery.mockResolvedValue({ ok: true, status: 200, error: null })
})

describe('checkMonitorsForULPUpload — query construction', () => {
  test('sends a subdomain-suffix param alongside the exact domain', async () => {
    mockDbQuery.mockReturnValueOnce([activeMonitorRow()])  // getActiveMonitors
    mockExecuteQuery.mockResolvedValueOnce([])

    await checkMonitorsForULPUpload('file.txt')

    expect(mockExecuteQuery).toHaveBeenCalledOnce()
    const [, params] = mockExecuteQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.domain).toBe('aave.com')
    expect(params.domainSuffix).toBe('.aave.com')
  })

  test('mode "url" omits the email-domain condition from the query', async () => {
    mockDbQuery.mockReturnValueOnce([activeMonitorRow({ match_mode: 'url' })])
    mockExecuteQuery.mockResolvedValueOnce([])

    await checkMonitorsForULPUpload('file.txt')

    const [sql] = mockExecuteQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(sql).not.toContain('position(lower(email)')
  })

  test('mode "credential" omits the URL-domain condition from the query', async () => {
    mockDbQuery.mockReturnValueOnce([activeMonitorRow({ match_mode: 'credential' })])
    mockExecuteQuery.mockResolvedValueOnce([])

    await checkMonitorsForULPUpload('file.txt')

    const [sql] = mockExecuteQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(sql).not.toContain('(domain) = {domain:String} OR endsWith((domain)')
  })

  test('mode "both" includes both conditions', async () => {
    mockDbQuery.mockReturnValueOnce([activeMonitorRow({ match_mode: 'both' })])
    mockExecuteQuery.mockResolvedValueOnce([])

    await checkMonitorsForULPUpload('file.txt')

    const [sql] = mockExecuteQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(sql).toContain('(domain) = {domain:String} OR endsWith((domain)')
    expect(sql).toContain('position(lower(email)')
  })
})

describe('checkMonitorsForULPUpload — match_type persistence', () => {
  test('writes match_type matching the monitor mode on a new match', async () => {
    mockDbQuery
      .mockReturnValueOnce([activeMonitorRow({ match_mode: 'url' })])  // getActiveMonitors
      .mockReturnValueOnce([WEBHOOK_ROW])                              // webhook lookup
    mockExecuteQuery.mockResolvedValueOnce([MATCHED_ROW])
    mockDbGet.mockReturnValue(undefined)  // fingerprint not seen

    await checkMonitorsForULPUpload('file.txt')

    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    expect(insertAlertCall).toBeDefined()
    const [, params] = insertAlertCall as [string, unknown[]]
    // Column list: (monitor_id, webhook_id, source_file, matched_domain, match_type,
    // credential_match_count, payload_sent, status, http_status, retry_count) — all
    // placeholders except the trailing literal retry_count, so match_type is params[4].
    expect(params[4]).toBe('url')
  })
})
