/**
 * Tests for lib/domain-monitor.ts — fireMonitorAlertsFromMatches.
 *
 * Coverage: dedup-fingerprint filtering, webhook delivery/alert-logging,
 * and match_type persistence, given pre-computed in-process matches.
 *
 * checkMonitorsForULPUpload (the ClickHouse-query-per-domain approach this
 * replaced) had its own test coverage added when its subdomain/match_mode
 * bugs were fixed; that coverage moved here once its only call site
 * (lib/upload-processor.ts) switched to in-process matching.
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet:   vi.fn().mockReturnValue(undefined),
  dbRun:   vi.fn().mockReturnValue({ lastId: 1, changes: 1 }),
}))

vi.mock('@/lib/webhook-outbox-worker', () => ({
  attemptDelivery: vi.fn().mockResolvedValue({ ok: true, status: 200, error: null }),
  enqueueFailedDelivery: vi.fn(),
}))

import { fireMonitorAlertsFromMatches, type DomainMonitor } from '@/lib/domain-monitor'
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { attemptDelivery } from '@/lib/webhook-outbox-worker'
import type { MatchedCredential } from '@/lib/domain-match'

const mockDbQuery = vi.mocked(dbQuery)
const mockDbGet   = vi.mocked(dbGet)
const mockDbRun   = vi.mocked(dbRun)
const mockAttemptDelivery = vi.mocked(attemptDelivery)

function parsedMonitor(overrides: Partial<DomainMonitor> = {}): DomainMonitor {
  return {
    id: 1,
    name: 'Test Monitor',
    domains: ['aave.com'],
    match_mode: 'both',
    is_active: true,
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

const WEBHOOK_ROW = { id: 5, name: 'hook', url: 'https://hook.example.com', secret: null, headers: null, is_active: 1, created_by: null, last_triggered_at: null, created_at: '', updated_at: '' }

const MATCH: MatchedCredential = { monitorId: 1, url: 'https://app.aave.com/login', email: 'user@aave.com', password: 'hunter2', domain: 'app.aave.com' }

beforeEach(() => {
  vi.clearAllMocks()
  mockDbQuery.mockReturnValue([])
  mockDbGet.mockReturnValue(undefined)
  mockDbRun.mockReturnValue({ lastId: 1, changes: 1 })
  mockAttemptDelivery.mockResolvedValue({ ok: true, status: 200, error: null })
})

describe('fireMonitorAlertsFromMatches', () => {
  test('does nothing when there are no matches', async () => {
    await fireMonitorAlertsFromMatches('file.txt', [], new Map())
    expect(mockDbQuery).not.toHaveBeenCalled()
  })

  test('skips a match whose monitor is not in monitorsById', async () => {
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], new Map())
    expect(mockDbRun).not.toHaveBeenCalled()
  })

  test('delivers a webhook and logs an alert with the correct match_type for a new match', async () => {
    mockDbGet.mockReturnValueOnce(undefined)       // fingerprint not seen
    mockDbQuery.mockReturnValueOnce([WEBHOOK_ROW])  // active webhooks for monitor

    const monitors = new Map([[1, parsedMonitor({ match_mode: 'url' })]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    expect(mockAttemptDelivery).toHaveBeenCalledOnce()
    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    expect(insertAlertCall).toBeDefined()
    const [, params] = insertAlertCall as [string, unknown[]]
    // Column list: (monitor_id, webhook_id, source_file, matched_domain, match_type,
    // credential_match_count, payload_sent, status, http_status, retry_count) — all
    // placeholders except the trailing literal retry_count, so match_type is params[4].
    expect(params[4]).toBe('url')
  })

  test('skips a credential whose fingerprint was already alerted', async () => {
    mockDbGet.mockReturnValueOnce({ 1: 1 })  // fingerprint already seen (truthy row)

    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    expect(mockAttemptDelivery).not.toHaveBeenCalled()
  })

  test('groups multiple matches for the same monitor into one alert', async () => {
    mockDbGet.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined)
    mockDbQuery.mockReturnValueOnce([WEBHOOK_ROW])

    const second: MatchedCredential = { ...MATCH, email: 'user2@aave.com' }
    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH, second], monitors)

    expect(mockAttemptDelivery).toHaveBeenCalledOnce()
    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    const [, params] = insertAlertCall as [string, unknown[]]
    expect(params[5]).toBe(2)  // credential_match_count
  })

  test('does not deliver when the monitor has no active webhooks', async () => {
    mockDbGet.mockReturnValueOnce(undefined)
    mockDbQuery.mockReturnValueOnce([])  // no active webhooks

    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    expect(mockAttemptDelivery).not.toHaveBeenCalled()
  })
})
