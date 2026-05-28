# Webhook Delivery Reliability — Persistent Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fire-and-forget webhook delivery with a durable outbox: inline first attempt for low latency, automatic exponential-backoff retry for failures, dead-letter after 5 total attempts.

**Architecture:** A `webhook_outbox` SQLite table stores failed deliveries. `lib/webhook-outbox-worker.ts` exposes `attemptDelivery()` (shared fetch helper), `enqueueFailedDelivery()` (write outbox row), and `runWebhookOutboxTick()` (poll + retry). Both `domain-monitor.ts` and `monitor-rescan-cron.ts` replace their old fire-and-forget functions with inline `attemptDelivery()` + `enqueueFailedDelivery()` on failure. The worker tick is called at the end of each `runMonitorRescanTick`.

**Tech Stack:** Next.js 14, better-sqlite3, TypeScript, Vitest (`npm test`), `npx tsc --noEmit`

---

## File Map

| File | Action |
|---|---|
| `lib/sqlite.ts` | Modify — add `webhook_outbox` table to `initSchema()` |
| `lib/webhook-outbox-worker.ts` | Create — `attemptDelivery`, `enqueueFailedDelivery`, `runWebhookOutboxTick` |
| `lib/domain-monitor.ts` | Modify — replace `deliverWebhook` call + remove function, add imports |
| `lib/monitor-rescan-cron.ts` | Modify — replace `deliverWebhookSimple` call + remove function, add `runWebhookOutboxTick` at end of tick |
| `__tests__/webhook-outbox-worker.test.ts` | Create — unit tests using mocked sqlite + stubbed fetch |

---

### Task 1: webhook_outbox schema

**Files:**
- Modify: `lib/sqlite.ts` (inside `initSchema`, end of the `db.exec(...)` block)

Context: `lib/sqlite.ts` defines `initSchema(db)` which runs a single large `db.exec(...)` with every table definition. Add `webhook_outbox` at the end of that `db.exec` string, before the closing `\`` and `)`  of the template literal.

- [ ] **Step 1: Add the table definition**

In `lib/sqlite.ts`, find the closing of the `db.exec` call in `initSchema`. It looks like:

```ts
    CREATE TABLE IF NOT EXISTS feed_sources (
      ...
    );
  `)
```

Change it to:

```ts
    CREATE TABLE IF NOT EXISTS feed_sources (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id     INTEGER NOT NULL,
      name            TEXT NOT NULL,
      rss_url         TEXT NOT NULL,
      last_fetched_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES feed_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhook_outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id       INTEGER NOT NULL,
      webhook_id       INTEGER NOT NULL,
      payload          TEXT    NOT NULL,
      source_file      TEXT    NOT NULL,
      matched_domain   TEXT    NOT NULL,
      cred_count       INTEGER NOT NULL DEFAULT 0,
      status           TEXT    NOT NULL DEFAULT 'pending',
      attempt_count    INTEGER NOT NULL DEFAULT 1,
      next_attempt_at  TEXT    NOT NULL,
      last_error       TEXT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 3: Run tests to verify nothing broken**

```bash
npm test
```

Expected: `Tests 381 passed (381)`

- [ ] **Step 4: Commit**

```bash
git add lib/sqlite.ts
git commit -m "feat(db): add webhook_outbox table to SQLite schema"
```

---

### Task 2: lib/webhook-outbox-worker.ts + tests

**Files:**
- Create: `lib/webhook-outbox-worker.ts`
- Create: `__tests__/webhook-outbox-worker.test.ts`

Context: This is the core of the feature. The worker uses `dbRun`/`dbQuery`/`dbGet` from `lib/sqlite`. Tests mock `@/lib/sqlite` entirely to avoid real DB I/O and test logic in isolation.

- [ ] **Step 1: Write the failing tests first**

Create `__tests__/webhook-outbox-worker.test.ts`:

```ts
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
    // fetch was never called — no stub needed, it would throw if called
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- __tests__/webhook-outbox-worker.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/webhook-outbox-worker'"

- [ ] **Step 3: Create lib/webhook-outbox-worker.ts**

```ts
/**
 * Webhook outbox worker.
 *
 * Provides three exports:
 *  - attemptDelivery()        Shared fetch helper with HMAC signing and 30s timeout.
 *  - enqueueFailedDelivery()  Write a pending row to webhook_outbox after a failed inline attempt.
 *  - runWebhookOutboxTick()   Poll due rows and retry; call at the end of each cron tick.
 */

import { dbRun, dbQuery, dbGet } from '@/lib/sqlite'
import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebhookTarget {
  url: string
  secret: string | null
  headers: Record<string, string> | null
}

export interface DeliveryResult {
  ok: boolean
  status: number | null   // null on network error / timeout
  error: string | null    // null on success
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5   // total attempts: 1 inline + 4 retries

// ─── Core fetch helper ────────────────────────────────────────────────────────

export async function attemptDelivery(
  target: WebhookTarget,
  payloadJson: string,
): Promise<DeliveryResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ULPSuite-DomainMonitor/1.0',
    ...(target.headers || {}),
  }
  if (target.secret) {
    headers['X-Webhook-Signature'] = `sha256=${crypto
      .createHmac('sha256', target.secret)
      .update(payloadJson)
      .digest('hex')}`
  }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)
    const res = await fetch(target.url, { method: 'POST', headers, body: payloadJson, signal: ctrl.signal })
    clearTimeout(t)
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Enqueue failed first attempt ─────────────────────────────────────────────

