# Monitor Unread Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show "what's new since I last looked" per monitor — per admin, not shared — on top of the live matches view from `2026-08-23-monitor-live-search.md`.

**Architecture:** `monitor_credential_seen(monitor_id, fingerprint, seen_at)` already timestamps when a credential was first recorded for a monitor, but only gets written when the monitor has an active webhook. Un-gate that write so it always happens, add a small `monitor_views(monitor_id, user_id, last_viewed_at)` table as a per-admin read cursor, and cross-reference the two in the matches endpoint to flag rows as new.

**Tech Stack:** SQLite (`better-sqlite3` via `lib/sqlite.ts`), Next.js 14 API routes, Vitest.

## Global Constraints

- Depends on `2026-08-23-monitor-live-search.md` being implemented first — Task 3 here modifies the endpoint and UI that plan's Task 2/3 create.
- "New since I last looked" is per-admin, not shared across all admins — confirmed design choice: a `monitor_views` join table keyed on `(monitor_id, user_id)`, not a single column on `domain_monitors`.
- No change to webhook delivery semantics: `monitor_alerts` rows still only get inserted when at least one active webhook exists (the table's `webhook_id` column is `NOT NULL` with a foreign key to `monitor_webhooks` — there is nothing valid to insert without one). Only the `monitor_credential_seen` bookkeeping is un-gated from webhook existence, not alert delivery/logging.
- `total_alerts` on `domain_monitors` continues to count webhook deliveries specifically — do not repurpose it to count matches.

---

### Task 1: Un-gate match recording from webhook existence

**Files:**
- Modify: `lib/domain-match.ts`
- Modify: `lib/domain-monitor.ts`
- Modify: `lib/monitor-rescan-cron.ts`
- Test: `__tests__/domain-match.test.ts`
- Test: `__tests__/domain-monitor.test.ts`
- Test: `__tests__/monitor-rescan-cron.test.ts`

**Interfaces:**
- Produces: `credentialFingerprint(email: string, password: string, domain: string): string`, now exported from `lib/domain-match.ts`. Task 3 imports this to cross-reference live ClickHouse rows against `monitor_credential_seen`.
- Consumes: nothing from other tasks in this plan.

- [ ] **Step 1: Write the failing test for the moved fingerprint function**

Append to `__tests__/domain-match.test.ts`:

```typescript
describe('credentialFingerprint', () => {
  test('is deterministic for the same inputs', () => {
    expect(credentialFingerprint('user@aave.com', 'hunter2', 'aave.com'))
      .toBe(credentialFingerprint('user@aave.com', 'hunter2', 'aave.com'))
  })

  test('is a 16-char hex string', () => {
    expect(credentialFingerprint('user@aave.com', 'hunter2', 'aave.com')).toMatch(/^[0-9a-f]{16}$/)
  })

  test('differs when any one field differs', () => {
    const base = credentialFingerprint('user@aave.com', 'hunter2', 'aave.com')
    expect(credentialFingerprint('other@aave.com', 'hunter2', 'aave.com')).not.toBe(base)
    expect(credentialFingerprint('user@aave.com', 'other', 'aave.com')).not.toBe(base)
    expect(credentialFingerprint('user@aave.com', 'hunter2', 'other.com')).not.toBe(base)
  })
})
```

Add `credentialFingerprint` to this file's existing `@/lib/domain-match` import line (it currently ends with `matchConditionSQL, buildDomainSetWhereClause` from the live-search plan — add `credentialFingerprint` alongside them).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: FAIL — `credentialFingerprint` is not exported from `lib/domain-match.ts` yet.

- [ ] **Step 3: Add credentialFingerprint to lib/domain-match.ts**

Add `import crypto from 'crypto'` alongside the existing `import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'` line at the top of `lib/domain-match.ts`.

Append this function (place it near the top, right after the imports, before `export type MatchMode`):

```typescript

/**
 * Compute a 64-bit hex fingerprint for a credential triple (email, password, domain).
 * Uses 8 bytes (16 hex chars) of SHA-256 — collision probability negligible even at
 * billions of stored fingerprints (birthday bound ~2^32 with 4 bytes was dangerously low).
 * Shared by the upload-triggered check, the scheduled rescan, and the live-matches
 * endpoint's new-since-last-viewed comparison — all three need the exact same
 * fingerprint for a given (email, password, domain) to agree on monitor_credential_seen.
 */
export function credentialFingerprint(email: string, password: string, domain: string): string {
  return crypto.createHash('sha256')
    .update(email).update('\0')
    .update(password).update('\0')
    .update(domain)
    .digest()
    .slice(0, 8)
    .toString('hex')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: PASS.

- [ ] **Step 5: Restructure lib/domain-monitor.ts — un-gate fingerprint recording**

Remove the local `credentialFingerprint` function (lines near the top of the file, right after the imports):

```typescript
function credentialFingerprint(email: string, password: string, domain: string): string {
  return crypto.createHash('sha256')
    .update(email).update('\0')
    .update(password).update('\0')
    .update(domain)
    .digest()
    .slice(0, 8)
    .toString('hex')
}
```

Update the file's top imports — change:

```typescript
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { attemptDelivery, enqueueFailedDelivery } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, type MatchedCredential } from '@/lib/domain-match'
import crypto from 'crypto'
```

to:

```typescript
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { attemptDelivery, enqueueFailedDelivery } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, credentialFingerprint, type MatchedCredential } from '@/lib/domain-match'
```

(`crypto` is dropped — after removing the local function it's unused in this file. Confirm with `grep -n "crypto\." lib/domain-monitor.ts` before removing the import; if some other usage exists, keep it.)

In `fireMonitorAlertsFromMatches`, find this block:

```typescript
      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorId]
      ) as Record<string, unknown>[]

      if (webhookRows.length === 0) continue

      const payload = {
```

Replace it with:

```typescript
      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorId]
      ) as Record<string, unknown>[]

      // Record fingerprints regardless of whether any webhook exists to
      // deliver to — this is what lets a webhook-less monitor's matches
      // still show up in the live saved-search / unread-tracking views.
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          `INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)`,
          [monitorId, fp]
        )
      }

      if (webhookRows.length === 0) {
        // No webhook to deliver to, but the monitor was still checked and
        // its matches recorded above — bump last_triggered_at so the rescan
        // cron doesn't treat it as never-checked, without touching
        // total_alerts (that column counts webhook deliveries, not matches).
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorId])
        log(`Monitor "${monitor.name}" matched ${unseenRows.length} new credential(s) — no active webhooks, recorded only`, 'info')
        continue
      }

      const payload = {
```

Then find the now-duplicate fingerprint-recording loop further down (right before the final `domain_monitors` update) and delete it — remove this block entirely:

```typescript
      // Record fingerprints so future uploads of the same credentials don't re-alert
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          `INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)`,
          [monitorId, fp]
        )
      }

