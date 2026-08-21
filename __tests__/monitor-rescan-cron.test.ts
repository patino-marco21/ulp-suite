/**
 * Tests for lib/monitor-rescan-cron.ts — runTick.
 *
 * Coverage: match_mode-aware, subdomain-aware WHERE-clause construction,
 * and match_type persisted on the resulting monitor_alerts row.
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbQuery: vi.fn().mockReturnValue([]),
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
  runWebhookOutboxTick: vi.fn().mockResolvedValue(undefined),
}))

import { runTick } from '@/lib/monitor-rescan-cron'
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery } from '@/lib/clickhouse'

const mockDbQuery = vi.mocked(dbQuery)
const mockDbRun   = vi.mocked(dbRun)
const mockExecuteQuery = vi.mocked(executeQuery)

function dueMonitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Test Monitor',
    domains: JSON.stringify(['aave.com']),
    match_mode: 'both',
    rescan_mode: 'dedup',
    rescan_interval_hours: 24,
    ...overrides,
  }
}

const WEBHOOK_ROW = { id: 5, name: 'hook', url: 'https://hook.example.com', secret: null, headers: null, is_active: 1 }
const MATCHED_ROW = { url: 'https://app.aave.com/login', email: 'user@aave.com', password: 'hunter2', domain: 'app.aave.com' }

beforeEach(() => {
  vi.clearAllMocks()
  mockDbQuery.mockReturnValue([])
  mockDbRun.mockReturnValue({ lastId: 1, changes: 1 })
  mockExecuteQuery.mockResolvedValue([])
})

describe('runTick — query construction', () => {
  test('sends a subdomain-suffix param alongside the exact domain', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])  // due-monitors query
    mockExecuteQuery.mockResolvedValueOnce([])

    await runTick()

    expect(mockExecuteQuery).toHaveBeenCalledOnce()
    const [, params] = mockExecuteQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.domain).toBe('aave.com')
    expect(params.domainSuffix).toBe('.aave.com')
  })

  test('mode "url" omits the email-domain condition', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow({ match_mode: 'url' })])
    mockExecuteQuery.mockResolvedValueOnce([])

    await runTick()

    const [sql] = mockExecuteQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(sql).not.toContain('position(lower(email)')
  })
})

describe('runTick — match_type persistence', () => {
  test('writes match_type matching the monitor mode', async () => {
    mockDbQuery
      .mockReturnValueOnce([dueMonitorRow({ match_mode: 'credential' })])  // due monitors
      .mockReturnValueOnce([])                                            // seen-fingerprint IN-query
      .mockReturnValueOnce([WEBHOOK_ROW])                                 // webhook lookup
    mockExecuteQuery.mockResolvedValueOnce([MATCHED_ROW])

    await runTick()

    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    expect(insertAlertCall).toBeDefined()
    const [, params] = insertAlertCall as [string, unknown[]]
    // Column list: (monitor_id, webhook_id, source_file, matched_domain, match_type,
    // credential_match_count, payload_sent, status, http_status, retry_count). Unlike
    // lib/domain-monitor.ts's INSERT, source_file here is a literal ('[scheduled-rescan]'),
    // not a placeholder — so params only cover [monitor_id, webhook_id, matched_domain,
    // match_type, ...]: match_type is params[3].
    expect(params[3]).toBe('credential_email')
  })
})
