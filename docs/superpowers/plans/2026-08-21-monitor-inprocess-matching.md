# Domain Monitor In-Process Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the upload-triggered monitor check's N-sequential-ClickHouse-queries-per-monitor with in-process matching against each batch as it streams to ClickHouse, so a monitor with a large domain list (e.g. 150 domains) costs one Set/Map lookup per credential instead of one ClickHouse round trip per domain.

**Architecture:** This is the reverse-search ("percolator") pattern: instead of asking ClickHouse "which stored rows match this domain?" once per monitored domain, build an in-memory index of monitored domains once per upload, then ask "which monitors does this row match?" for every row as it is parsed — an O(1)-ish Map lookup per credential instead of a linear scan. `lib/domain-monitor.ts`'s `checkMonitorsForULPUpload` (fixed for correctness in the prerequisite plan, `2026-08-21-monitor-match-correctness.md`) queried ClickHouse fresh for each domain of each monitor, after the fact, scoped to `source_file = filename`. That is exactly redundant with in-process matching during the same upload it would have re-queried for, so this plan deletes it and replaces its only call site (`lib/upload-processor.ts`). The **scheduled rescan** (`lib/monitor-rescan-cron.ts`) is unaffected — it deliberately re-scans historical data across all previously-imported files, which an in-process, single-upload check cannot do, so it keeps querying ClickHouse (with the correctness fixes from the prerequisite plan already applied).