export function enqueueFailedDelivery(
  monitorId: number,
  webhookId: number,
  payloadJson: string,
  sourceFile: string,
  matchedDomain: string,
  credCount: number,
): void {
  dbRun(
    `INSERT INTO webhook_outbox
       (monitor_id, webhook_id, payload, source_file, matched_domain, cred_count,
        status, attempt_count, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, datetime('now', '+1 minute'))`,
    [monitorId, webhookId, payloadJson, sourceFile, matchedDomain, credCount],
  )
}

// ─── Outbox worker ────────────────────────────────────────────────────────────

interface OutboxRow {
  id: number
  monitor_id: number
  webhook_id: number
  payload: string
  source_file: string
  matched_domain: string
  cred_count: number
  attempt_count: number
}

export async function runWebhookOutboxTick(): Promise<void> {
  const dueRows = dbQuery(
    `SELECT id, monitor_id, webhook_id, payload, source_file, matched_domain, cred_count, attempt_count
     FROM webhook_outbox
     WHERE status IN ('pending', 'retrying')
       AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at ASC
     LIMIT 50`,
    [],
  ) as OutboxRow[]

  for (const row of dueRows) {
    // Look up active webhook
    const whRow = dbGet(
      `SELECT url, secret, headers FROM monitor_webhooks WHERE id = ? AND is_active = 1`,
      [row.webhook_id],
    ) as { url: string; secret: string | null; headers: string | null } | undefined

    if (!whRow) {
      dbRun(
        `UPDATE webhook_outbox
         SET status='dead_letter', last_error='webhook not found or inactive', updated_at=datetime('now')
         WHERE id=?`,
        [row.id],
      )
      continue
    }

    let parsedHeaders: Record<string, string> | null = null
    try { parsedHeaders = whRow.headers ? JSON.parse(whRow.headers) : null } catch {}

    const result = await attemptDelivery(
      { url: whRow.url, secret: whRow.secret, headers: parsedHeaders },
      row.payload,
    )

    const newAttemptCount = row.attempt_count + 1

    if (result.ok) {
      dbRun(
        `UPDATE webhook_outbox SET status='delivered', updated_at=datetime('now') WHERE id=?`,
        [row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, http_status, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'success', ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, result.status, row.attempt_count],
      )
      dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [row.webhook_id])

    } else if (result.status !== null && result.status >= 400 && result.status < 500) {
      // 4xx — dead-letter immediately, no retry
      dbRun(
        `UPDATE webhook_outbox
         SET status='dead_letter', last_error=?, updated_at=datetime('now')
         WHERE id=?`,
        [result.error, row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, http_status, error_message, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, result.status, result.error, row.attempt_count],
      )

    } else if (newAttemptCount >= MAX_ATTEMPTS) {
      // Reached max attempts — dead-letter
      dbRun(
        `UPDATE webhook_outbox
         SET status='dead_letter', last_error=?, updated_at=datetime('now')
         WHERE id=?`,
        [result.error, row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, http_status, error_message, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, result.status, result.error, row.attempt_count],
      )

    } else {
      // Retry with exponential backoff: 2^(newAttemptCount-1) minutes
      const backoffMinutes = Math.pow(2, newAttemptCount - 1)
      dbRun(
        `UPDATE webhook_outbox
         SET status='retrying', attempt_count=?, next_attempt_at=datetime('now', ?), last_error=?, updated_at=datetime('now')
         WHERE id=?`,
        [newAttemptCount, `+${backoffMinutes} minute`, result.error, row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, http_status, error_message, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, result.status, result.error, row.attempt_count],
      )
    }
  }
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
npm test -- __tests__/webhook-outbox-worker.test.ts
```

Expected:
```
✓ enqueueFailedDelivery > inserts a row into webhook_outbox with status pending and attempt_count 1
✓ enqueueFailedDelivery > sets next_attempt_at to +1 minute
✓ runWebhookOutboxTick > does nothing when no due rows
✓ runWebhookOutboxTick > marks row delivered and inserts success alert on 2xx response
✓ runWebhookOutboxTick > increments attempt_count and sets retrying with backoff on 5xx failure
✓ runWebhookOutboxTick > dead_letters immediately on 4xx response
✓ runWebhookOutboxTick > dead_letters when attempt_count is 4 and retry fails (5th total attempt)
✓ runWebhookOutboxTick > dead_letters without fetch when webhook not found in monitor_webhooks

