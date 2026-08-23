# Monitor Live Match Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open any domain monitor on `/monitoring` and see the actual credential rows currently matching its domains, queried live against ClickHouse — no webhook required.

**Architecture:** Extract the existing single-domain SQL WHERE-clause builder (`matchConditionSQL`, currently private to `lib/monitor-rescan-cron.ts`) into the shared `lib/domain-match.ts` module, and add a multi-domain variant that ORs a monitor's whole domain set into one bounded ClickHouse query. Expose it through a new read-only API endpoint, and surface it as a "View Matches" action + results table on the existing `/monitoring` page.

**Tech Stack:** Next.js 14 API routes, ClickHouse (`@clickhouse/client` via `lib/clickhouse.ts`), Vitest.

## Global Constraints

- `matchConditionSQL(mode)` must keep producing byte-identical SQL for its existing caller in `lib/monitor-rescan-cron.ts` — same exported name, same signature, same output.
- The new endpoint queries ClickHouse directly and must NOT read from or write to `monitor_alerts` / `monitor_credential_seen` — that bookkeeping is out of scope for this plan (see the follow-up `2026-08-23-monitor-unread-tracking.md` plan).
- The new query must NOT include an `ORDER BY`. Ordering the filtered set before `LIMIT` defeats ClickHouse's ability to short-circuit the scan and forces sorting the full matched set first — this is the same class of bug documented in `app/api/credentials/route.ts`'s `SORT_MAX_MEMORY_BYTES` comment (a real 2026-07-04 `MEMORY_LIMIT_EXCEEDED` production incident against this same 91M-row table). Bounded, unordered `LIMIT` snapshot only.
- No schema changes in this plan.
- Passwords render in plaintext in the new table, consistent with `/credentials` — no masking/reveal toggle.
- The new endpoint requires authentication only (`validateRequest`), not admin — mirrors the existing `GET /api/monitoring/monitors/[id]`.

---

### Task 1: Multi-domain SQL WHERE-clause builder in lib/domain-match.ts

**Files:**
- Modify: `lib/domain-match.ts`
- Modify: `lib/monitor-rescan-cron.ts`
- Test: `__tests__/domain-match.test.ts`

**Interfaces:**
- Produces: `matchConditionSQL(mode: MatchMode): string` (moved here, same behavior as today). `buildDomainSetWhereClause(domains: string[], mode: MatchMode): { clause: string; params: Record<string, string> }` (new) — Task 2 imports this.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

Add to the top of `__tests__/domain-match.test.ts` (it currently has no `vi.mock` — add one, mirroring the same mock shape `__tests__/monitor-rescan-cron.test.ts` already uses, so the SQL assertions below stay readable instead of matching the real multi-line corrupted-row expressions):

```typescript
import { vi, describe, test, expect } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
  NORM_EMAIL_EXPR: 'email',
}))

import {
  domainMatches, emailDomainMatches, credentialMatchesDomain, matchModeToMatchType,
  domainSuffixChain, buildMonitorDomainIndex, matchCredentialsAgainstIndex,
  matchConditionSQL, buildDomainSetWhereClause,
} from '@/lib/domain-match'
```

This replaces the file's current top two lines (`import { describe, test, expect } from 'vitest'` and the `@/lib/domain-match` import). Leave every existing `describe`/`test` block below untouched.

Then append this new block at the end of the file:

