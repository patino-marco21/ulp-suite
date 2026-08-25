/**
 * Tests for lib/monitor-rescan-cron.ts — runTick.
 *
 * Coverage: match_type persisted on the resulting monitor_alerts row, webhook
 * dedup/no-webhook bookkeeping, and the match-cache rewire (Task 7) — runTick
 * delegates "what currently matches" to resolveMonitorMatches (one call per
 * monitor, not per domain) and records success/failure via
 * writeMonitorMatchCache/recordMonitorRescanFailure instead of querying
 * ClickHouse itself. See __tests__/domain-match.test.ts and
 * __tests__/monitor-match-resolver.test.ts for match_mode-aware,
 * subdomain-aware WHERE-clause construction and the email-domain false-match
 * guard — that query strategy lives in lib/domain-match.ts/
 * lib/monitor-match-resolver.ts now, not here.
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbQuery: vi.fn().mockReturnValue([]),
  dbRun:   vi.fn().mockReturnValue({ lastId: 1, changes: 1 }),
}))

vi.mock('@/lib/webhook-outbox-worker', () => ({
  attemptDelivery: vi.fn().mockResolvedValue({ ok: true, status: 200, error: null }),
  enqueueFailedDelivery: vi.fn(),
  runWebhookOutboxTick: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/monitor-match-resolver', () => ({
  resolveMonitorMatches: vi.fn().mockResolvedValue({ rows: [], limited: false }),
}))

vi.mock('@/lib/domain-monitor', () => ({
  writeMonitorMatchCache: vi.fn().mockResolvedValue(undefined),
  recordMonitorRescanFailure: vi.fn().mockResolvedValue(undefined),
}))

import { runTick } from '@/lib/monitor-rescan-cron'
import { dbQuery, dbRun } from '@/lib/sqlite'
import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { writeMonitorMatchCache, recordMonitorRescanFailure } from '@/lib/domain-monitor'

const mockDbQuery = vi.mocked(dbQuery)
const mockDbRun   = vi.mocked(dbRun)
const mockResolveMonitorMatches = vi.mocked(resolveMonitorMatches)
const mockWriteMonitorMatchCache = vi.mocked(writeMonitorMatchCache)
const mockRecordMonitorRescanFailure = vi.mocked(recordMonitorRescanFailure)

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
  mockResolveMonitorMatches.mockResolvedValue({ rows: [], limited: false })
})

describe('runTick — match_type persistence', () => {
  test('writes match_type matching the monitor mode', async () => {
    mockDbQuery
      .mockReturnValueOnce([dueMonitorRow({ match_mode: 'credential' })])  // due monitors
      .mockReturnValueOnce([])                                            // seen-fingerprint IN-query
      .mockReturnValueOnce([WEBHOOK_ROW])                                 // webhook lookup
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })

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

describe('runTick — match recording without webhooks', () => {
  test('records a seen-fingerprint and bumps last_triggered_at even when the monitor has no active webhooks', async () => {
    mockDbQuery
      .mockReturnValueOnce([dueMonitorRow()])  // due monitors
      .mockReturnValueOnce([])                 // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([])                 // no active webhooks
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })

    await runTick()

    const seenInsertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT OR IGNORE INTO monitor_credential_seen'))
    expect(seenInsertCall).toBeDefined()
    const lastTriggeredCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('UPDATE domain_monitors SET last_triggered_at'))
    expect(lastTriggeredCall).toBeDefined()
    // No webhook to deliver to, so no alert row (webhook_id is NOT NULL + FK).
    const insertAlertCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO monitor_alerts'))
    expect(insertAlertCall).toBeUndefined()
  })
})

describe('runTick — match cache (saved, not live)', () => {
  test('writes the cache with resolveMonitorMatches\' rows on success', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])  // due monitors
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })

    await runTick()

    expect(mockWriteMonitorMatchCache).toHaveBeenCalledWith(1, [MATCHED_ROW])
  })

  test('calls resolveMonitorMatches once per monitor, not once per domain', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow({ domains: JSON.stringify(['aave.com', 'lido.fi', 'trezor.io']) })])
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [], limited: false })

    await runTick()

    expect(mockResolveMonitorMatches).toHaveBeenCalledTimes(1)
    expect(mockResolveMonitorMatches).toHaveBeenCalledWith('both', ['aave.com', 'lido.fi', 'trezor.io'])
  })

  test('records a rescan failure (not just console.error) when resolveMonitorMatches throws', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])
    mockResolveMonitorMatches.mockRejectedValueOnce(new Error('Timeout exceeded: elapsed 60049ms, maximum: 60000ms.'))

    await runTick()

    expect(mockRecordMonitorRescanFailure).toHaveBeenCalledWith(1, 'Timeout exceeded: elapsed 60049ms, maximum: 60000ms.')
    // The bug being fixed: previously this was ONLY console.error'd, with no
    // trace anywhere queryable — last_triggered_at must not silently advance
    // on a failed attempt either.
    const lastTriggeredCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('UPDATE domain_monitors SET last_triggered_at'))
    expect(lastTriggeredCall).toBeUndefined()
  })
})
