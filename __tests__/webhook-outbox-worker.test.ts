/**
 * Tests for lib/webhook-outbox-worker.ts
 *
 * Coverage:
 *  - enqueueFailedDelivery()   inserts pending row with correct fields
 *  - runWebhookOutboxTick()    success path, retry path, dead-letter paths
 */

import { vi, describe, test, expect, beforeEach } from 'vitest'

// Mock sqlite so tests run without a real database.
// Must be declared before imports that pull in the worker.
vi.mock('@/lib/sqlite', () => ({
  dbRun:   vi.fn(),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet:   vi.fn().mockReturnValue(undefined),
}))

import { enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { dbRun, dbQuery, dbGet } from '@/lib/sqlite'

const mockDbRun   = vi.mocked(dbRun)
const mockDbQuery = vi.mocked(dbQuery)
const mockDbGet   = vi.mocked(dbGet)

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

// ─────────────────────────────────────────────────────────────────────────────
// § 1  enqueueFailedDelivery
// ─────────────────────────────────────────────────────────────────────────────

describe('enqueueFailedDelivery', () => {
  test('inserts a row into webhook_outbox with status pending and attempt_count 1', () => {
    enqueueFailedDelivery(10, 20, '{"test":true}', 'breach.txt', 'example.com', 5)

    expect(mockDbRun).toHaveBeenCalledOnce()
    const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('webhook_outbox')
    expect(sql.toLowerCase()).toContain("'pending'")
    expect(params).toContain(1)   // attempt_count
    expect(params).toContain(10)  // monitor_id
    expect(params).toContain(20)  // webhook_id
    expect(params).toContain(5)   // cred_count
  })

  test('sets next_attempt_at to +1 minute', () => {
    enqueueFailedDelivery(10, 20, '{}', 'file.txt', 'example.com', 0)

    const [sql] = mockDbRun.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('+1 minute')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 2  runWebhookOutboxTick
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_ROW = {
  id: 1,
  monitor_id: 10,
  webhook_id: 20,
  payload: '{"test":true}',
  source_file: 'breach.txt',
  matched_domain: 'example.com',
  cred_count: 5,
  attempt_count: 1,
}

const WEBHOOK_ROW = { url: 'https://hook.example.com', secret: null, headers: null }

describe('runWebhookOutboxTick', () => {
  test('does nothing when no due rows', async () => {
    mockDbQuery.mockReturnValueOnce([])

    await runWebhookOutboxTick()

    expect(mockDbRun).not.toHaveBeenCalled()
  })

  test('marks row delivered and inserts success alert on 2xx response', async () => {
    mockDbQuery.mockReturnValueOnce([PENDING_ROW])
    mockDbGet.mockReturnValueOnce(WEBHOOK_ROW)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

    await runWebhookOutboxTick()

    const sqls = mockDbRun.mock.calls.map(([s]) => s as string)
    expect(sqls.some(s => s.includes("status='delivered'"))).toBe(true)
    expect(sqls.some(s => s.includes('monitor_alerts') && s.includes("'success'"))).toBe(true)
  })

  test('increments attempt_count and sets retrying with backoff on 5xx failure', async () => {
    mockDbQuery.mockReturnValueOnce([PENDING_ROW])
    mockDbGet.mockReturnValueOnce(WEBHOOK_ROW)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    await runWebhookOutboxTick()

    const calls = mockDbRun.mock.calls as [string, unknown[]][]
    const retryCall = calls.find(([s]) => s.includes("status='retrying'"))
    expect(retryCall).toBeDefined()
    expect(retryCall![1]).toContain(2)  // new attempt_count
  })

  test('dead_letters immediately on 4xx response', async () => {
    mockDbQuery.mockReturnValueOnce([PENDING_ROW])
    mockDbGet.mockReturnValueOnce(WEBHOOK_ROW)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }))

    await runWebhookOutboxTick()

    const sqls = mockDbRun.mock.calls.map(([s]) => s as string)
    expect(sqls.some(s => s.includes("status='dead_letter'"))).toBe(true)
    expect(sqls.some(s => s.includes("status='retrying'"))).toBe(false)
  })

  test('dead_letters when attempt_count is 4 and retry fails (5th total attempt)', async () => {
    mockDbQuery.mockReturnValueOnce([{ ...PENDING_ROW, attempt_count: 4 }])
    mockDbGet.mockReturnValueOnce(WEBHOOK_ROW)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    await runWebhookOutboxTick()

    const sqls = mockDbRun.mock.calls.map(([s]) => s as string)
    expect(sqls.some(s => s.includes("status='dead_letter'"))).toBe(true)
    expect(sqls.some(s => s.includes("status='retrying'"))).toBe(false)
  })

  test('dead_letters without fetch when webhook not found in monitor_webhooks', async () => {
    mockDbQuery.mockReturnValueOnce([PENDING_ROW])
    mockDbGet.mockReturnValueOnce(undefined)  // webhook missing

    await runWebhookOutboxTick()

    const sqls = mockDbRun.mock.calls.map(([s]) => s as string)
    expect(sqls.some(s => s.includes("status='dead_letter'"))).toBe(true)
    expect(sqls.some(s => s.includes('monitor_alerts') && s.includes("'failed'"))).toBe(true)
    // fetch was never called — no stub needed, it would throw if called
  })
})