```

(Leave the `dbRun(UPDATE domain_monitors SET last_triggered_at = ..., total_alerts = total_alerts + ? WHERE id = ?, [webhookRows.length, monitorId])` call that follows it exactly where it is — that one only runs now when `webhookRows.length > 0`, since the zero case already `continue`d above.)

- [ ] **Step 6: Update the existing "no active webhooks" test**

In `__tests__/domain-monitor.test.ts`, find:

```typescript
  test('does not deliver when the monitor has no active webhooks', async () => {
    mockDbQuery
      .mockReturnValueOnce([])  // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([])  // no active webhooks

    const monitors = new Map([[1, parsedMonitor()]])
    await fireMonitorAlertsFromMatches('file.txt', [MATCH], monitors)

    expect(mockAttemptDelivery).not.toHaveBeenCalled()
  })
```

Replace it with:

```typescript
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
```

- [ ] **Step 7: Run the domain-monitor suite**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: PASS, all tests including the updated one.

- [ ] **Step 8: Restructure lib/monitor-rescan-cron.ts — the same un-gating**

Update the import block — change:

```typescript
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, matchConditionSQL, type MatchMode } from '@/lib/domain-match'
import crypto from 'crypto'
```

to:

```typescript
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, matchConditionSQL, credentialFingerprint, type MatchMode } from '@/lib/domain-match'
```

(`crypto` is dropped for the same reason as Step 5 — confirm with `grep -n "crypto\." lib/monitor-rescan-cron.ts` first.)

Remove the local `credentialFingerprint` function (in the `// ─── Fingerprinting (mirrors lib/domain-monitor.ts) ───` section):

