# Domain Monitor Match Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make domain-monitor subdomain matching and `match_mode` filtering behave the way the UI already claims they do, in both the upload-triggered check and the scheduled rescan.

**Architecture:** Extract the match predicate (subdomain-aware domain/email matching, plus the `match_mode` → `match_type` mapping) into a new pure module, `lib/domain-match.ts`, fully unit-tested with no I/O. Use it to fix the hand-built ClickHouse `WHERE` fragments in `lib/domain-monitor.ts`'s `checkMonitorsForULPUpload` and `lib/monitor-rescan-cron.ts`'s `runTick` — both currently do an exact-string domain equality (`(domain) = {domain:String}`) regardless of `match_mode`, and both hardcode `match_type = 'credential_email'` on every alert row regardless of how the match was actually found. Each file keeps its own small SQL-fragment builder, mirroring the existing pattern where both files already duplicate `credentialFingerprint()` rather than share it.

**Tech Stack:** TypeScript, Vitest, ClickHouse (`@clickhouse/client` via `lib/clickhouse.ts`), SQLite (`better-sqlite3` via `lib/sqlite.ts`).

## Global Constraints

- Every new/changed function gets Vitest coverage under `__tests__/`, following the existing `vi.mock('@/lib/sqlite', ...)` pattern used in `__tests__/webhook-outbox-worker.test.ts`.
- No change to `credentialFingerprint()`, the dedup-fingerprint tables, webhook delivery, or the outbox worker — this plan touches match *detection* only.
- No change to the `domain_monitors`/`monitor_alerts` schema — `match_type` already supports `'credential_email' | 'url' | 'both'` and `credential_match_count`/`url_match_count` already exist. This plan only starts writing a correct `match_type`; it leaves `url_match_count` at 0 (pre-existing, out of scope — splitting per-row match provenance into separate URL/email counts is a bigger change than "make the selector filter" and isn't part of this plan).
- Preserve existing behavior exactly for `match_mode: 'both'` monitors — this is the default and the only mode actually exercised in production today, so its results must not change other than gaining the subdomain matches it should already have had.
- "Matches" means: the candidate is the monitored domain itself, or any subdomain of it (label-boundary suffix match — `aave.com` matches `app.aave.com` but not `notaave.com`).

---

## Task 1: Pure domain-match predicate module

**Files:**
- Create: `lib/domain-match.ts`
- Test: `__tests__/domain-match.test.ts`

**Interfaces:**
- Produces: `domainMatches(candidate: string, monitored: string): boolean`, `emailDomainMatches(email: string, monitored: string): boolean`, `credentialMatchesDomain(cred: { domain: string; email: string }, monitored: string, mode: 'credential' | 'url' | 'both'): boolean`, `matchModeToMatchType(mode: 'credential' | 'url' | 'both'): 'credential_email' | 'url' | 'both'`, and `type MatchMode = 'credential' | 'url' | 'both'`. Tasks 2–3 of this plan import these, as does the follow-up in-process-matching plan.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/domain-match.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { domainMatches, emailDomainMatches, credentialMatchesDomain, matchModeToMatchType } from '@/lib/domain-match'

describe('domainMatches', () => {
  test('matches the exact domain', () => {
    expect(domainMatches('aave.com', 'aave.com')).toBe(true)
  })

  test('matches a subdomain of the monitored domain', () => {
    expect(domainMatches('app.aave.com', 'aave.com')).toBe(true)
    expect(domainMatches('stake.lido.fi', 'lido.fi')).toBe(true)
  })

  test('matches a multi-level subdomain', () => {
    expect(domainMatches('a.b.aave.com', 'aave.com')).toBe(true)
  })

  test('does not match a different domain that merely ends with the same letters', () => {
    expect(domainMatches('notaave.com', 'aave.com')).toBe(false)
    expect(domainMatches('evilaave.com', 'aave.com')).toBe(false)
  })

  test('does not match the reverse direction (monitoring the subdomain does not match the parent)', () => {
    expect(domainMatches('aave.com', 'app.aave.com')).toBe(false)
  })

  test('is case-insensitive and trims whitespace', () => {
    expect(domainMatches('APP.Aave.COM', ' aave.com ')).toBe(true)
  })

  test('returns false for empty inputs', () => {
    expect(domainMatches('', 'aave.com')).toBe(false)
    expect(domainMatches('aave.com', '')).toBe(false)
  })
})

describe('emailDomainMatches', () => {
  test('matches when the email domain equals the monitored domain', () => {
    expect(emailDomainMatches('user@aave.com', 'aave.com')).toBe(true)
  })

  test('matches when the email domain is a subdomain of the monitored domain', () => {
    expect(emailDomainMatches('user@mail.aave.com', 'aave.com')).toBe(true)
  })

  test('does not match a different email domain', () => {
    expect(emailDomainMatches('user@notaave.com', 'aave.com')).toBe(false)
  })

  test('returns false when there is no @ in the email', () => {
    expect(emailDomainMatches('not-an-email', 'aave.com')).toBe(false)
  })
})

describe('credentialMatchesDomain', () => {
  const cred = { domain: 'other.com', email: 'user@app.aave.com' }

  test('mode "url" only checks the credential domain', () => {
    expect(credentialMatchesDomain(cred, 'aave.com', 'url')).toBe(false)
    expect(credentialMatchesDomain({ ...cred, domain: 'app.aave.com' }, 'aave.com', 'url')).toBe(true)
  })

  test('mode "credential" only checks the email domain', () => {
    expect(credentialMatchesDomain(cred, 'aave.com', 'credential')).toBe(true)
    expect(credentialMatchesDomain({ ...cred, email: 'user@other.com' }, 'aave.com', 'credential')).toBe(false)
  })

  test('mode "both" matches on either', () => {
    expect(credentialMatchesDomain(cred, 'aave.com', 'both')).toBe(true)
    expect(credentialMatchesDomain({ domain: 'other.com', email: 'user@other.com' }, 'aave.com', 'both')).toBe(false)
  })
})

describe('matchModeToMatchType', () => {
  test('maps "credential" to "credential_email"', () => {
    expect(matchModeToMatchType('credential')).toBe('credential_email')
  })

  test('passes "url" and "both" through unchanged', () => {
    expect(matchModeToMatchType('url')).toBe('url')
    expect(matchModeToMatchType('both')).toBe('both')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: FAIL — `Cannot find module '@/lib/domain-match'`

- [ ] **Step 3: Implement `lib/domain-match.ts`**

```typescript
/**
 * Pure domain-matching predicates shared by the upload-triggered monitor
 * check and the scheduled rescan (lib/domain-monitor.ts, lib/monitor-rescan-cron.ts).
 *
 * "Matches" means: the candidate is the monitored domain itself, or any
 * subdomain of it (label-boundary suffix match — "aave.com" matches
 * "app.aave.com" but not "notaave.com").
 */

export type MatchMode = 'credential' | 'url' | 'both'

export function domainMatches(candidate: string, monitored: string): boolean {
  const c = candidate.toLowerCase().trim()
  const m = monitored.toLowerCase().trim()
  if (!c || !m) return false
  return c === m || c.endsWith('.' + m)
}

export function emailDomainMatches(email: string, monitored: string): boolean {
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  return domainMatches(email.slice(at + 1), monitored)
}

export function credentialMatchesDomain(
  cred: { domain: string; email: string },
  monitored: string,
  mode: MatchMode,
): boolean {
  if (mode === 'url') return domainMatches(cred.domain, monitored)
  if (mode === 'credential') return emailDomainMatches(cred.email, monitored)
  return domainMatches(cred.domain, monitored) || emailDomainMatches(cred.email, monitored)
}

export function matchModeToMatchType(mode: MatchMode): 'credential_email' | 'url' | 'both' {
  return mode === 'credential' ? 'credential_email' : mode
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/domain-match.ts __tests__/domain-match.test.ts
git commit -m "feat(monitoring): add pure domain-match predicate module"
```

---

## Task 2: Fix subdomain matching and match_mode in the upload-triggered check

**Files:**
- Modify: `lib/domain-monitor.ts:322-435` (the `checkMonitorsForULPUpload` function and the query it builds)
- Test: Create `__tests__/domain-monitor.test.ts`

**Interfaces:**
- Consumes: `matchModeToMatchType`, `type MatchMode` from `lib/domain-match.ts` (Task 1). `NORM_DOMAIN_EXPR`, `NORM_EMAIL_EXPR` from `@/lib/ulp-normalize` (unchanged, existing).
- Produces: no signature change to `checkMonitorsForULPUpload(sourceFile, logFn?)` — same exported name and signature, only its internal query and the `match_type` it writes change. (A follow-up plan replaces this function's only call site and deletes it — keeping the signature stable here means that plan's diff is isolated to the call site, not this fix.)

There is currently no test file for `lib/domain-monitor.ts`. This task adds the first one. It intentionally does not re-test webhook delivery mechanics (`attemptDelivery`/`enqueueFailedDelivery`) — those already have coverage in `__tests__/webhook-outbox-worker.test.ts` and are mocked here.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/domain-monitor.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: FAIL — mode-specific assertions fail because the current query always includes both conditions and always writes `match_type: 'credential_email'`.

- [ ] **Step 3: Modify `checkMonitorsForULPUpload` in `lib/domain-monitor.ts`**

Add this import at the top of `lib/domain-monitor.ts`, alongside the existing imports:

```typescript
import { matchModeToMatchType, type MatchMode } from '@/lib/domain-match'
```

Add this helper immediately before the `// ─── ULP monitoring ───` section comment (i.e. right after `getAlertStats` ends):

```typescript
/** Build the subdomain-aware WHERE fragment for a monitor's match_mode. Params: {domain}, {domainSuffix}. */
function matchConditionSQL(mode: MatchMode): string {
  const urlCond = `((${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith((${NORM_DOMAIN_EXPR}), {domainSuffix:String}))`
  const emailDomainExpr = `substring(lower(${NORM_EMAIL_EXPR}), position(lower(${NORM_EMAIL_EXPR}), '@') + 1)`
  const emailCond = `((${emailDomainExpr}) = {domain:String} OR endsWith((${emailDomainExpr}), {domainSuffix:String}))`
  if (mode === 'url') return urlCond
  if (mode === 'credential') return emailCond
  return `(${urlCond} OR ${emailCond})`
}
```

Replace the query-building loop inside `checkMonitorsForULPUpload` (currently `lib/domain-monitor.ts:339-350`):

```typescript
        for (const domain of monitor.domains) {
          const d = domain.toLowerCase().trim()
          const rows = await executeClickHouseQuery(
            `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
             FROM ulp.credentials
             WHERE source_file = {sourceFile:String}
               AND ((${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith(lower(${NORM_EMAIL_EXPR}), {emailSuffix:String}))
             LIMIT 100`,
            { sourceFile, domain: d, emailSuffix: `@${d}` }
          ) as Array<{ url: string; email: string; password: string; domain: string }>
          matchedRows.push(...rows)
        }
```

with:

```typescript
        for (const domain of monitor.domains) {
          const d = domain.toLowerCase().trim()
          const rows = await executeClickHouseQuery(
            `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
             FROM ulp.credentials
             WHERE source_file = {sourceFile:String}
               AND ${matchConditionSQL(monitor.match_mode)}
             LIMIT 100`,
            { sourceFile, domain: d, domainSuffix: `.${d}` }
          ) as Array<{ url: string; email: string; password: string; domain: string }>
          matchedRows.push(...rows)
        }
```

Then find the `monitor_alerts` INSERT further down in the same function, which currently hardcodes `'credential_email'`:

```typescript
          dbRun(
            `INSERT INTO monitor_alerts
               (monitor_id, webhook_id, source_file, matched_domain, match_type,
                credential_match_count, payload_sent, status, http_status, retry_count)
             VALUES (?, ?, ?, ?, 'credential_email', ?, ?, ?, ?, 0)`,
            [monitor.id, webhook.id, sourceFile, matchedDomain,
             unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
          )
```

Replace with:

```typescript
          dbRun(
            `INSERT INTO monitor_alerts
               (monitor_id, webhook_id, source_file, matched_domain, match_type,
                credential_match_count, payload_sent, status, http_status, retry_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [monitor.id, webhook.id, sourceFile, matchedDomain, matchModeToMatchType(monitor.match_mode),
             unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
          )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — no other suite references the old `emailSuffix` param name or the hardcoded `'credential_email'` literal this task removed.

- [ ] **Step 6: Commit**

```bash
git add lib/domain-monitor.ts __tests__/domain-monitor.test.ts
git commit -m "fix(monitoring): respect subdomain matches and match_mode in upload-triggered check"
```

---

## Task 3: Fix subdomain matching and match_mode in the scheduled rescan

**Files:**
- Modify: `lib/monitor-rescan-cron.ts`
- Test: Create `__tests__/monitor-rescan-cron.test.ts`

**Interfaces:**
- Consumes: `matchModeToMatchType`, `type MatchMode` from `lib/domain-match.ts` (Task 1).
- Produces: exports `runTick` (currently module-private) for direct testability, matching the existing pattern of exporting `checkMonitorsForULPUpload` for the same reason. No change to `startMonitorRescanCron()`'s exported signature or scheduling behavior.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/monitor-rescan-cron.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts`
Expected: FAIL — `runTick` isn't exported yet (`Cannot find module` / `SyntaxError` on the named import), and once exported, the mode-specific assertions fail (both conditions always present, `match_type` always `'credential_email'`).

- [ ] **Step 3: Modify `lib/monitor-rescan-cron.ts`**

Add the import (alongside the existing imports at the top):

```typescript
import { matchModeToMatchType, type MatchMode } from '@/lib/domain-match'
```

Add `match_mode` to the `DueMonitorRow` interface (currently lines 47-53):

```typescript
interface DueMonitorRow {
  id: number
  name: string
  domains: string
  match_mode: MatchMode
  rescan_mode: 'dedup' | 'digest'
  rescan_interval_hours: number
}
```

Add the SQL-fragment helper immediately before `async function runTick`. This mirrors the helper added to `lib/domain-monitor.ts` in Task 2 — this file already mirrors `credentialFingerprint` from that file rather than importing it, so this follows the same established pattern:

```typescript
/** Build the subdomain-aware WHERE fragment for a monitor's match_mode. Params: {domain}, {domainSuffix}. Mirrors lib/domain-monitor.ts. */
function matchConditionSQL(mode: MatchMode): string {
  const urlCond = `((${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith((${NORM_DOMAIN_EXPR}), {domainSuffix:String}))`
  const emailDomainExpr = `substring(lower(${NORM_EMAIL_EXPR}), position(lower(${NORM_EMAIL_EXPR}), '@') + 1)`
  const emailCond = `((${emailDomainExpr}) = {domain:String} OR endsWith((${emailDomainExpr}), {domainSuffix:String}))`
  if (mode === 'url') return urlCond
  if (mode === 'credential') return emailCond
  return `(${urlCond} OR ${emailCond})`
}
```

Change the function declaration from module-private to exported (currently `lib/monitor-rescan-cron.ts:71`):

```typescript
async function runTick(): Promise<void> {
```

to:

```typescript
export async function runTick(): Promise<void> {
```

Update the due-monitors query to select `match_mode` (currently `lib/monitor-rescan-cron.ts:73-81`):

```typescript
  const dueMonitors = dbQuery(`
    SELECT id, name, domains, rescan_mode, rescan_interval_hours
    FROM domain_monitors
    WHERE is_active = 1
      AND (
        last_triggered_at IS NULL
        OR (unixepoch('now') - unixepoch(last_triggered_at)) >= rescan_interval_hours * 3600
      )
  `) as DueMonitorRow[]
```

to:

```typescript
  const dueMonitors = dbQuery(`
    SELECT id, name, domains, match_mode, rescan_mode, rescan_interval_hours
    FROM domain_monitors
    WHERE is_active = 1
      AND (
        last_triggered_at IS NULL
        OR (unixepoch('now') - unixepoch(last_triggered_at)) >= rescan_interval_hours * 3600
      )
  `) as DueMonitorRow[]
```

Replace the per-domain query loop (currently `lib/monitor-rescan-cron.ts:104-115`):

```typescript
      const matchedRows: CredentialRow[] = []
      for (const domain of domains) {
        const d = domain.toLowerCase().trim()
        const rows = await executeClickHouseQuery(
          `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
           FROM ulp.credentials
           WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
              OR endsWith(lower(${NORM_EMAIL_EXPR}), {emailSuffix:String})
           LIMIT 100`,
          { domain: d, emailSuffix: `@${d}` }
        ) as CredentialRow[]
        matchedRows.push(...rows)
      }
```

with:

```typescript
      const matchedRows: CredentialRow[] = []
      for (const domain of domains) {
        const d = domain.toLowerCase().trim()
        const rows = await executeClickHouseQuery(
          `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
           FROM ulp.credentials
           WHERE ${matchConditionSQL(monitorRow.match_mode)}
           LIMIT 100`,
          { domain: d, domainSuffix: `.${d}` }
        ) as CredentialRow[]
        matchedRows.push(...rows)
      }
```

Then find the `monitor_alerts` INSERT in the `for (const wr of webhookRows)` loop (currently `lib/monitor-rescan-cron.ts:178-185`), which hardcodes `'credential_email'`:

```typescript
        dbRun(
          `INSERT INTO monitor_alerts
             (monitor_id, webhook_id, source_file, matched_domain, match_type,
              credential_match_count, payload_sent, status, http_status, retry_count)
           VALUES (?, ?, '[scheduled-rescan]', ?, 'credential_email', ?, ?, ?, ?, 0)`,
          [monitorRow.id, wr.id, matchedDomain,
           unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
        )
```

Replace with:

```typescript
        dbRun(
          `INSERT INTO monitor_alerts
             (monitor_id, webhook_id, source_file, matched_domain, match_type,
              credential_match_count, payload_sent, status, http_status, retry_count)
           VALUES (?, ?, '[scheduled-rescan]', ?, ?, ?, ?, ?, ?, 0)`,
          [monitorRow.id, wr.id, matchedDomain, matchModeToMatchType(monitorRow.match_mode),
           unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/monitor-rescan-cron.ts __tests__/monitor-rescan-cron.test.ts
git commit -m "fix(monitoring): respect subdomain matches and match_mode in scheduled rescan"
```
