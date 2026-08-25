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

// tryAcquireRescanLock/releaseRescanLock are passed through to their REAL
// implementation (only resolveMonitorMatches is a mock) — final-review Fix 1
// moved the in-flight-rescan lock here so the cron and the manual rescan
// route share it, and the lock-coordination tests below need genuine
// has()/add()/delete() Set behavior to prove anything (a vi.fn() stub would
// just re-assert whatever the test hard-codes it to return). Mirrors the
// same approach in __tests__/monitor-matches-rescan-route.test.ts.
vi.mock('@/lib/monitor-match-resolver', async () => {
  const actual = await vi.importActual<typeof import('@/lib/monitor-match-resolver')>('@/lib/monitor-match-resolver')
  return {
    resolveMonitorMatches: vi.fn().mockResolvedValue({ rows: [], limited: false }),
    tryAcquireRescanLock: actual.tryAcquireRescanLock,
    releaseRescanLock: actual.releaseRescanLock,
  }
})

vi.mock('@/lib/domain-monitor', () => ({
  writeMonitorMatchCache: vi.fn().mockResolvedValue(undefined),
  recordMonitorRescanFailure: vi.fn().mockResolvedValue(undefined),
}))

import { runTick } from '@/lib/monitor-rescan-cron'
import { dbQuery, dbRun } from '@/lib/sqlite'
import { resolveMonitorMatches, tryAcquireRescanLock, releaseRescanLock } from '@/lib/monitor-match-resolver'
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
  // inFlightRescans (lib/monitor-match-resolver.ts) is real module state now,
  // not a mock — vi.clearAllMocks() above doesn't touch it (moved here from a
  // private Set in the rescan route by final-review Fix 1). If any earlier
  // test in this file fails after acquiring the lock but before releasing
  // it, every later test would see a false "already in flight" skip, turning
  // one real failure into a confusing cascade across the whole file.
  // Releasing defensively here (a harmless no-op when nothing is held) makes
  // the suite self-healing regardless of test order or prior failures. Every
  // fixture in this file uses monitor id 1 (dueMonitorRow's default, never
  // overridden) — release covers that.
  releaseRescanLock(1)
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

describe('runTick — rescan lock coordination (final-review Fix 1)', () => {
  // Before this fix, the in-flight-rescan lock was a Set private to
  // app/api/monitoring/monitors/[id]/matches/rescan/route.ts — the cron
  // never checked or set it, so an overlapping cron tick + manual rescan for
  // the same monitor could both run resolveMonitorMatches/writeMonitorMatchCache
  // concurrently. Fix 1 moved the lock to lib/monitor-match-resolver.ts so
  // both callers share it; these tests exercise the cron's side of that.

  test('a monitor whose lock is already held (e.g. by a concurrent manual rescan) is skipped this tick, not marked failed, and the lock is genuinely released afterward so a later tick can acquire it again', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])  // due monitors

    expect(tryAcquireRescanLock(1)).toBe(true)  // simulate a manual rescan already in flight

    await runTick()

    expect(mockResolveMonitorMatches).not.toHaveBeenCalled()
    expect(mockWriteMonitorMatchCache).not.toHaveBeenCalled()
    // Skipped, not failed — a monitor already being rescanned elsewhere
    // must not have its status flipped to 'failed' by the tick that
    // couldn't get the lock.
    expect(mockRecordMonitorRescanFailure).not.toHaveBeenCalled()
    const lastTriggeredCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('UPDATE domain_monitors SET last_triggered_at'))
    expect(lastTriggeredCall).toBeUndefined()

    // runTick's skip path must not have touched the lock it never acquired
    // (e.g. an unconditional release instead of one gated on having
    // acquired it would corrupt this). Releasing the manually-held lock
    // (simulating the manual rescan finishing) must free it normally.
    releaseRescanLock(1)
    expect(tryAcquireRescanLock(1)).toBe(true)
    releaseRescanLock(1)
  })

  test('runTick releases the lock it acquires, so a later tick (or a manual rescan) can acquire it again', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [], limited: false })

    await runTick()

    // If runTick left the lock held after finishing, this would fail.
    expect(tryAcquireRescanLock(1)).toBe(true)
    releaseRescanLock(1)
  })

  test('runTick releases the lock even when resolveMonitorMatches throws', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])
    mockResolveMonitorMatches.mockRejectedValueOnce(new Error('Timeout exceeded'))

    await runTick()

    expect(tryAcquireRescanLock(1)).toBe(true)
    releaseRescanLock(1)
  })
})