```typescript
function credentialFingerprint(email: string, password: string, domain: string): string {
  return crypto.createHash('sha256')
    .update(email).update('\0')
    .update(password).update('\0')
    .update(domain)
    .digest()
    .slice(0, 8)
    .toString('hex')
}
```

In `runTick`, find:

```typescript
      // Fetch active webhooks for this monitor
      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorRow.id]
      ) as WebhookRow[]

      if (webhookRows.length === 0) {
        // Still update last_triggered_at so we don't hammer ClickHouse
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      const payload = {
```

Replace it with:

```typescript
      // Fetch active webhooks for this monitor
      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorRow.id]
      ) as WebhookRow[]

      // Record seen fingerprints regardless of webhook count — see
      // lib/domain-monitor.ts's mirrored comment for why a webhook-less
      // monitor still needs its matches recorded.
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          'INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)',
          [monitorRow.id, fp]
        )
      }

      if (webhookRows.length === 0) {
        // Still update last_triggered_at so we don't hammer ClickHouse
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      const payload = {
```

Then find the now-duplicate fingerprint-recording loop further down and delete it:

```typescript
      // Record seen fingerprints (dedup mode) or after re-clear (digest mode)
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          'INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)',
          [monitorRow.id, fp]
        )
      }

```

(Leave the `dbRun(UPDATE domain_monitors SET last_triggered_at = ..., total_alerts = ...)` call and the `fired++` line right after it exactly where they are.)

- [ ] **Step 9: Write the new "records without webhooks" test**

Append to `__tests__/monitor-rescan-cron.test.ts`:

```typescript
describe('runTick — match recording without webhooks', () => {
  test('records a seen-fingerprint and bumps last_triggered_at even when the monitor has no active webhooks', async () => {
    mockDbQuery
      .mockReturnValueOnce([dueMonitorRow()])  // due monitors
      .mockReturnValueOnce([])                 // seen-fingerprint IN-query — nothing seen
      .mockReturnValueOnce([])                 // no active webhooks
    mockExecuteQuery.mockResolvedValueOnce([MATCHED_ROW])

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
```

- [ ] **Step 10: Run both suites, then the full suite**

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts __tests__/domain-monitor.test.ts __tests__/domain-match.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add lib/domain-match.ts lib/domain-monitor.ts lib/monitor-rescan-cron.ts __tests__/domain-match.test.ts __tests__/domain-monitor.test.ts __tests__/monitor-rescan-cron.test.ts
git commit -m "fix(domain-monitor): record matches even when a monitor has no webhooks"
```

---

### Task 2: monitor_views table + per-admin last-viewed helpers

**Files:**
- Modify: `lib/sqlite.ts`
- Modify: `lib/domain-monitor.ts`
- Test: `__tests__/domain-monitor.test.ts`

**Interfaces:**
- Produces: `getLastViewedAt(monitorId: number, userId: number): Promise<string | null>`, `recordMonitorViewed(monitorId: number, userId: number): Promise<void>`, both exported from `lib/domain-monitor.ts`. Task 3 imports both.
- Consumes: nothing from other tasks in this plan.

- [ ] **Step 1: Add the schema**

In `lib/sqlite.ts`, find the `monitor_credential_seen` table definition:

```sql
    CREATE TABLE IF NOT EXISTS monitor_credential_seen (
      monitor_id  INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (monitor_id, fingerprint)
    );