Freshly-parsed `ULPCredential.domain` (from the current, v5 parser's `extractDomain()`) needs no legacy-corruption correction — `lib/ulp-normalize.ts`'s `NORM_DOMAIN_EXPR`/`NORM_EMAIL_EXPR` exist specifically to correct rows imported under older, buggy parser versions (Cases A–D, see that file's docstring). Rows being matched in-process here are being inserted right now by the current parser, so they're never in a corrupted shape — the in-process path can use `cred.domain`/`cred.email` directly.

**Tech Stack:** TypeScript, Vitest, ClickHouse, SQLite. Depends on `lib/domain-match.ts` from `docs/superpowers/plans/2026-08-21-monitor-match-correctness.md` — that plan must land first.

## Global Constraints

- `streamCredentialsToTable` (`lib/upload-processor.ts`) is documented as "free of source-recording and monitor side effects" so the ingest benchmark can drive it against a throwaway table. The new hook into it must stay strictly opt-in (an optional callback nothing calls unless a caller passes it) so that property holds for callers that don't pass it.
- Matching only ever considers credentials that were actually inserted (mirrors today's behavior, where matches only ever came from rows already in ClickHouse) — the new callback fires after `insertBatch` succeeds, not before.
- No change to dedup-fingerprinting, webhook delivery, alert-logging, or `monitor_credential_seen`/`monitor_alerts` semantics — this plan changes how matches are *discovered* during upload, not what happens once one is found.
- `getMonitor`, `listMonitors`, `createMonitor`, `updateMonitor`, `deleteMonitor`, `createWebhook`, etc. in `lib/domain-monitor.ts` are unrelated CRUD used by the `/monitoring` API routes — do not touch them.

---

## Task 1: Reverse-index domain matching in `lib/domain-match.ts`

**Files:**
- Modify: `lib/domain-match.ts` (adds to the module from the prerequisite plan)
- Modify: `__tests__/domain-match.test.ts` (adds to the test file from the prerequisite plan)

**Interfaces:**
- Consumes: `MatchMode`, `domainMatches` (already in the module).
- Produces: `domainSuffixChain(domain: string): string[]`, `MonitorDomainIndexEntry { monitorId: number; mode: MatchMode }`, `buildMonitorDomainIndex(monitors: Array<{ id: number; domains: string[]; match_mode: MatchMode }>): Map<string, MonitorDomainIndexEntry[]>`, `MatchedCredential { monitorId: number; url: string; email: string; password: string; domain: string }`, `matchCredentialsAgainstIndex(creds: Array<{ url: string; email: string; password: string; domain: string }>, index: Map<string, MonitorDomainIndexEntry[]>): MatchedCredential[]`. Tasks 2–3 of this plan import `MatchedCredential`, `buildMonitorDomainIndex`, and `matchCredentialsAgainstIndex`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/domain-match.test.ts` (add these new imports to the existing `import { ... } from '@/lib/domain-match'` line, then add the new `describe` blocks below the existing ones):

```typescript
import { domainSuffixChain, buildMonitorDomainIndex, matchCredentialsAgainstIndex } from '@/lib/domain-match'

describe('domainSuffixChain', () => {
  test('returns every dot-boundary suffix, longest first', () => {
    expect(domainSuffixChain('stake.lido.fi')).toEqual(['stake.lido.fi', 'lido.fi', 'fi'])
  })

  test('returns a single-element chain for a bare label', () => {
    expect(domainSuffixChain('localhost')).toEqual(['localhost'])
  })

  test('returns an empty chain for an empty string', () => {
    expect(domainSuffixChain('')).toEqual([])
  })
})

describe('buildMonitorDomainIndex + matchCredentialsAgainstIndex', () => {
  const monitors = [
    { id: 1, domains: ['aave.com'], match_mode: 'both' as const },
    { id: 2, domains: ['lido.fi'], match_mode: 'url' as const },
    { id: 3, domains: ['example.com'], match_mode: 'credential' as const },
  ]
  const index = buildMonitorDomainIndex(monitors)

  test('matches a subdomain via URL domain (mode both)', () => {
    const cred = { url: 'https://app.aave.com/login', email: 'user@other.org', password: 'x', domain: 'app.aave.com' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches.map(m => m.monitorId)).toEqual([1])
  })

  test('does not match a mode "url" monitor via email domain', () => {
    const cred = { url: 'https://other.org', email: 'user@stake.lido.fi', password: 'x', domain: 'other.org' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches).toEqual([])
  })

  test('matches a mode "credential" monitor via email subdomain, not URL', () => {
    const cred = { url: 'https://other.org', email: 'user@mail.example.com', password: 'x', domain: 'other.org' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches.map(m => m.monitorId)).toEqual([3])
  })

  test('a credential matching two monitors produces two entries, each once', () => {
    const cred = { url: 'https://app.aave.com', email: 'user@mail.example.com', password: 'x', domain: 'app.aave.com' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches.map(m => m.monitorId).sort()).toEqual([1, 3])
  })

  test('returns no matches when the index is empty', () => {
    const cred = { url: 'https://aave.com', email: 'user@aave.com', password: 'x', domain: 'aave.com' }
    expect(matchCredentialsAgainstIndex([cred], new Map())).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: FAIL — `domainSuffixChain`, `buildMonitorDomainIndex`, `matchCredentialsAgainstIndex` don't exist yet.

- [ ] **Step 3: Implement the additions in `lib/domain-match.ts`**

Append to `lib/domain-match.ts`:

```typescript
/** Every dot-boundary suffix of a domain, longest first: "a.b.c" -> ["a.b.c", "b.c", "c"]. */
export function domainSuffixChain(domain: string): string[] {
  const d = domain.toLowerCase().trim()
  if (!d) return []
  const labels = d.split('.')
  const chain: string[] = []
  for (let i = 0; i < labels.length; i++) {
    chain.push(labels.slice(i).join('.'))
  }
  return chain
}

export interface MonitorDomainIndexEntry {
  monitorId: number
  mode: MatchMode
}

/** Build a reverse index: monitored domain -> monitors watching it. One entry per (monitor, domain) pair. */
export function buildMonitorDomainIndex(
  monitors: Array<{ id: number; domains: string[]; match_mode: MatchMode }>,
): Map<string, MonitorDomainIndexEntry[]> {
  const index = new Map<string, MonitorDomainIndexEntry[]>()
  for (const monitor of monitors) {
    for (const domain of monitor.domains) {
      const key = domain.toLowerCase().trim()
      if (!key) continue
      const entry: MonitorDomainIndexEntry = { monitorId: monitor.id, mode: monitor.match_mode }
      const list = index.get(key)
      if (list) list.push(entry)
      else index.set(key, [entry])
    }
  }
  return index
}

export interface MatchedCredential {
  monitorId: number
  url: string
  email: string
  password: string
  domain: string
}

/**
 * Reverse-search match: for each credential, walk its domain's (and email
 * domain's) suffix chain against the index instead of scanning every
 * monitored domain — O(label count) per credential instead of O(monitored
 * domains). Equivalent to calling credentialMatchesDomain(cred, d, mode) for
 * every monitored domain d, just computed the other way around.
 */
export function matchCredentialsAgainstIndex(
  creds: Array<{ url: string; email: string; password: string; domain: string }>,
  index: Map<string, MonitorDomainIndexEntry[]>,
): MatchedCredential[] {
  if (index.size === 0) return []
  const matches: MatchedCredential[] = []

  for (const cred of creds) {
    const matchedMonitors = new Set<number>()

    for (const suffix of domainSuffixChain(cred.domain)) {
      const entries = index.get(suffix)
      if (!entries) continue
      for (const entry of entries) {
        if (entry.mode === 'url' || entry.mode === 'both') matchedMonitors.add(entry.monitorId)
      }
    }

    const at = cred.email.lastIndexOf('@')
    if (at !== -1) {
      for (const suffix of domainSuffixChain(cred.email.slice(at + 1))) {
        const entries = index.get(suffix)
        if (!entries) continue
        for (const entry of entries) {
          if (entry.mode === 'credential' || entry.mode === 'both') matchedMonitors.add(entry.monitorId)
        }
      }
    }

    for (const monitorId of matchedMonitors) {
      matches.push({ monitorId, url: cred.url, email: cred.email, password: cred.password, domain: cred.domain })
    }
  }

  return matches
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: PASS (21 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/domain-match.ts __tests__/domain-match.test.ts
git commit -m "feat(monitoring): add reverse-index domain matching for in-process use"
```

---

## Task 2: Replace `checkMonitorsForULPUpload` with `fireMonitorAlertsFromMatches`

**Files:**
- Modify: `lib/domain-monitor.ts` — delete `checkMonitorsForULPUpload` and its `matchConditionSQL` helper (added by the prerequisite plan), add `fireMonitorAlertsFromMatches`
- Modify: `__tests__/domain-monitor.test.ts` — full rewrite (the tests this replaces covered the function being deleted)

**Interfaces:**
- Consumes: `MatchedCredential` from `lib/domain-match.ts` (Task 1).
- Produces: `fireMonitorAlertsFromMatches(sourceFile: string, matches: MatchedCredential[], monitorsById: Map<number, DomainMonitor>, logFn?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void): Promise<void>`. Task 3 of this plan calls this from `lib/upload-processor.ts`.

`checkMonitorsForULPUpload` queried ClickHouse fresh for each monitor domain, scoped to the file that was just uploaded — exactly the query Task 3 replaces with in-process matching. Once that call site changes, the function has no remaining callers (confirmed by grep — its only production call site is `lib/upload-processor.ts:411`, everything else referencing it is either this function's own definition or test mocks, both updated in this plan). Deleting it removes a duplicate of the query logic the prerequisite plan just fixed there — that fix was still necessary (it was live in production between the two plans landing, and `lib/monitor-rescan-cron.ts` has its own independent implementation that still needs it), but this task makes the ClickHouse-query version redundant for uploads.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `__tests__/domain-monitor.test.ts` with:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: FAIL — `fireMonitorAlertsFromMatches` doesn't exist yet.

- [ ] **Step 3: Modify `lib/domain-monitor.ts`**

Replace the import block at the top of the file:

```typescript
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, type MatchMode } from '@/lib/domain-match'
import crypto from 'crypto'
```

with:

```typescript
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { attemptDelivery, enqueueFailedDelivery } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, type MatchedCredential } from '@/lib/domain-match'
import crypto from 'crypto'
```

(`executeQuery`/`NORM_DOMAIN_EXPR`/`NORM_EMAIL_EXPR`/`MatchMode` were only used inside `checkMonitorsForULPUpload` and its `matchConditionSQL` helper, both deleted below.)

Delete the `matchConditionSQL` helper function, the `// ─── ULP monitoring ───` section comment, and the `checkMonitorsForULPUpload` function — the prerequisite plan placed `matchConditionSQL` immediately *before* that section comment, so this deletion spans from that helper's `function matchConditionSQL(mode: MatchMode): string {` line through the end of `checkMonitorsForULPUpload` (the blank line before `// ─── Webhook test ───`). The replacement below includes a fresh copy of the section comment.

In its place, add:

```typescript
// ─── ULP monitoring ───────────────────────────────────────────────────────────

/**
 * Fire webhook alerts for credentials matched in-process during an upload
 * (see lib/upload-processor.ts, lib/domain-match.ts's matchCredentialsAgainstIndex).
 * Groups matches by monitor, applies the same dedup-fingerprint/webhook/alert-log
 * flow checkMonitorsForULPUpload used to run per ClickHouse-queried domain.
 */
export async function fireMonitorAlertsFromMatches(
  sourceFile: string,
  matches: MatchedCredential[],
  monitorsById: Map<number, DomainMonitor>,
  logFn?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void,
): Promise<void> {
  const log = logFn || (() => {})
  if (matches.length === 0) return

  const byMonitor = new Map<number, MatchedCredential[]>()
  for (const m of matches) {
    const list = byMonitor.get(m.monitorId)
    if (list) list.push(m)
    else byMonitor.set(m.monitorId, [m])
  }

  for (const [monitorId, monitorMatches] of byMonitor) {
    const monitor = monitorsById.get(monitorId)
    if (!monitor) continue
    try {
      const unseenRows = monitorMatches.filter(row => {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        return !dbGet(
          `SELECT 1 FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint = ?`,
          [monitorId, fp]
        )
      })

      if (unseenRows.length === 0) {
        log(`Monitor "${monitor.name}": all ${monitorMatches.length} matched credential(s) already alerted — skipping`, 'info')
        continue
      }

      log(`Monitor "${monitor.name}" matched ${unseenRows.length} new credential(s) (${monitorMatches.length - unseenRows.length} already seen)`, 'success')

      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorId]
      ) as Record<string, unknown>[]

      if (webhookRows.length === 0) continue

      const payload = {
        monitor_name: monitor.name,
        source_file: sourceFile,
        matched_domains: monitor.domains,
        matches: unseenRows.slice(0, 50),
        total_matches: unseenRows.length,
      }
      const payloadJson = JSON.stringify(payload)
      const matchedDomain = monitor.domains.join(',')
      const matchType = matchModeToMatchType(monitor.match_mode)

      // Sequential delivery is intentional: inline attempt + outbox enqueue must not race.
      for (const wr of webhookRows) {
        const webhook = parseWebhookRow(wr)
        const result = await attemptDelivery(webhook, payloadJson)
        dbRun(
          `INSERT INTO monitor_alerts
             (monitor_id, webhook_id, source_file, matched_domain, match_type,
              credential_match_count, payload_sent, status, http_status, retry_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [monitorId, webhook.id, sourceFile, matchedDomain, matchType,
           unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
        )
        dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [webhook.id])
        if (!result.ok) {
          if (result.status !== null && result.status >= 400 && result.status < 500) {
            // 4xx — permanent client error, don't retry
            log(`Webhook delivery permanently failed (4xx, not queued): ${result.error}`, 'warning')
          } else {
            // Network error or 5xx — queue for retry
            enqueueFailedDelivery(monitorId, webhook.id, payloadJson, sourceFile, matchedDomain, unseenRows.length)
            log(`Webhook delivery failed (queued for retry): ${result.error}`, 'warning')
          }
        }
      }

      // Record fingerprints so future uploads of the same credentials don't re-alert
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          `INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)`,
          [monitorId, fp]
        )
      }

      dbRun(
        `UPDATE domain_monitors SET last_triggered_at = datetime('now'), total_alerts = total_alerts + ? WHERE id = ?`,
        [webhookRows.length, monitorId]
      )
    } catch (err) {
      log(`Error processing monitor alerts for monitor ${monitorId}: ${err}`, 'error')
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Confirm no other code still references the deleted function**

Run: `rg -n "checkMonitorsForULPUpload" --glob '!node_modules' --glob '!.claude/worktrees' --glob '!docs/superpowers/plans'`
Expected: no matches outside this plan's own text and `docs/superpowers/plans/2026-08-21-monitor-match-correctness.md` (Task 3 of this plan updates the two remaining live references, in `lib/upload-processor.ts` and its tests).

- [ ] **Step 6: Commit**

```bash
git add lib/domain-monitor.ts __tests__/domain-monitor.test.ts
git commit -m "refactor(monitoring): replace checkMonitorsForULPUpload with fireMonitorAlertsFromMatches"
```

---

## Task 3: Wire in-process matching into the upload pipeline

**Files:**
- Modify: `lib/upload-processor.ts`
- Modify: `__tests__/upload-processor.test.ts`
- Modify: `__tests__/upload-skip-imported.test.ts`

**Interfaces:**
- Consumes: `getActiveMonitors` (existing export) and `fireMonitorAlertsFromMatches` (Task 2) from `lib/domain-monitor.ts`; `buildMonitorDomainIndex`, `matchCredentialsAgainstIndex`, `MatchedCredential` (Task 1) from `lib/domain-match.ts`.
- Produces: `StreamToTableOptions.onBatchCredentials?: (creds: ULPCredential[]) => void` — a new optional field. No change to any other exported signature in this file.

- [ ] **Step 1: Update the two existing test files' mocks (they reference the function Task 2 deleted)**

In `__tests__/upload-processor.test.ts`, replace:

```typescript
vi.mock('@/lib/domain-monitor', () => ({
  checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined),
}))
```

with:

```typescript
vi.mock('@/lib/domain-monitor', () => ({
  getActiveMonitors: vi.fn().mockResolvedValue([]),
  fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
}))
```

In `__tests__/upload-skip-imported.test.ts`, replace:

```typescript
vi.mock('@/lib/domain-monitor', () => ({ checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined) }))
```

with:

```typescript
vi.mock('@/lib/domain-monitor', () => ({
  getActiveMonitors: vi.fn().mockResolvedValue([]),
  fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
}))
```

- [ ] **Step 2: Write the new failing test for the in-process wiring**

Append to `__tests__/upload-processor.test.ts`:

```typescript
describe('domain-monitor wiring — in-process matching', () => {
  it('accumulates matched credentials in-process and fires alerts once per file', async () => {
    vi.resetModules()
    const dm = {
      getActiveMonitors: vi.fn().mockResolvedValue([
        { id: 1, name: 'Test', domains: ['example.com'], match_mode: 'both', is_active: true,
          created_by: null, last_triggered_at: null, total_alerts: 0,
          rescan_mode: 'dedup', rescan_interval_hours: 24, created_at: '', updated_at: '' },
      ]),
      fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
    }
    vi.doMock('@/lib/domain-monitor', () => dm)

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      await processTextStream(
        Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
        'monitor-wiring.txt',
      )

      expect(dm.getActiveMonitors).toHaveBeenCalledOnce()
      expect(dm.fireMonitorAlertsFromMatches).toHaveBeenCalledOnce()
      const [sourceFile, matches, monitorsById] = dm.fireMonitorAlertsFromMatches.mock.calls[0]
      expect(sourceFile).toBe('monitor-wiring.txt')
      expect(matches).toEqual([
        expect.objectContaining({ monitorId: 1, email: 'user@example.com', domain: 'example.com' }),
      ])
      expect(monitorsById.get(1)).toMatchObject({ id: 1, domains: ['example.com'] })
    } finally {
      vi.doUnmock('@/lib/domain-monitor')
      vi.resetModules()
    }
  })

  it('does not call fireMonitorAlertsFromMatches when there are no active monitors', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    await processTextStream(
      Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
      'no-monitors.txt',
    )
    // Uses this file's static top-level mock: getActiveMonitors resolves to [].
    const { fireMonitorAlertsFromMatches } = await import('@/lib/domain-monitor')
    expect(vi.mocked(fireMonitorAlertsFromMatches)).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts`
Expected: FAIL, for two combined reasons that Step 4 fixes together:
1. The two new tests just added fail because `lib/upload-processor.ts` doesn't call `getActiveMonitors`/`fireMonitorAlertsFromMatches` yet.
2. Every other test in both files errors, because `lib/upload-processor.ts` still imports `checkMonitorsForULPUpload` from `@/lib/domain-monitor` — a function Task 2 deleted from the real module and Step 1 just removed from these files' mocks too. `processTextStream`'s `imported > 0` branch calls it unconditionally, so any test exercising that branch throws `checkMonitorsForULPUpload is not a function`.

- [ ] **Step 4: Modify `lib/upload-processor.ts`**

Replace the import block (currently lines 12-30):

```typescript
import {
  parseULPStream,
  makeRejectionMap,
  type ULPCredential,
  type RejectionReason,
} from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import {
  privacySafeClickHouseErrorSummary,
  withClickHouseRetry,
  type ClickHouseRetryOptions,
} from '@/lib/clickhouse-retry'
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { batchDedupToken } from '@/lib/upload-dedup'
import { parseIngestPolicy, policyActive, shouldDropAtIngest, makeHardDropPredicate } from '@/lib/ingest-filter'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'
import { startIngest, recordBatch, finishIngest } from '@/lib/ingest-metrics'
```

with:

```typescript
import {
  parseULPStream,
  makeRejectionMap,
  type ULPCredential,
  type RejectionReason,
} from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import {
  privacySafeClickHouseErrorSummary,
  withClickHouseRetry,
  type ClickHouseRetryOptions,
} from '@/lib/clickhouse-retry'
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { batchDedupToken } from '@/lib/upload-dedup'
import { parseIngestPolicy, policyActive, shouldDropAtIngest, makeHardDropPredicate } from '@/lib/ingest-filter'
import { getActiveMonitors, fireMonitorAlertsFromMatches, type DomainMonitor } from '@/lib/domain-monitor'
import { buildMonitorDomainIndex, matchCredentialsAgainstIndex, type MatchedCredential } from '@/lib/domain-match'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'
import { startIngest, recordBatch, finishIngest } from '@/lib/ingest-metrics'
```

Add `onBatchCredentials` to `StreamToTableOptions` (currently lines 223-244), as the last field:

```typescript
  /** Per-batch live metrics (ingest-health panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
}
```

to:

```typescript
  /** Per-batch live metrics (ingest-health panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
  /** Called with each batch's actually-inserted credentials, right after insertBatch succeeds. Not passed by the benchmark — keeps that path free of monitor side effects. */
  onBatchCredentials?: (creds: ULPCredential[]) => void
}
```

In `streamCredentialsToTable`, call the new callback right after the insert succeeds (currently lines 311-317):

```typescript
      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
      if (timings) timings.insertMs += batchInsertMs

      imported += creds.length
```

to:

```typescript
      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
      if (timings) timings.insertMs += batchInsertMs
      options.onBatchCredentials?.(creds)

      imported += creds.length
```

In `processTextStream`, replace the whole block from `let imported = 0` through the end of the function (currently lines 366-419):

```typescript
  let imported             = 0
  let skipped              = 0
  let tierDropped          = 0
  const rejection_breakdown = makeRejectionMap()

  // Ingest tier filter — hard tiers drop in the parser (earliest); the rest
  // (noise/soft-tier/suffix) stays in the post-batch filter so kept rows are
  // never re-classified.
  const policy         = parseIngestPolicy()
  const shouldHardDrop = makeHardDropPredicate(policy)
  const softPolicy     = { ...policy, hardTiers: new Set<string>() }
  const filterOn       = policyActive(softPolicy)

  startIngest(filename)
  let result
  try {
    result = await streamCredentialsToTable(stream, filename, {
      table:      'ulp.credentials',
      batchSize:  UPLOAD_BATCH_SIZE,
      pipeline:   importPipelineEnabled(),
      filterOn,
      dropPolicy: softPolicy,
      breachName: breach_name,
      shouldHardDrop,
      onProgress: (imp, skp) => {
        if (jobId)   updateJob(jobId, { imported: imp, skipped: skp })
        if (onBatch) onBatch(imp)
      },
      onBatchMetrics: recordBatch,
    })
  } finally {
    finishIngest()
  }

  imported    = result.imported
  skipped     = result.skipped
  tierDropped = result.tierDropped
  Object.assign(rejection_breakdown, result.rejection_breakdown)

  if (filterOn && tierDropped > 0) {
    console.log(`[ingest-filter] ${filename}: dropped ${tierDropped} low-tier rows pre-insert`)
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
    // Cross-file content dedup remains available through the scheduled/manual
    // dedup flows; imports no longer trigger a full-table dedup hook here.
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
}
```

with:

```typescript
  let imported             = 0
  let skipped              = 0
  let tierDropped          = 0
  const rejection_breakdown = makeRejectionMap()

  // Ingest tier filter — hard tiers drop in the parser (earliest); the rest
  // (noise/soft-tier/suffix) stays in the post-batch filter so kept rows are
  // never re-classified.
  const policy         = parseIngestPolicy()
  const shouldHardDrop = makeHardDropPredicate(policy)
  const softPolicy     = { ...policy, hardTiers: new Set<string>() }
  const filterOn       = policyActive(softPolicy)

  // Load active monitors once up front and match in-process as batches insert,
  // instead of re-querying ClickHouse per monitor domain after the fact. One
  // extra SQLite SELECT per upload attempt (even one that turns out to import
  // nothing) — negligible next to the cost this replaces.
  const monitors      = await getActiveMonitors()
  const monitorsById  = new Map<number, DomainMonitor>(monitors.map(m => [m.id, m]))
  const monitorIndex  = buildMonitorDomainIndex(monitors)
  const monitorMatches: MatchedCredential[] = []

  startIngest(filename)
  let result
  try {
    result = await streamCredentialsToTable(stream, filename, {
      table:      'ulp.credentials',
      batchSize:  UPLOAD_BATCH_SIZE,
      pipeline:   importPipelineEnabled(),
      filterOn,
      dropPolicy: softPolicy,
      breachName: breach_name,
      shouldHardDrop,
      onProgress: (imp, skp) => {
        if (jobId)   updateJob(jobId, { imported: imp, skipped: skp })
        if (onBatch) onBatch(imp)
      },
      onBatchMetrics: recordBatch,
      onBatchCredentials: monitorIndex.size > 0
        ? creds => { monitorMatches.push(...matchCredentialsAgainstIndex(creds, monitorIndex)) }
        : undefined,
    })
  } finally {
    finishIngest()
  }

  imported    = result.imported
  skipped     = result.skipped
  tierDropped = result.tierDropped
  Object.assign(rejection_breakdown, result.rejection_breakdown)

  if (filterOn && tierDropped > 0) {
    console.log(`[ingest-filter] ${filename}: dropped ${tierDropped} low-tier rows pre-insert`)
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    if (monitorMatches.length > 0) {
      fireMonitorAlertsFromMatches(filename, monitorMatches, monitorsById).catch(err =>
        console.error('Domain monitor alert error:', err)
      )
    }
    // Cross-file content dedup remains available through the scheduled/manual
    // dedup flows; imports no longer trigger a full-table dedup hook here.
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts`
Expected: PASS (all tests in both files, including the two new ones from Step 3)

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/upload-processor.ts __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts
git commit -m "perf(monitoring): match upload credentials in-process instead of per-domain ClickHouse queries"
```