describe('runTick — failure narrowing after a successful cache write (final-review Fix 2)', () => {
  // Before this fix, the per-monitor try block spanned resolveMonitorMatches
  // through the webhook/alert-logging step, so ANY throw in that whole
  // sequence — including a downstream SQLite failure unrelated to the scan
  // itself — flipped monitor_rescan_status to 'failed', even when the
  // ClickHouse resolve and the cache write had already succeeded.

  test('a downstream throw (e.g. the seen-fingerprint query) after resolveMonitorMatches + writeMonitorMatchCache both succeeded does NOT record a rescan failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDbQuery
      .mockReturnValueOnce([dueMonitorRow()])  // due monitors
      .mockImplementationOnce(() => { throw new Error('SQLITE_READONLY: attempt to write a readonly database') })  // seen-fingerprint IN-query
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })

    await runTick()

    // The scan itself succeeded — the cache write happened before the throw.
    expect(mockWriteMonitorMatchCache).toHaveBeenCalledWith(1, [MATCHED_ROW])
    // ...so the downstream failure must not mislabel the whole rescan as
    // failed (the bug: the dialog would show a self-contradictory "Last
    // check failed ... showing results from just now").
    expect(mockRecordMonitorRescanFailure).not.toHaveBeenCalled()
    // Still logged — a downstream failure is worth knowing about even though
    // it isn't attributed to the monitor's rescan status.
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  test('a writeMonitorMatchCache throw (cache never actually written) still records a rescan failure — the cacheWritten flag only flips true AFTER the write succeeds', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })
    mockWriteMonitorMatchCache.mockRejectedValueOnce(new Error('SQLITE_READONLY: attempt to write a readonly database'))

    await runTick()

    expect(mockRecordMonitorRescanFailure).toHaveBeenCalledWith(1, 'SQLITE_READONLY: attempt to write a readonly database')
  })
})

describe('runTick — digest-mode DELETE must not leak the rescan lock (re-review Critical fix)', () => {
  // The rescan lock is acquired (tryAcquireRescanLock) before the per-monitor
  // try block starts, but the only release site in this file is the `finally`
  // on the INNER try that wraps resolveMonitorMatches/writeMonitorMatchCache.
  // Before this fix, the digest-mode DELETE ran between the lock acquire and
  // that inner try — outside its protection. dbRun throws synchronously on
  // SQLITE_READONLY/SQLITE_BUSY/SQLITE_FULL (a real, documented failure mode
  // — see lib/sqlite.ts), so a throw from that DELETE used to skip the
  // `finally` entirely and leak the lock forever: every later tick's
  // tryAcquireRescanLock(monitorId) would return false, permanently
  // "skipping" a monitor that was never actually mid-scan, and every manual
  // "Rescan now" click would 409 — until the process restarted.

  test('a throw from the digest-mode DELETE still releases the lock, and still records a rescan failure', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow({ rescan_mode: 'digest' })])  // due monitors
    // Dispatch by SQL text, not call order/count — only the digest-mode
    // DELETE should throw; any other dbRun call in this tick must behave
    // normally.
    mockDbRun.mockImplementation((sql: unknown) => {
      if ((sql as string).includes('DELETE FROM monitor_credential_seen')) {
        throw Object.assign(new Error('SQLITE_READONLY: attempt to write a readonly database'), {})
      }
      return { lastId: 1, changes: 1 }
    })

    await runTick()

    // Proves the fix: the lock was genuinely released, not leaked — a later
    // tick (or a manual "Rescan now") can still acquire it.
    expect(tryAcquireRescanLock(1)).toBe(true)
    releaseRescanLock(1)  // defense in depth — don't leak this test's own acquire into later tests

    // The DELETE threw before resolveMonitorMatches/writeMonitorMatchCache
    // ever ran, so cacheWritten is still false — a genuine rescan failure,
    // the same pre-existing behavior as any other pre-cache-write throw.
    // This was already correct before this fix; only the lock leak was new.
    expect(mockRecordMonitorRescanFailure).toHaveBeenCalledWith(1, 'SQLITE_READONLY: attempt to write a readonly database')
  })
})