```

Add this new table right after it:

```sql

    -- Per-admin "last looked at this monitor's matches" cursor. Compared
    -- against monitor_credential_seen.seen_at to flag which matches are new
    -- since a given admin's last view. Deliberately keyed per (monitor_id,
    -- user_id) rather than a single column on domain_monitors — unread state
    -- is per-admin, not shared.
    CREATE TABLE IF NOT EXISTS monitor_views (
      monitor_id     INTEGER NOT NULL,
      user_id        INTEGER NOT NULL,
      last_viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (monitor_id, user_id),
      FOREIGN KEY (monitor_id) REFERENCES domain_monitors(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
```

- [ ] **Step 2: Write the failing tests**

In `__tests__/domain-monitor.test.ts`, add `getLastViewedAt, recordMonitorViewed` to the existing `@/lib/domain-monitor` import line. Append this new describe block at the end of the file:

```typescript
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: FAIL — `getLastViewedAt`/`recordMonitorViewed` are not exported from `lib/domain-monitor.ts` yet.

- [ ] **Step 4: Add the helpers to lib/domain-monitor.ts**

Add this near the end of the file, after `testWebhook`:

```typescript

// ─── Per-admin view tracking ─────────────────────────────────────────────────

export async function getLastViewedAt(monitorId: number, userId: number): Promise<string | null> {
  const row = dbGet(
    `SELECT last_viewed_at FROM monitor_views WHERE monitor_id = ? AND user_id = ?`,
    [monitorId, userId]
  ) as { last_viewed_at: string } | undefined
  return row?.last_viewed_at ?? null
}

export async function recordMonitorViewed(monitorId: number, userId: number): Promise<void> {
  dbRun(
    `INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(monitor_id, user_id) DO UPDATE SET last_viewed_at = datetime('now')`,
    [monitorId, userId]
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add lib/sqlite.ts lib/domain-monitor.ts __tests__/domain-monitor.test.ts
git commit -m "feat(domain-monitor): add per-admin monitor_views last-viewed tracking"
```

---

### Task 3: Wire "new since last view" into the matches endpoint and UI

**Files:**
- Modify: `app/api/monitoring/monitors/[id]/matches/route.ts`
- Modify: `app/monitoring/page.tsx`
- Test: `__tests__/monitor-matches-route.test.ts`

**Interfaces:**
- Consumes: `credentialFingerprint` from Task 1, `getLastViewedAt`/`recordMonitorViewed` from Task 2, `dbQuery` from `lib/sqlite.ts` (existing).
- Produces: `GET /api/monitoring/monitors/[id]/matches` now returns `{ success: true, results: {url,email,password,domain,is_new}[], total_shown, new_count, limited }` — a superset of the shape the live-search plan's Task 2 produced.

- [ ] **Step 1: Extend the route**

In `app/api/monitoring/monitors/[id]/matches/route.ts`, update the imports:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor } from "@/lib/domain-monitor"
import { executeQuery } from "@/lib/clickhouse"
import { buildDomainSetWhereClause } from "@/lib/domain-match"
import { NORM_DOMAIN_EXPR } from "@/lib/ulp-normalize"
```

to:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor, getLastViewedAt, recordMonitorViewed } from "@/lib/domain-monitor"
import { executeQuery } from "@/lib/clickhouse"
import { buildDomainSetWhereClause, credentialFingerprint } from "@/lib/domain-match"
import { NORM_DOMAIN_EXPR } from "@/lib/ulp-normalize"
import { dbQuery } from "@/lib/sqlite"
```

Replace the whole `try` block (from `try {` through its matching `catch` block) with:

```typescript
  const userId = parseInt(user.userId)

  try {
    const [rows, lastViewedAt] = await Promise.all([
      executeQuery(
        `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
         FROM ulp.credentials
         WHERE ${clause}
         LIMIT {matchLimit:UInt32}
         SETTINGS max_execution_time = 60, timeout_overflow_mode = 'throw'`,
        { ...domainParams, matchLimit: MATCH_LIMIT }
      ) as Promise<MatchRow[]>,
      getLastViewedAt(monitorId, userId),
    ])

    // "New" = not recorded as seen at or before this admin's last view. A
    // fingerprint absent from monitor_credential_seen entirely (e.g. the
    // rescan cron hasn't caught up yet) also counts as new.
    let oldFingerprints = new Set<string>()
    if (lastViewedAt !== null) {
      const seenRows = dbQuery(
        `SELECT fingerprint FROM monitor_credential_seen WHERE monitor_id = ? AND seen_at <= ?`,
        [monitorId, lastViewedAt]
      ) as { fingerprint: string }[]
      oldFingerprints = new Set(seenRows.map(r => r.fingerprint))
    }

    const results = rows.map(row => ({
      ...row,
      is_new: !oldFingerprints.has(credentialFingerprint(row.email, row.password, row.domain)),
    }))
    const newCount = results.filter(r => r.is_new).length

    await recordMonitorViewed(monitorId, userId)

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: newCount,
      limited: results.length === MATCH_LIMIT,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor matches query error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
```

- [ ] **Step 2: Update the route's regression tests**

In `__tests__/monitor-matches-route.test.ts`, add this test to the existing describe block:

```typescript
  test('computes is_new against the per-admin last-viewed cursor, and records the new view', () => {
    expect(source).toContain('getLastViewedAt(monitorId, userId)')
    expect(source).toContain('credentialFingerprint(row.email, row.password, row.domain)')
    expect(source).toContain('recordMonitorViewed(monitorId, userId)')
  })

  test('reads the previous last-viewed cursor before advancing it', () => {
    // Must read the OLD cursor (to compute is_new against) before calling
    // recordMonitorViewed (which advances it to now) — reversing this order
    // would make every match look "new" forever, since the cursor would
    // already be current by the time is_new is computed.
    const getViewedIdx = source.indexOf('getLastViewedAt(monitorId, userId)')
    const recordViewedIdx = source.indexOf('recordMonitorViewed(monitorId, userId)')
    expect(getViewedIdx).toBeGreaterThan(-1)
    expect(recordViewedIdx).toBeGreaterThan(getViewedIdx)
  })
```

- [ ] **Step 3: Run the route test**

Run: `npx vitest run __tests__/monitor-matches-route.test.ts`
Expected: PASS.

- [ ] **Step 4: Update the UI**

In `app/monitoring/page.tsx`, update the matches-state block from the live-search plan:

```typescript
  // Live matches ("saved search") state
  const [matchesMonitor, setMatchesMonitor] = useState<DomainMonitor | null>(null)
  const [matches, setMatches] = useState<{ url: string; email: string; password: string; domain: string }[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
```

to:

```typescript
  // Live matches ("saved search") state
  const [matchesMonitor, setMatchesMonitor] = useState<DomainMonitor | null>(null)
  const [matches, setMatches] = useState<{ url: string; email: string; password: string; domain: string; is_new: boolean }[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
  const [matchesNewCount, setMatchesNewCount] = useState(0)
```

Update `openMatches`:

```typescript
      if (data.success) {
        setMatches(data.results || [])
        setMatchesLimited(Boolean(data.limited))
      } else {
```

to:

```typescript
      if (data.success) {
        setMatches(data.results || [])
        setMatchesLimited(Boolean(data.limited))
        setMatchesNewCount(data.new_count || 0)
      } else {
```

Update the dialog description:

```tsx
            <DialogDescription>
              Credentials currently matching this monitor&apos;s domains, queried live.
              {matchesLimited && ` Showing first ${matches.length} — more may exist.`}
            </DialogDescription>
```

to:

```tsx
            <DialogDescription>
              Credentials currently matching this monitor&apos;s domains, queried live.
              {matchesNewCount > 0 && ` ${matchesNewCount} new since your last view.`}
              {matchesLimited && ` Showing first ${matches.length} — more may exist.`}
            </DialogDescription>
```

Update the domain cell to show a NEW badge:

```tsx
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs font-normal">{m.domain}</Badge>
                      </td>
```

to:

```tsx
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs font-normal">{m.domain}</Badge>
                        {m.is_new && (
                          <Badge className="text-xs font-normal ml-1.5 bg-primary/10 text-primary border-primary/20">NEW</Badge>
                        )}
                      </td>
```

- [ ] **Step 5: Start the dev server and verify manually**

Run: `npm run dev`

Navigate to `/monitoring`, click "View Matches" on a monitor with current matches. Confirm every row shows a "NEW" badge on first view (nothing viewed yet = everything new). Close and reopen the dialog — confirm rows that were already shown no longer carry the "NEW" badge (the first view's `recordMonitorViewed` call already advanced the cursor).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: all tests passing.

- [ ] **Step 8: Commit**

```bash
git add "app/api/monitoring/monitors/[id]/matches/route.ts" app/monitoring/page.tsx __tests__/monitor-matches-route.test.ts
git commit -m "feat(domain-monitor): flag matches new since an admin's last view"
```