Test Files  1 passed (1)
     Tests  8 passed (8)
```

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass (should be 389 — 381 + 8 new).

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add lib/webhook-outbox-worker.ts __tests__/webhook-outbox-worker.test.ts
git commit -m "feat(outbox): add webhook delivery worker with retry + dead-letter"
```

---

### Task 3: Wire up domain-monitor.ts

**Files:**
- Modify: `lib/domain-monitor.ts`

Context: Currently calls `deliverWebhook(...)` fire-and-forget (no `await`) at line ~442. Replace with inline `attemptDelivery` + `enqueueFailedDelivery` on failure. Remove the old `deliverWebhook` function entirely (lines ~322–371). `crypto` stays because `credentialFingerprint` and `testWebhook` use it.

- [ ] **Step 1: Add import**

At the top of `lib/domain-monitor.ts`, the current imports are:
```ts
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import crypto from 'crypto'
```

Add the worker import:
```ts
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery } from '@/lib/webhook-outbox-worker'
import crypto from 'crypto'
```

- [ ] **Step 2: Replace the deliverWebhook call site**

Find this block (inside `checkMonitorsForULPUpload`, around line 440):
```ts
        for (const wr of webhookRows) {
          const webhook = parseWebhookRow(wr)
          deliverWebhook(webhook, payloadJson, monitor.id, sourceFile, monitor.domains.join(','), unseenRows.length)
            .catch(err => log(`Webhook delivery error: ${err}`, 'error'))
        }
```

Replace with:
```ts
        for (const wr of webhookRows) {
          const webhook = parseWebhookRow(wr)
          const result = await attemptDelivery(webhook, payloadJson)
          dbRun(
            `INSERT INTO monitor_alerts
               (monitor_id, webhook_id, source_file, matched_domain, match_type,
                credential_match_count, payload_sent, status, http_status, retry_count)
             VALUES (?, ?, ?, ?, 'credential_email', ?, ?, ?, ?, 0)`,
            [monitor.id, webhook.id, sourceFile, monitor.domains.join(','),
             unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
          )
          dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [webhook.id])
          if (!result.ok) {
            enqueueFailedDelivery(monitor.id, webhook.id, payloadJson, sourceFile, monitor.domains.join(','), unseenRows.length)
            log(`Webhook delivery failed (queued for retry): ${result.error}`, 'warning')
          }
        }
```

- [ ] **Step 3: Remove the deliverWebhook function**