```typescript
describe('matchConditionSQL', () => {
  test('mode "url" is just the domain condition', () => {
    expect(matchConditionSQL('url')).toBe(
      '((domain) = {domain:String} OR endsWith((domain), {domainSuffix:String}))'
    )
  })

  test('mode "credential" guards against missing "@" and uses the last "@"', () => {
    const sql = matchConditionSQL('credential')
    expect(sql).toContain("position(lower(email), '@') > 0 AND")
    expect(sql).toContain("arrayElement(splitByChar('@', lower(email)), -1)")
  })

  test('mode "both" ORs the url and credential conditions', () => {
    const sql = matchConditionSQL('both')
    expect(sql.startsWith('(((domain)')).toBe(true)
    expect(sql).toContain(' OR (position(lower(email)')
  })
})

describe('buildDomainSetWhereClause', () => {
  test('builds one OR-joined clause with indexed params per domain', () => {
    const { clause, params } = buildDomainSetWhereClause(['aave.com', 'lido.fi'], 'url')
    expect(clause).toBe(
      '(((domain) = {domain0:String} OR endsWith((domain), {domainSuffix0:String})) OR ' +
      '((domain) = {domain1:String} OR endsWith((domain), {domainSuffix1:String})))'
    )
    expect(params).toEqual({
      domain0: 'aave.com', domainSuffix0: '.aave.com',
      domain1: 'lido.fi',  domainSuffix1: '.lido.fi',
    })
  })

  test('lowercases and trims each domain', () => {
    const { params } = buildDomainSetWhereClause([' AAVE.com '], 'url')
    expect(params.domain0).toBe('aave.com')
    expect(params.domainSuffix0).toBe('.aave.com')
  })

  test('returns a never-true clause for an empty domain list', () => {
    const { clause, params } = buildDomainSetWhereClause([], 'both')
    expect(clause).toBe('0')
    expect(params).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: FAIL — `matchConditionSQL` and `buildDomainSetWhereClause` are not exported from `lib/domain-match.ts` yet.

- [ ] **Step 3: Add the SQL builders to lib/domain-match.ts**

Replace the file's header docstring (the `/** ... */` block at the top) with:

```typescript
/**
 * Domain-matching predicates and SQL builders shared by the upload-triggered
 * monitor check, the scheduled rescan, and the live monitor-matches endpoint
 * (lib/domain-monitor.ts, lib/monitor-rescan-cron.ts,
 * app/api/monitoring/monitors/[id]/matches/route.ts).
 *
 * "Matches" means: the candidate is the monitored domain itself, or any
 * subdomain of it (label-boundary suffix match — "aave.com" matches
 * "app.aave.com" but not "notaave.com").
 *
 * domainMatches/emailDomainMatches/credentialMatchesDomain/matchCredentialsAgainstIndex
 * are pure, zero-dependency JS predicates for in-process matching.
 * matchConditionSQL/buildDomainSetWhereClause build the equivalent condition
 * as ClickHouse SQL — same semantics, different execution engine — and do
 * depend on lib/ulp-normalize's column expressions.
 */

import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
```

Then append this at the end of the file (after `matchCredentialsAgainstIndex`):

```typescript

// ─── ClickHouse SQL condition builders ─────────────────────────────────────

/**
 * Build the subdomain-aware WHERE fragment for one domain, using the given
 * ClickHouse named-parameter names for its {domain}/{domainSuffix} values.
 * Shared building block for matchConditionSQL (one domain, fixed param
 * names) and buildDomainSetWhereClause (many domains, indexed param names).
 */
function domainConditionSQL(mode: MatchMode, domainParam: string, domainSuffixParam: string): string {
  const urlCond = `((${NORM_DOMAIN_EXPR}) = {${domainParam}:String} OR endsWith((${NORM_DOMAIN_EXPR}), {${domainSuffixParam}:String}))`
  const emailLower = `lower(${NORM_EMAIL_EXPR})`
  // Domain after the LAST '@'. The position(...) > 0 guard is required:
  // ClickHouse's position() returns 0 (not -1) when '@' is absent, which
  // without the guard would make the extraction equal the WHOLE email
  // string — false-matching any row whose raw email column happens to
  // equal or end with a monitored domain (common on corrupted rows with no
  // '@' at all; see lib/ulp-normalize.ts's docstring on Cases A-D).
  const emailDomainExpr = `arrayElement(splitByChar('@', ${emailLower}), -1)`
  const emailCond = `(position(${emailLower}, '@') > 0 AND ((${emailDomainExpr}) = {${domainParam}:String} OR endsWith((${emailDomainExpr}), {${domainSuffixParam}:String})))`
  if (mode === 'url') return urlCond
  if (mode === 'credential') return emailCond
  return `(${urlCond} OR ${emailCond})`
}

/**
 * Build the subdomain-aware WHERE fragment for a monitor's match_mode
 * against a single domain, bound via ClickHouse named parameters {domain}
 * and {domainSuffix}. Moved here from lib/monitor-rescan-cron.ts so the
 * live-matches endpoint and the scheduled rescan share one implementation
 * instead of two.
 */
export function matchConditionSQL(mode: MatchMode): string {
  return domainConditionSQL(mode, 'domain', 'domainSuffix')
}

/**
 * Build a single WHERE fragment matching ANY of the given domains, each
 * bound to its own indexed ClickHouse named parameters (domain0/domainSuffix0,
 * domain1/domainSuffix1, ...) so a monitor's whole domain set can be queried
 * in one ClickHouse round trip instead of one query per domain.
 */
