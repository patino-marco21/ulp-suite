# Webhook Delivery Reliability — Persistent Outbox

## Goal

Replace fire-and-forget webhook delivery with a durable outbox pattern: inline first attempt
for low latency, automatic retry with exponential backoff for failures, dead-letter after 5
attempts. No silent drops on process restart.

---

## Background — Current Problems

| Path | Problem |
|---|---|
| `lib/domain-monitor.ts` `deliverWebhook()` | In-process retry only — lost on restart. Writes a new `monitor_alerts` row per retry attempt (4 rows for a 3-retry delivery). |
| `lib/monitor-rescan-cron.ts` `deliverWebhookSimple()` | Zero retry. One attempt, then silently drops regardless of error. |

---

## Data Model

### New table: `webhook_outbox` (SQLite)

```sql
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
)
```

**`status` values:** `pending` | `retrying` | `delivered` | `dead_letter`

**`attempt_count`** starts at 1 — the inline first attempt is already counted.

**`next_attempt_at`** is set when the row is created (first failure) or updated (subsequent
failures). Rows are only processed when `next_attempt_at <= datetime('now')`.

The existing `monitor_alerts` table schema is unchanged. Each delivery attempt (inline + each
retry) writes a row to `monitor_alerts` so the existing UI history remains intact.

---

## Delivery Flow

### On trigger (upload or scheduled rescan)

1. Call `attemptDelivery(webhook, payloadJson)` — inline, immediate.
2. **Success** (`2xx` response):
   - Write `monitor_alerts` row with `status='success'`.
   - Done.
3. **Failure** (network error, timeout, `5xx`, or `4xx`):
   - Write `monitor_alerts` row with `status='failed'`.
   - If `4xx`: write `webhook_outbox` row with `status='dead_letter'` immediately (retrying a bad request won't help).
   - If network / `5xx`: write `webhook_outbox` row with `status='pending'`, `attempt_count=1`, `next_attempt_at = datetime('now', '+1 minute')`.

### Background worker — `runWebhookOutboxTick()`

Called at the end of each `runMonitorRescanTick()` invocation.

1. Select rows WHERE `status IN ('pending', 'retrying') AND next_attempt_at <= datetime('now')`.
2. For each row:
   a. Call `attemptDelivery(webhook, row.payload)`.
   b. **Success**: set `status='delivered'`, `updated_at=now`. Write `monitor_alerts` success row.
   c. **Failure, `attempt_count < 5`**: set `status='retrying'`, increment `attempt_count`,
      set `next_attempt_at` per backoff schedule, set `last_error`. Write `monitor_alerts` failed row.
   d. **Failure, `attempt_count >= 5`**: set `status='dead_letter'`, `updated_at=now`, set `last_error`. Write `monitor_alerts` failed row.
   e. **4xx response at any retry**: dead_letter immediately (same as d).

### Backoff schedule

| attempt_count after failure | next_attempt_at delay |
|---|---|
| 1 (inline failed → row created) | +1 minute |
| 2 | +2 minutes |
| 3 | +4 minutes |
| 4 | +8 minutes |
| 5 | dead_letter |

Total retry window: ~15 minutes.

---

## Shared Delivery Helper — `attemptDelivery()`

Extracted into `lib/webhook-outbox-worker.ts`. Used by both the inline path and the worker.

```ts
interface DeliveryResult {
  ok: boolean
  status: number | null   // null on network error / timeout
  error: string | null    // null on success
}

async function attemptDelivery(
  webhook: { url: string; secret: string | null; headers: Record<string, string> | null },
  payloadJson: string,
): Promise<DeliveryResult>
```

Applies HMAC-SHA256 `X-Webhook-Signature` header when `webhook.secret` is set (identical to
current implementation). 30-second AbortController timeout.

---

## File Map

| File | Change |
|---|---|
| `lib/sqlite.ts` | Add `webhook_outbox` table CREATE |
| `lib/webhook-outbox-worker.ts` | New — `attemptDelivery()`, `enqueueFailedDelivery()`, `runWebhookOutboxTick()` |
| `lib/domain-monitor.ts` | Replace `deliverWebhook()` call with inline `attemptDelivery()` + `enqueueFailedDelivery()`. Remove old `deliverWebhook` function. |
| `lib/monitor-rescan-cron.ts` | Replace `deliverWebhookSimple()` call with same inline pattern. Add `runWebhookOutboxTick()` call at end of tick. Remove `deliverWebhookSimple` function. |
| `__tests__/webhook-outbox-worker.test.ts` | New — unit tests (see below) |

No schema migration required — `webhook_outbox` is created via the existing `initDb()` path
in `lib/sqlite.ts`.

---

## Testing

All 381 existing tests must continue to pass. New unit tests in
`__tests__/webhook-outbox-worker.test.ts`:

- `enqueueFailedDelivery()` inserts a row with correct fields and `attempt_count=1`
- `enqueueFailedDelivery()` sets `next_attempt_at` ~1 minute in the future
- `runWebhookOutboxTick()` with a mock pending row + successful fetch → sets `status='delivered'`
- `runWebhookOutboxTick()` with mock failure → increments `attempt_count`, sets `status='retrying'`, sets backoff `next_attempt_at`
- `runWebhookOutboxTick()` with `attempt_count=4` + mock failure → sets `status='dead_letter'`
- `runWebhookOutboxTick()` with `attempt_count=1` + mock `400` response → sets `status='dead_letter'` immediately
- `runWebhookOutboxTick()` with no due rows → does nothing

Tests use a real in-memory SQLite database (same pattern as existing test suite) and mock `fetch` via `vi.stubGlobal`.
