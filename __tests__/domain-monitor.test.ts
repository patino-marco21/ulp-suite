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

import { fireMonitorAlertsFromMatches, getLastViewedAt, recordMonitorViewed, type DomainMonitor } from '@/lib/domain-monitor'
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
    mockDbQuery
      .mockReturnValueOnce([])            // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([WEBHOOK_ROW])  // active webhooks for monitor

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
    // Seen-fingerprint IN-query: report the (only) requested fingerprint as
    // already seen. Reads it back out of the query params rather than
    // hardcoding credentialFingerprint's hash output, since that hash isn't
    // exported from lib/domain-monitor.ts.
    mockDbQuery.mockImplementationOnce((_sql: unknown, params: unknown) => {
      const fp = (params as string[])[1]
      return [{ fingerprint: fp }]
    })

    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    expect(mockAttemptDelivery).not.toHaveBeenCalled()
  })

  test('groups multiple matches for the same monitor into one alert', async () => {
    mockDbQuery
      .mockReturnValueOnce([])            // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([WEBHOOK_ROW])  // active webhooks for monitor

    const second: MatchedCredential = { ...MATCH, email: 'user2@aave.com' }
    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH, second], monitors)

    expect(mockAttemptDelivery).toHaveBeenCalledOnce()
    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    const [, params] = insertAlertCall as [string, unknown[]]
    expect(params[5]).toBe(2)  // credential_match_count
  })

  test('does not deliver when the monitor has no active webhooks, but still records the match', async () => {
    mockDbQuery
      .mockReturnValueOnce([])  // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([])  // no active webhooks

    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    expect(mockAttemptDelivery).not.toHaveBeenCalled()

    // Still recorded so it's visible to the live-matches view and counted as
    // "seen" for unread tracking, even with no webhook to deliver to.
    const seenInsertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT OR IGNORE INTO monitor_credential_seen'))
    expect(seenInsertCall).toBeDefined()
    const lastTriggeredCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('UPDATE domain_monitors SET last_triggered_at'))
    expect(lastTriggeredCall).toBeDefined()

    // No monitor_alerts row without a webhook_id to attach it to (NOT NULL + FK).
    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    expect(insertAlertCall).toBeUndefined()
  })

  test('payload_sent matches array contains only {url, email, password, domain} — no monitorId or other fields', async () => {
    // Regression guard: a prior fix (see git log -p lib/domain-monitor.ts)
    // stripped a monitorId field that had leaked into the webhook payload /
    // payload_sent audit column. Locks in the correct shape going forward.
    mockDbQuery
      .mockReturnValueOnce([])            // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([WEBHOOK_ROW])  // active webhooks for monitor

    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    expect(insertAlertCall).toBeDefined()
    const [, params] = insertAlertCall as [string, unknown[]]
    // payload_sent is params[6] — see the column-list comment above.
    const payload = JSON.parse(params[6] as string)
    expect(payload.matches).toHaveLength(1)
    expect(Object.keys(payload.matches[0]).sort()).toEqual(['domain', 'email', 'password', 'url'])
    expect(payload.matches[0]).toEqual({
      url: MATCH.url,
      email: MATCH.email,
      password: MATCH.password,
      domain: MATCH.domain,
    })
  })
})

describe('getLastViewedAt / recordMonitorViewed', () => {
  test('returns null when the user has never viewed the monitor', async () => {
    mockDbGet.mockReturnValueOnce(undefined)
    const result = await getLastViewedAt(1, 7)
    expect(result).toBeNull()
  })

  test('returns the stored timestamp when present', async () => {
    mockDbGet.mockReturnValueOnce({ last_viewed_at: '2026-08-20 10:00:00' })
    const result = await getLastViewedAt(1, 7)
    expect(result).toBe('2026-08-20 10:00:00')
  })

  test('recordMonitorViewed upserts keyed on (monitor_id, user_id)', async () => {
    await recordMonitorViewed(1, 7)
    expect(mockDbRun).toHaveBeenCalledOnce()
    const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO monitor_views')
    expect(sql).toContain('ON CONFLICT(monitor_id, user_id) DO UPDATE')
    expect(params).toEqual([1, 7])
  })
})