Delete the entire `deliverWebhook` function and its section header comment. It spans from:
```ts
// ─── Webhook delivery ─────────────────────────────────────────────────────────

async function deliverWebhook(
```
to the closing `}` of the function (the `}` just before `// ─── ULP monitoring`). Delete all of it.

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: all tests pass (389 total).

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/domain-monitor.ts
git commit -m "fix(domain-monitor): replace fire-and-forget delivery with outbox-backed retry"
```

---

### Task 4: Wire up monitor-rescan-cron.ts

**Files:**
- Modify: `lib/monitor-rescan-cron.ts`

Context: Currently calls `deliverWebhookSimple(...)` fire-and-forget (line ~172). Replace with inline `attemptDelivery` + `enqueueFailedDelivery` on failure. Add `runWebhookOutboxTick()` at the end of `runTick()`. Remove `deliverWebhookSimple` function (lines ~199–240). `crypto` stays for `credentialFingerprint`.

- [ ] **Step 1: Add import**

Current imports at top of file:
```ts
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import crypto from 'crypto'
```

Change to:
```ts
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import crypto from 'crypto'
```

- [ ] **Step 2: Replace the deliverWebhookSimple call site**

Find this block (inside `runTick`, around line 170):
```ts
      // Fire webhooks (fire-and-forget with basic error logging)
      for (const wr of webhookRows) {
        deliverWebhookSimple(wr, payloadJson, monitorRow.id, domains.join(','), unseenRows.length)
          .catch(err => console.error(`[monitor-rescan] webhook delivery error: ${err}`))
      }
```

Replace with:
```ts
      // Attempt delivery inline; enqueue for retry on failure
      for (const wr of webhookRows) {
        let parsedHeaders: Record<string, string> | null = null
        try { parsedHeaders = wr.headers ? JSON.parse(wr.headers) : null } catch {}
        const result = await attemptDelivery({ url: wr.url, secret: wr.secret, headers: parsedHeaders }, payloadJson)
        dbRun(
          `INSERT INTO monitor_alerts
             (monitor_id, webhook_id, source_file, matched_domain, match_type,
              credential_match_count, payload_sent, status, http_status, retry_count)
           VALUES (?, ?, '[scheduled-rescan]', ?, 'credential_email', ?, ?, ?, ?, 0)`,
          [monitorRow.id, wr.id, domains.join(','),
           unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
        )
        dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [wr.id])
        if (!result.ok) {
          enqueueFailedDelivery(monitorRow.id, wr.id, payloadJson, '[scheduled-rescan]', domains.join(','), unseenRows.length)
          console.error(`[monitor-rescan] webhook delivery failed (queued for retry): ${result.error}`)
        }
      }
```

- [ ] **Step 3: Add runWebhookOutboxTick at end of runTick**

Find the end of `runTick()`. It looks like:

```ts
  console.log(`[monitor-rescan] tick: due=${dueMonitors.length} fired=${fired}`)
}
```

Change to:

```ts
  console.log(`[monitor-rescan] tick: due=${dueMonitors.length} fired=${fired}`)

  // Process any pending outbox retries from previous failed deliveries
  await runWebhookOutboxTick()
}
```

- [ ] **Step 4: Remove deliverWebhookSimple function**

Delete the entire `deliverWebhookSimple` function and its section header comment. It spans from:
```ts
// ─── Minimal webhook delivery ────────────────────────────────────────────────

async function deliverWebhookSimple(
```
to the closing `}` of the function (just before the end of the file or the next export). Delete all of it.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass (389 total).

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add lib/monitor-rescan-cron.ts
git commit -m "fix(monitor-rescan): replace fire-and-forget delivery with outbox-backed retry"
```

---

### Task 5: Final verification

**Files:** None modified.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected:
```
Test Files  7 passed (7)
     Tests  389 passed (389)
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 3: Verify commits**

```bash
git log --oneline -6
```

Expected (most recent first):
```
<sha>  fix(monitor-rescan): replace fire-and-forget delivery with outbox-backed retry
<sha>  fix(domain-monitor): replace fire-and-forget delivery with outbox-backed retry
<sha>  feat(outbox): add webhook delivery worker with retry + dead-letter
<sha>  feat(db): add webhook_outbox table to SQLite schema
```