export function buildDomainSetWhereClause(
  domains: string[],
  mode: MatchMode,
): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const parts = domains.map((domain, i) => {
    const d = domain.toLowerCase().trim()
    const domainParam = `domain${i}`
    const domainSuffixParam = `domainSuffix${i}`
    params[domainParam] = d
    params[domainSuffixParam] = `.${d}`
    return domainConditionSQL(mode, domainParam, domainSuffixParam)
  })
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: PASS, all tests including the new ones.

- [ ] **Step 5: Point monitor-rescan-cron.ts at the shared builder**

In `lib/monitor-rescan-cron.ts`, replace the import block:

```typescript
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, type MatchMode } from '@/lib/domain-match'
import crypto from 'crypto'
```

with:

```typescript
import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, matchConditionSQL, type MatchMode } from '@/lib/domain-match'
import crypto from 'crypto'
```

(`NORM_EMAIL_EXPR` is dropped — after this step it's only used inside the function being deleted next. `NORM_DOMAIN_EXPR` stays: it's still used directly in the `runTick` SELECT.)

Then delete the local builder — remove this whole block (the `// ─── Matching ───...` section, right after the `startMonitorRescanCron`/fingerprinting section and before `// ─── Tick ───`):

```typescript
// ─── Matching ───────────────────────────────────────────────────────────────

/** Build the subdomain-aware WHERE fragment for a monitor's match_mode. Params: {domain}, {domainSuffix}. */
function matchConditionSQL(mode: MatchMode): string {
  const urlCond = `((${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith((${NORM_DOMAIN_EXPR}), {domainSuffix:String}))`
  const emailLower = `lower(${NORM_EMAIL_EXPR})`
  // Domain after the LAST '@', mirroring lib/domain-match.ts's emailDomainMatches
  // (lastIndexOf('@')). The position(...) > 0 guard is required: ClickHouse's
  // position() returns 0 (not -1) when '@' is absent, which without the guard
  // would make the old substring(email, 0+1) expression equal the WHOLE email
  // string — false-matching any row whose raw email column happens to equal or
  // end with a monitored domain (common on corrupted rows with no '@' at all;
  // see lib/ulp-normalize.ts's docstring on Cases A-D).
  const emailDomainExpr = `arrayElement(splitByChar('@', ${emailLower}), -1)`
  const emailCond = `(position(${emailLower}, '@') > 0 AND ((${emailDomainExpr}) = {domain:String} OR endsWith((${emailDomainExpr}), {domainSuffix:String})))`
  if (mode === 'url') return urlCond
  if (mode === 'credential') return emailCond
  return `(${urlCond} OR ${emailCond})`
}

```

- [ ] **Step 6: Run the full existing rescan-cron suite to confirm no behavior change**

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts`
Expected: PASS, all existing tests unchanged — `matchConditionSQL` now runs from `lib/domain-match.ts` but produces byte-identical SQL (the test file's `vi.mock('@/lib/ulp-normalize', ...)` mocks the module for the whole test file's import graph, including transitively through `lib/domain-match.ts`, so no test changes are needed here).

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add lib/domain-match.ts lib/monitor-rescan-cron.ts __tests__/domain-match.test.ts
git commit -m "refactor(domain-monitor): extract shared multi-domain SQL WHERE builder"
```

---

### Task 2: Live matches API endpoint

**Files:**
- Create: `app/api/monitoring/monitors/[id]/matches/route.ts`
- Test: `__tests__/monitor-matches-route.test.ts`

**Interfaces:**
- Consumes: `buildDomainSetWhereClause(domains, mode)` from Task 1. `getMonitor(id)` from `lib/domain-monitor.ts` (existing — returns `DomainMonitor | null` with `.domains: string[]` and `.match_mode: MatchMode`). `executeQuery(sql, params)` from `lib/clickhouse.ts` (existing). `validateRequest(request)` from `lib/auth.ts` (existing).
- Produces: `GET /api/monitoring/monitors/[id]/matches` → `{ success: true, results: {url,email,password,domain}[], total_shown: number, limited: boolean }`. Task 3 consumes this shape (adding `is_new`/`new_count` fields to it in the follow-up plan — this task's response shape is a strict subset of that).

- [ ] **Step 1: Write the route**

Create `app/api/monitoring/monitors/[id]/matches/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor } from "@/lib/domain-monitor"
import { executeQuery } from "@/lib/clickhouse"
import { buildDomainSetWhereClause } from "@/lib/domain-match"
import { NORM_DOMAIN_EXPR } from "@/lib/ulp-normalize"

export const dynamic = 'force-dynamic'

// Bounded, unordered "what's currently matching" snapshot — LIMIT lets
// ClickHouse short-circuit the scan instead of evaluating all 91M+ rows.
// Deliberately has no ORDER BY: sorting the filtered set before LIMIT would
// defeat that short-circuit and force a full scan (see app/api/credentials/
// route.ts's SORT_MAX_MEMORY_BYTES comment for the production incident this
// avoids). For deep, sorted, paginated browsing of a single domain, use
// /credentials?domain=X instead — this endpoint is a bounded live snapshot
// across a monitor's whole domain set.
const MATCH_LIMIT = 100

interface MatchRow {
  url: string
  email: string
  password: string
  domain: string
}

/**
 * GET /api/monitoring/monitors/[id]/matches
 * Live saved-search: up to MATCH_LIMIT credentials currently matching this
 * monitor's domains, queried directly against ClickHouse. Independent of
 * webhooks/alerts — works even if the monitor has none configured.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const monitor = await getMonitor(monitorId)
  if (!monitor) {
    return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
  }

  if (monitor.domains.length === 0) {
    return NextResponse.json({ success: true, results: [], total_shown: 0, limited: false })
  }

  const { clause, params: domainParams } = buildDomainSetWhereClause(monitor.domains, monitor.match_mode)

  try {
    const rows = await executeQuery(
      `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
       FROM ulp.credentials
       WHERE ${clause}
       LIMIT {matchLimit:UInt32}
       SETTINGS max_execution_time = 60, timeout_overflow_mode = 'throw'`,
      { ...domainParams, matchLimit: MATCH_LIMIT }
    ) as MatchRow[]

    return NextResponse.json({
      success: true,
      results: rows,
      total_shown: rows.length,
      limited: rows.length === MATCH_LIMIT,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor matches query error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write source-assertion regression tests**

This codebase tests route handlers' critical SQL properties by reading the source text rather than invoking `NextRequest` directly (see `__tests__/credentials-route.test.ts`). Follow that convention — it's the only ClickHouse-safety property that actually needs a regression guard here.

Create `__tests__/monitor-matches-route.test.ts`:

```typescript
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('monitor matches route — bounded unordered snapshot (MEMORY_LIMIT_EXCEEDED regression)', () => {
  const source = readFileSync(new URL('../app/api/monitoring/monitors/[id]/matches/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('does not sort the filtered set before LIMIT', () => {
    expect(getFn).not.toMatch(/ORDER BY/i)
  })

  test('caps the query with a named LIMIT constant', () => {
    expect(source).toMatch(/MATCH_LIMIT\s*=\s*100/)
    expect(getFn).toContain('LIMIT {matchLimit:UInt32}')
  })

  test('sets an execution-time guard', () => {
    expect(getFn).toContain('max_execution_time = 60')
    expect(getFn).toContain(`timeout_overflow_mode = 'throw'`)
  })

  test('builds the WHERE clause from the shared multi-domain builder', () => {
    expect(source).toContain('buildDomainSetWhereClause(monitor.domains, monitor.match_mode)')
  })

  test('requires authentication but not admin', () => {
    expect(getFn).toContain('validateRequest(request)')
    expect(getFn).not.toContain('requireAdminRole')
  })
})
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run __tests__/monitor-matches-route.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "app/api/monitoring/monitors/[id]/matches/route.ts" __tests__/monitor-matches-route.test.ts
git commit -m "feat(domain-monitor): add live matches endpoint per monitor"
```

---

### Task 3: "View Matches" UI on /monitoring

**Files:**
- Modify: `app/monitoring/page.tsx`

**Interfaces:**
- Consumes: `GET /api/monitoring/monitors/[id]/matches` from Task 2, response shape `{ success: boolean, results: {url,email,password,domain}[], total_shown: number, limited: boolean, error?: string }`.
- Produces: nothing further consumed by other tasks in this plan.

- [ ] **Step 1: Add state and the fetch function**

In `app/monitoring/page.tsx`, find this existing icon import (near the top of the file):

```typescript
  Radio, Webhook, Bell, Plus, Trash2, RefreshCw, Eye,
  CheckCircle2, XCircle, AlertCircle, Globe, Send, Pencil,
```

Add `Search` to it:

```typescript
  Radio, Webhook, Bell, Plus, Trash2, RefreshCw, Eye, Search,
  CheckCircle2, XCircle, AlertCircle, Globe, Send, Pencil,
```

Find the monitors-state block:

```typescript
  // Monitors state
  const [monitors, setMonitors] = useState<DomainMonitor[]>([])
  const [monitorsLoading, setMonitorsLoading] = useState(true)
  const [showMonitorDialog, setShowMonitorDialog] = useState(false)
  const [editingMonitor, setEditingMonitor] = useState<DomainMonitor | null>(null)
```

Add matches-view state right after it:

```typescript
  // Monitors state
  const [monitors, setMonitors] = useState<DomainMonitor[]>([])
  const [monitorsLoading, setMonitorsLoading] = useState(true)
  const [showMonitorDialog, setShowMonitorDialog] = useState(false)
  const [editingMonitor, setEditingMonitor] = useState<DomainMonitor | null>(null)

  // Live matches ("saved search") state
  const [matchesMonitor, setMatchesMonitor] = useState<DomainMonitor | null>(null)
  const [matches, setMatches] = useState<{ url: string; email: string; password: string; domain: string }[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
```

Find `openCreateMonitorDialog`:

```typescript
  const openCreateMonitorDialog = () => {
```

Add the matches-fetch function right before it:

```typescript
  const openMatches = async (monitor: DomainMonitor) => {
    setMatchesMonitor(monitor)
    setMatchesLoading(true)
    setMatches([])
    setMatchesLimited(false)
    try {
      const res = await fetch(`/api/monitoring/monitors/${monitor.id}/matches`)
      const data = await res.json()
      if (data.success) {
        setMatches(data.results || [])
        setMatchesLimited(Boolean(data.limited))
      } else {
        toast({ title: "Failed to load matches", description: data.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to load matches", variant: "destructive" })
    } finally {
      setMatchesLoading(false)
    }
  }

  const openCreateMonitorDialog = () => {
```

- [ ] **Step 2: Add the button to each monitor card**

Find this block (the monitor card header):

```tsx
                      {userIsAdmin && (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={monitor.is_active}
                            onCheckedChange={() => handleToggleMonitor(monitor)}
                          />
                          <Button variant="ghost" size="icon" onClick={() => openEditMonitorDialog(monitor)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDeleteMonitor(monitor)} className="text-destructive hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
```

Replace it with (adds a "View Matches" button visible to every user, admin or not, since the endpoint is read-only and not admin-gated):

```tsx
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => openMatches(monitor)}>
                          <Search className="h-4 w-4 mr-1.5" />
                          View Matches
                        </Button>
                        {userIsAdmin && (
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={monitor.is_active}
                              onCheckedChange={() => handleToggleMonitor(monitor)}
                            />
                            <Button variant="ghost" size="icon" onClick={() => openEditMonitorDialog(monitor)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => handleDeleteMonitor(monitor)} className="text-destructive hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
```

- [ ] **Step 3: Add the matches Dialog**

Find the closing of the webhook dialog:

```tsx
      <Dialog open={showWebhookDialog} onOpenChange={setShowWebhookDialog}>
```

Search forward from there to find its matching closing `</Dialog>` (it's the second `<Dialog>` block in the file, after the monitor create/edit dialog). Immediately after that `</Dialog>` closing tag, add:

```tsx

      <Dialog open={matchesMonitor !== null} onOpenChange={open => !open && setMatchesMonitor(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Matches — {matchesMonitor?.name}</DialogTitle>
            <DialogDescription>
              Credentials currently matching this monitor&apos;s domains, queried live.
              {matchesLimited && ` Showing first ${matches.length} — more may exist.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {matchesLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : matches.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No current matches.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background border-b">
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 font-medium">URL</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Password</th>
                    <th className="px-3 py-2 font-medium">Domain</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m, i) => (
                    <tr key={i} className="border-b hover:bg-muted/40">
                      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={m.url}>{m.url}</td>
                      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs" title={m.email}>{m.email}</td>
                      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs font-medium" title={m.password}>{m.password}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs font-normal">{m.domain}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
```

Before wiring this up, confirm `Loader2` is already imported in this file (`grep -n "Loader2" app/monitoring/page.tsx`) — it is used elsewhere in this codebase's loading states (e.g. `app/credentials/page.tsx`). If the grep comes back empty, add `Loader2` to this file's `lucide-react` import line.

- [ ] **Step 4: Start the dev server and verify manually in the browser**

Run: `npm run dev`

Navigate to `/monitoring`, click "View Matches" on an existing monitor. Confirm: the dialog opens, shows a loading spinner, then either a results table or "No current matches." Confirm the button is visible for both admin and non-admin accounts (toggle by checking `userIsAdmin` logic doesn't gate this button — it's outside the `{userIsAdmin && (...)}` block per Step 2).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/monitoring/page.tsx
git commit -m "feat(domain-monitor): add View Matches panel to the monitoring page"
```
