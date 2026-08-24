# Saved Searches Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every authenticated user a read-only "Saved Searches" hub — a new sidebar tab listing active domain monitors with a live-matches view — separate from `/monitoring`'s admin-only configuration.

**Architecture:** Extract the matches dialog already shipped inside `/monitoring` into a shared hook + component, add one additive `last_viewed_at` field to the existing monitors-list endpoint, then build a new page that combines both. No new backend query logic, no new data model, no changes to `/monitoring`'s admin functionality.

**Tech Stack:** Next.js 14 (App Router), React, TypeScript, better-sqlite3, Vitest (node environment — no jsdom/React Testing Library available in this project).

## Global Constraints

- The extracted `hooks/useMonitorMatches.ts` / `components/monitor-matches-dialog.tsx` must preserve `/monitoring`'s existing matches behavior exactly — same endpoint (`GET /api/monitoring/monitors/[id]/matches`), same request-sequencing guard, same error copy, same render branches. This is a pure lift-and-shift, not a rewrite.
- `GET /api/monitoring/monitors`'s new `last_viewed_at` field is additive only. Its existing consumers (`/monitoring`'s `fetchMonitors`) must keep working unmodified.
- The new `/saved-searches` page is read-only: no monitor create/edit/delete, no webhook management. Those stay exclusively in `/monitoring`.
- `/saved-searches` and its sidebar entry are **not** admin-gated — same auth-only visibility as `/monitoring`'s existing "View Matches" button.
- Rendering the saved-searches list must never trigger a ClickHouse query. Only opening an individual search (existing `openMatches` behavior) does.
- SQLite's `datetime('now')` produces UTC strings with no timezone marker (`YYYY-MM-DD HH:MM:SS`). Any code parsing these into a JS `Date` must treat them as UTC explicitly — without an appended `Z`, `new Date(...)` parses the space-separated form as local time, silently corrupting the result by the host's UTC offset.
- Sidebar label: exactly "Saved Searches". Position: the "Search" group in `components/app-sidebar.tsx`, between "Batch Lookup" and "Breaches". Icon: `Bookmark` from `lucide-react`.
- `/monitoring` keeps its own "View Matches" button — it is not removed, just repointed at the shared hook/component.

---

### Task 1: Extract the matches hook and dialog out of `/monitoring`

**Files:**
- Create: `hooks/useMonitorMatches.ts`
- Create: `components/monitor-matches-dialog.tsx`
- Modify: `app/monitoring/page.tsx`
- Test: `__tests__/monitor-matches-shared.test.ts`

**Interfaces:**
- Produces: `useMonitorMatches()` returning `{ matchesMonitor: MonitorMatchTarget | null, matches: MonitorMatchRow[], matchesLoading: boolean, matchesLimited: boolean, matchesNewCount: number, matchesError: string | null, openMatches: (monitor: MonitorMatchTarget) => Promise<void>, closeMatches: () => void }`, where `MonitorMatchTarget = { id: number; name: string }` and `MonitorMatchRow = { url: string; email: string; password: string; domain: string; is_new: boolean }`, both exported from `hooks/useMonitorMatches.ts`.
- Produces: `<MonitorMatchesDialog monitor matches loading limited newCount error onClose />` from `components/monitor-matches-dialog.tsx`, importing its prop types from the hook file.
- Tasks 2 and 3 do not depend on this task's internals beyond these two exports.

- [ ] **Step 1: Write the extraction-preserving test (will fail — nothing extracted yet)**

Create `__tests__/monitor-matches-shared.test.ts`:

```ts
/**
 * Confirms the matches dialog/state extracted out of app/monitoring/page.tsx
 * into hooks/useMonitorMatches.ts + components/monitor-matches-dialog.tsx
 * preserved the exact behavior that used to live inline — same endpoint,
 * same request-sequencing guard, same error copy — rather than a subtly
 * different rewrite. Source-text style, matching
 * __tests__/monitor-matches-route.test.ts's convention: this project's
 * Vitest runs in a node environment with no jsdom/React Testing Library,
 * so behavioral component tests aren't available here.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('shared matches hook + dialog', () => {
  const hook = readFileSync(new URL('../hooks/useMonitorMatches.ts', import.meta.url), 'utf8')
  const dialog = readFileSync(new URL('../components/monitor-matches-dialog.tsx', import.meta.url), 'utf8')
  const monitoringPage = readFileSync(new URL('../app/monitoring/page.tsx', import.meta.url), 'utf8')

  test('hook fetches the same per-monitor matches endpoint', () => {
    expect(hook).toContain('/api/monitoring/monitors/${monitor.id}/matches')
  })

  test('hook keeps the stale-response guard', () => {
    // A cold phase-1 cache makes this request seconds long; switching
    // monitors mid-flight must not let an older response overwrite state.
    expect(hook).toContain('matchesRequestId')
    expect(hook).toMatch(/requestId !== matchesRequestId\.current/)
  })

  test('hook keeps the exact error copy for both failure branches', () => {
    expect(hook).toContain('The match query failed. Results below are unavailable — this is not a confirmation that nothing matches.')
    expect(hook).toContain('Could not reach the server. Results are unavailable — this is not a confirmation that nothing matches.')
  })

  test('dialog keeps the failed-query-before-empty-state branch order', () => {
    // A failed query is not evidence of zero matches — rendering "No
    // current matches" for one would be an authoritative false negative.
    const errorIdx = dialog.indexOf('error ?')
    const emptyIdx = dialog.indexOf('No current matches')
    expect(errorIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(errorIdx)
  })

  test('dialog keeps the NEW badge and matches table columns', () => {
    expect(dialog).toContain('is_new')
    expect(dialog).toContain('NEW')
    expect(dialog).toMatch(/URL[\s\S]*Email[\s\S]*Password[\s\S]*Domain/)
  })

  test('monitoring page no longer defines its own openMatches — it imports the shared hook', () => {
    expect(monitoringPage).not.toMatch(/const openMatches = async/)
    expect(monitoringPage).toContain('useMonitorMatches')
    expect(monitoringPage).toContain('MonitorMatchesDialog')
  })

  test('monitoring page still offers the View Matches action', () => {
    expect(monitoringPage).toContain('View Matches')
    expect(monitoringPage).toMatch(/onClick=\{\(\) => openMatches\(monitor\)\}/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/monitor-matches-shared.test.ts`
Expected: FAIL — `hooks/useMonitorMatches.ts` and `components/monitor-matches-dialog.tsx` don't exist yet (ENOENT), and the "no longer defines its own openMatches" assertion fails since it still does.

- [ ] **Step 3: Create the hook**

Create `hooks/useMonitorMatches.ts`:

```ts
"use client"

import { useState, useRef } from "react"
import { useToast } from "@/hooks/use-toast"

export interface MonitorMatchTarget {
  id: number
  name: string
}

export interface MonitorMatchRow {
  url: string
  email: string
  password: string
  domain: string
  is_new: boolean
}

export function useMonitorMatches() {
  const { toast } = useToast()

  const [matchesMonitor, setMatchesMonitor] = useState<MonitorMatchTarget | null>(null)
  const [matches, setMatches] = useState<MonitorMatchRow[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
  const [matchesNewCount, setMatchesNewCount] = useState(0)
  // Distinct from "loaded, zero rows" on purpose — see the dialog's render
  // branches. An empty table must never stand in for a failed query.
  const [matchesError, setMatchesError] = useState<string | null>(null)
  // Only the newest openMatches call may write state. A cold phase-1 cache
  // makes this request seconds long, so switching monitors mid-flight would
  // otherwise let the first monitor's response land in the second's dialog.
  const matchesRequestId = useRef(0)

  const openMatches = async (monitor: MonitorMatchTarget) => {
    const requestId = ++matchesRequestId.current
    setMatchesMonitor(monitor)
    setMatchesLoading(true)
    setMatches([])
    setMatchesLimited(false)
    setMatchesNewCount(0)
    setMatchesError(null)
    try {
      const res = await fetch(`/api/monitoring/monitors/${monitor.id}/matches`)
      const data = await res.json()
      if (requestId !== matchesRequestId.current) return
      if (data.success) {
        setMatches(data.results || [])
        setMatchesLimited(Boolean(data.limited))
        setMatchesNewCount(data.new_count || 0)
      } else {
        const message = data.error || "The match query failed. Results below are unavailable — this is not a confirmation that nothing matches."
        setMatchesError(message)
        toast({ title: "Failed to load matches", description: message, variant: "destructive" })
      }
    } catch {
      if (requestId !== matchesRequestId.current) return
      setMatchesError("Could not reach the server. Results are unavailable — this is not a confirmation that nothing matches.")
      toast({ title: "Failed to load matches", variant: "destructive" })
    } finally {
      if (requestId === matchesRequestId.current) setMatchesLoading(false)
    }
  }

  const closeMatches = () => setMatchesMonitor(null)

  return {
    matchesMonitor,
    matches,
    matchesLoading,
    matchesLimited,
    matchesNewCount,
    matchesError,
    openMatches,
    closeMatches,
  }
}
```

- [ ] **Step 4: Create the dialog component**

Create `components/monitor-matches-dialog.tsx`:

```tsx
"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2 } from "lucide-react"
import type { MonitorMatchTarget, MonitorMatchRow } from "@/hooks/useMonitorMatches"

interface MonitorMatchesDialogProps {
  monitor: MonitorMatchTarget | null
  matches: MonitorMatchRow[]
  loading: boolean
  limited: boolean
  newCount: number
  error: string | null
  onClose: () => void
}

export function MonitorMatchesDialog({
  monitor, matches, loading, limited, newCount, error, onClose,
}: MonitorMatchesDialogProps) {
  return (
    <Dialog open={monitor !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Matches — {monitor?.name}</DialogTitle>
          <DialogDescription>
            Credentials currently matching this monitor&apos;s domains, queried live.
            {!error && newCount > 0 && ` ${newCount} new since your last view.`}
            {!error && limited && ` Showing first ${matches.length} — more may exist.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            /* Must come before the empty-state branch: a failed query is not
               evidence of zero matches, and rendering "No current matches"
               for one is an authoritative false negative. */
            <Alert variant="destructive" className="my-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
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
                      {m.is_new && (
                        <Badge className="text-xs font-normal ml-1.5 bg-primary/10 text-primary border-primary/20">NEW</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 5: Wire `app/monitoring/page.tsx` to the extracted pieces**

In `app/monitoring/page.tsx`:

1. Change the react import (line 3) — `useRef` becomes unused once `matchesRequestId` moves out:

```ts
import { useState, useEffect, useCallback } from "react"
```

2. Add two new imports alongside the existing ones (after the `useToast` import):

```ts
import { useMonitorMatches } from "@/hooks/useMonitorMatches"
import { MonitorMatchesDialog } from "@/components/monitor-matches-dialog"
```

3. Replace the "Live matches" state block (the `matchesMonitor` / `matches` / `matchesLoading` / `matchesLimited` / `matchesNewCount` / `matchesError` / `matchesRequestId` declarations) with:

```ts
  // Live matches ("saved search") state — shared with app/saved-searches/page.tsx
  const {
    matchesMonitor, matches, matchesLoading, matchesLimited, matchesNewCount, matchesError,
    openMatches, closeMatches,
  } = useMonitorMatches()
```

4. Delete the `openMatches` function entirely (it now comes from the hook).

5. Replace the inline matches `<Dialog>` block with:

```tsx
      <MonitorMatchesDialog
        monitor={matchesMonitor}
        matches={matches}
        loading={matchesLoading}
        limited={matchesLimited}
        newCount={matchesNewCount}
        error={matchesError}
        onClose={closeMatches}
      />
```

The "View Matches" button (`onClick={() => openMatches(monitor)}`) needs no change — `monitor` is the page's local `DomainMonitor`, which has `id: number` and `name: string` and so already satisfies `MonitorMatchTarget` structurally.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run __tests__/monitor-matches-shared.test.ts`
Expected: PASS (6/6)

- [ ] **Step 7: Type-check and run the full suite to confirm nothing else broke**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `useRef` removal didn't leave a dangling reference, and no other file imported anything now-removed from `app/monitoring/page.tsx`)

Run: `SQLITE_PATH=/tmp/claude-1000/-home-cole-ulp-suite/be9b33ff-52bc-4d1b-aa8b-fe340d6e6770/scratchpad/verify-task1.db npx vitest run`
Expected: same pass count as before this task (this is a pure refactor — no test should newly fail)

- [ ] **Step 8: Commit**

```bash
git add hooks/useMonitorMatches.ts components/monitor-matches-dialog.tsx app/monitoring/page.tsx __tests__/monitor-matches-shared.test.ts
git commit -m "refactor(monitoring): extract matches hook + dialog into shared modules"
```

---

### Task 2: Add `last_viewed_at` to the monitors list endpoint

**Files:**
- Modify: `lib/domain-monitor.ts`
- Modify: `app/api/monitoring/monitors/route.ts`
- Test: `__tests__/attach-last-viewed-at.test.ts`

**Interfaces:**
- Consumes: `getLastViewedAt(monitorId: number, userId: number): Promise<string | null>` (already exists at `lib/domain-monitor.ts:480`).
- Produces: `attachLastViewedAt<T extends { id: number }>(monitors: T[], userId: number): Promise<Array<T & { last_viewed_at: string | null }>>`, exported from `lib/domain-monitor.ts`. Task 3's page relies on the resulting `last_viewed_at: string | null` field being present in `GET /api/monitoring/monitors`'s response items.

- [ ] **Step 1: Write the failing test**

Create `__tests__/attach-last-viewed-at.test.ts`:

```ts
/**
 * Behavioral coverage for lib/domain-monitor.ts's attachLastViewedAt — the
 * enrichment GET /api/monitoring/monitors uses to add a per-user
 * last_viewed_at to each monitor for the saved-searches hub page. Runs
 * against a real, file-backed better-sqlite3 database via lib/sqlite.ts's
 * own SQLITE_PATH-pointed connection (the same pattern as
 * __tests__/monitor-is-new.test.ts), since a mocked dbGet can't catch a
 * wrong join/param order.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  return path.join(os.tmpdir(), `ulp-attach-last-viewed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

/**
 * Point lib/sqlite.ts at a fresh temp database and hand back its (freshly
 * imported) helpers plus the function under test. lib/sqlite.ts reads
 * SQLITE_PATH once at module load and memoizes the connection on `global`,
 * so both have to be cleared for the new path to take effect.
 */
async function loadAgainstFreshDb() {
  const p = freshDbPath()
  tmpFiles.push(p)
  process.env.SQLITE_PATH = p
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  vi.resetModules()
  const sqlite = await import('@/lib/sqlite')
  const { attachLastViewedAt } = await import('@/lib/domain-monitor')
  return { ...sqlite, attachLastViewedAt }
}

beforeEach(() => {
  originalSqlitePath = process.env.SQLITE_PATH
})

afterEach(() => {
  const db = (globalThis as unknown as { _sqliteDb?: { close(): void } })._sqliteDb
  if (db) db.close()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH
  else process.env.SQLITE_PATH = originalSqlitePath
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true })
  }
  vi.resetModules()
})

describe('attachLastViewedAt (run against a real database)', () => {
  test('null for a monitor this user has never viewed, populated after a view', async () => {
    const { dbRun, attachLastViewedAt } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (7, 'admin@test.local', 'x', 'Admin')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)

    const before = await attachLastViewedAt([{ id: 1, name: 'Test' }], 7)
    expect(before).toEqual([{ id: 1, name: 'Test', last_viewed_at: null }])

    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (1, 7, '2026-08-24 10:00:00')`)

    const after = await attachLastViewedAt([{ id: 1, name: 'Test' }], 7)
    expect(after).toEqual([{ id: 1, name: 'Test', last_viewed_at: '2026-08-24 10:00:00' }])
  })

  test('is scoped per-user — one admin viewing does not affect another admin\'s value', async () => {
    const { dbRun, attachLastViewedAt } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (7, 'admin@test.local', 'x', 'Admin')`)
    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (8, 'other@test.local', 'x', 'Other')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)
    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (1, 7, '2026-08-24 10:00:00')`)

    const forViewer = await attachLastViewedAt([{ id: 1, name: 'Test' }], 7)
    const forOther = await attachLastViewedAt([{ id: 1, name: 'Test' }], 8)
    expect(forViewer[0].last_viewed_at).toBe('2026-08-24 10:00:00')
    expect(forOther[0].last_viewed_at).toBeNull()
  })

  test('preserves every other field on each monitor, across a list of several', async () => {
    const { dbRun, attachLastViewedAt } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (7, 'admin@test.local', 'x', 'Admin')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'First', '["a.com"]')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (2, 'Second', '["b.com"]')`)
    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (2, 7, '2026-08-24 09:00:00')`)

    const result = await attachLastViewedAt(
      [{ id: 1, name: 'First', match_mode: 'both' }, { id: 2, name: 'Second', match_mode: 'url' }],
      7
    )
    expect(result).toEqual([
      { id: 1, name: 'First', match_mode: 'both', last_viewed_at: null },
      { id: 2, name: 'Second', match_mode: 'url', last_viewed_at: '2026-08-24 09:00:00' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/attach-last-viewed-at.test.ts`
Expected: FAIL — `attachLastViewedAt` is not exported from `lib/domain-monitor.ts` yet.

- [ ] **Step 3: Implement `attachLastViewedAt`**

In `lib/domain-monitor.ts`, add this immediately after `recordMonitorViewed` (which ends around line 495) and before the `markMatchesNewSinceLastView` docstring:

```ts
export async function attachLastViewedAt<T extends { id: number }>(
  monitors: T[],
  userId: number
): Promise<Array<T & { last_viewed_at: string | null }>> {
  return Promise.all(
    monitors.map(async monitor => ({
      ...monitor,
      last_viewed_at: await getLastViewedAt(monitor.id, userId),
    }))
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/attach-last-viewed-at.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Wire it into the monitors list route**

In `app/api/monitoring/monitors/route.ts`, change the import on line 3:

```ts
import { createMonitor, listMonitors, attachLastViewedAt } from "@/lib/domain-monitor"
```

Then change the `GET` handler's body (the `try` block) to:

```ts
  try {
    const { searchParams } = new URL(request.url)
    const activeOnly = searchParams.get("active_only") === "true"
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = parseInt(searchParams.get("offset") || "0")

    const result = await listMonitors({ activeOnly, limit, offset })
    const monitorsWithLastViewed = await attachLastViewedAt(result.monitors, parseInt(user.userId))

    return NextResponse.json({
      success: true,
      data: monitorsWithLastViewed,
      total: result.total,
    })
  } catch (error) {
```

The `POST` handler below is untouched.

- [ ] **Step 6: Type-check and run the full suite**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `SQLITE_PATH=/tmp/claude-1000/-home-cole-ulp-suite/be9b33ff-52bc-4d1b-aa8b-fe340d6e6770/scratchpad/verify-task2.db npx vitest run`
Expected: all passing, including the 3 new tests

- [ ] **Step 7: Commit**

```bash
git add lib/domain-monitor.ts app/api/monitoring/monitors/route.ts __tests__/attach-last-viewed-at.test.ts
git commit -m "feat(monitoring): add per-user last_viewed_at to the monitors list endpoint"
```

---

### Task 3: Build the `/saved-searches` page and sidebar entry

**Files:**
- Create: `lib/format-relative-time.ts`
- Create: `app/saved-searches/page.tsx`
- Modify: `components/app-sidebar.tsx`
- Test: `__tests__/format-relative-time.test.ts`
- Test: `__tests__/saved-searches-page.test.ts`

**Interfaces:**
- Consumes: `useMonitorMatches()` and `<MonitorMatchesDialog />` from Task 1; `GET /api/monitoring/monitors?active_only=true` returning items with `last_viewed_at: string | null` from Task 2.
- Produces: `formatRelativeTime(dateStr: string): string`, exported from `lib/format-relative-time.ts` — no other task depends on it.

- [ ] **Step 1: Write the failing test for the relative-time formatter**

Create `__tests__/format-relative-time.test.ts`:

```ts
/**
 * lib/format-relative-time.ts turns a SQLite datetime('now') string
 * ("YYYY-MM-DD HH:MM:SS", no timezone marker, always UTC) into relative
 * text for the saved-searches hub's last-viewed indicator. The dedicated
 * UTC-handling test below exists because without an explicit "Z", JS parses
 * that space-separated form as *local* time — so on any machine not
 * running in UTC, a naive implementation would silently produce a wrong
 * offset. A test that only runs in UTC would never catch that.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatRelativeTime } from '@/lib/format-relative-time'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatRelativeTime', () => {
  test('under a minute reads "Just now"', () => {
    vi.setSystemTime(new Date('2026-08-24T10:00:30Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('Just now')
  })

  test('singular minute', () => {
    vi.setSystemTime(new Date('2026-08-24T10:01:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('1 minute ago')
  })

  test('plural minutes', () => {
    vi.setSystemTime(new Date('2026-08-24T10:05:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('5 minutes ago')
  })

  test('singular hour', () => {
    vi.setSystemTime(new Date('2026-08-24T11:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('1 hour ago')
  })

  test('plural hours', () => {
    vi.setSystemTime(new Date('2026-08-24T13:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('3 hours ago')
  })

  test('plural days', () => {
    vi.setSystemTime(new Date('2026-08-26T10:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('2 days ago')
  })

  test('treats the SQLite string as UTC regardless of the host timezone', () => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      vi.setSystemTime(new Date('2026-08-24T10:05:00Z'))
      // A naive `new Date(dateStr)` parse would read '2026-08-24 10:00:00'
      // as 10:00 America/New_York (UTC-4 in August), i.e. 14:00 UTC — after
      // the fake "now" of 10:05 UTC, producing a negative diff clamped to
      // "Just now" instead of the correct "5 minutes ago".
      expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('5 minutes ago')
    } finally {
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    }
  })

  test('clamps a timestamp that is in the future (clock skew) to "Just now" rather than negative', () => {
    vi.setSystemTime(new Date('2026-08-24T10:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:05:00')).toBe('Just now')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/format-relative-time.test.ts`
Expected: FAIL — `lib/format-relative-time.ts` does not exist yet.

- [ ] **Step 3: Implement the formatter**

Create `lib/format-relative-time.ts`:

```ts
// SQLite's datetime('now') returns UTC with no timezone marker
// ("YYYY-MM-DD HH:MM:SS"). Without an explicit "Z", `new Date(...)` parses
// the space-separated form as local time, silently corrupting the offset
// on any host not running in UTC — so the "T" + "Z" rewrite below is load
// bearing, not cosmetic.
export function formatRelativeTime(dateStr: string): string {
  const then = new Date(dateStr.replace(' ', 'T') + 'Z').getTime()
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60000))

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/format-relative-time.test.ts`
Expected: PASS (8/8)

- [ ] **Step 5: Add the sidebar entry**

In `components/app-sidebar.tsx`, add `Bookmark` to the lucide-react import (line 3):

```ts
import { Upload, Database, Settings, Users, LucideIcon, Key, BookOpen, ClipboardList, FileText, Radio, ShieldAlert, Search, Shield, Inbox, Bookmark } from "lucide-react"
```

Then insert a new entry into the `"Search"` group's `items` array, between Batch Lookup and Breaches:

```ts
  {
    title: "Search",
    items: [
      { title: "Credentials", url: "/credentials", icon: Database },
      { title: "Batch Lookup",  url: "/lookup",      icon: Search },
      { title: "Saved Searches", url: "/saved-searches", icon: Bookmark },
      { title: "Breaches", url: "/breaches", icon: ShieldAlert },
    ],
  },
```

- [ ] **Step 6: Write the page**

Create `app/saved-searches/page.tsx`:

```tsx
"use client"

import { useState, useEffect, useCallback } from "react"
import { Bookmark, Globe, RefreshCw, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"
import { useMonitorMatches } from "@/hooks/useMonitorMatches"
import { MonitorMatchesDialog } from "@/components/monitor-matches-dialog"
import { formatRelativeTime } from "@/lib/format-relative-time"

interface SavedSearch {
  id: number
  name: string
  domains: string[]
  match_mode: "credential" | "url" | "both"
  last_viewed_at: string | null
}

export default function SavedSearchesPage() {
  const { user, loading: authLoading } = useAuth(true)
  const { toast } = useToast()

  const [searches, setSearches] = useState<SavedSearch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const {
    matchesMonitor, matches, matchesLoading, matchesLimited, matchesNewCount, matchesError,
    openMatches, closeMatches,
  } = useMonitorMatches()

  const fetchSearches = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch("/api/monitoring/monitors?active_only=true", { credentials: "include", cache: "no-store" })
      const data = await res.json()
      if (data.success) {
        setSearches(data.data || [])
      } else {
        setError(data.error || "Failed to load saved searches")
        toast({ variant: "destructive", title: "Error", description: data.error || "Failed to load saved searches" })
      }
    } catch (_error) {
      setError("Failed to load saved searches")
      toast({ variant: "destructive", title: "Error", description: "Failed to load saved searches" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (!authLoading && user) fetchSearches()
  }, [authLoading, user, fetchSearches])

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <main className="flex-1 p-6 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Bookmark className="h-7 w-7 text-primary" />
              </div>
              Saved Searches
            </h1>
            <p className="text-muted-foreground">
              Credentials currently matching your team&apos;s monitored domains, queried live.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchSearches}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        ) : searches.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Bookmark className="h-12 w-12 mx-auto text-muted-foreground opacity-30 mb-4" />
              <p className="text-muted-foreground">No saved searches yet — ask an admin to set one up in Domain Monitoring.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {searches.map(search => (
              <Card key={search.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-lg">{search.name}</CardTitle>
                      <Badge variant="outline">
                        {search.match_mode === "both" ? "Email + URL" : search.match_mode === "credential" ? "Email Only" : "URL Only"}
                      </Badge>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => openMatches(search)}>
                      <Search className="h-4 w-4 mr-1.5" />
                      View Matches
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {search.domains.map((domain, i) => (
                      <Badge key={i} variant="outline" className="gap-1">
                        <Globe className="h-3 w-3" />
                        {domain}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {search.last_viewed_at ? formatRelativeTime(search.last_viewed_at) : "Never viewed"}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <MonitorMatchesDialog
        monitor={matchesMonitor}
        matches={matches}
        loading={matchesLoading}
        limited={matchesLimited}
        newCount={matchesNewCount}
        error={matchesError}
        onClose={closeMatches}
      />
    </main>
  )
}
```

- [ ] **Step 7: Write the page/sidebar source-text test**

Create `__tests__/saved-searches-page.test.ts`:

```ts
/**
 * Source-shape guards for app/saved-searches/page.tsx and its sidebar
 * entry. This project's Vitest runs in a node environment with no
 * jsdom/React Testing Library, so — matching
 * __tests__/monitor-matches-route.test.ts's precedent — this pins the
 * structural decisions a code review can't casually miss (read-only, not
 * admin-gated, correct data source, correct sidebar position) rather than
 * rendering the component.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('saved searches page', () => {
  const page = readFileSync(new URL('../app/saved-searches/page.tsx', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../components/app-sidebar.tsx', import.meta.url), 'utf8')

  test('is read-only — no monitor create/edit/delete/webhook affordances', () => {
    expect(page).not.toMatch(/createMonitor|updateMonitor|deleteMonitor|handleSaveMonitor|handleDeleteMonitor|showMonitorDialog/)
    expect(page).not.toMatch(/webhook/i)
  })

  test('is not admin-gated', () => {
    expect(page).not.toContain('isAdmin')
    expect(page).not.toContain('requireAdminRole')
  })

  test('fetches the active-only monitors list and reuses the shared matches dialog', () => {
    expect(page).toContain('/api/monitoring/monitors?active_only=true')
    expect(page).toContain('useMonitorMatches')
    expect(page).toContain('MonitorMatchesDialog')
  })

  test('renders a last-viewed indicator sourced from last_viewed_at', () => {
    expect(page).toContain('last_viewed_at')
    expect(page).toContain('formatRelativeTime')
    expect(page).toContain('Never viewed')
  })

  test('sidebar has a Saved Searches entry positioned between Batch Lookup and Breaches', () => {
    const searchGroup = sidebar.match(/title: "Search",[\s\S]*?items: \[([\s\S]*?)\]/)
    expect(searchGroup).toBeTruthy()
    const items = searchGroup![1]
    const batchIdx = items.indexOf('"Batch Lookup"')
    const savedIdx = items.indexOf('"Saved Searches"')
    const breachesIdx = items.indexOf('"Breaches"')
    expect(batchIdx).toBeGreaterThan(-1)
    expect(savedIdx).toBeGreaterThan(batchIdx)
    expect(breachesIdx).toBeGreaterThan(savedIdx)
  })

  test('sidebar entry is not admin-gated and points at /saved-searches', () => {
    const entryMatch = sidebar.match(/\{\s*title:\s*"Saved Searches"[^}]*\}/)
    expect(entryMatch).toBeTruthy()
    const entry = entryMatch![0]
    expect(entry).toContain('url: "/saved-searches"')
    expect(entry).not.toContain('adminOnly')
  })
})
```

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `npx vitest run __tests__/saved-searches-page.test.ts`
Expected: PASS (6/6)

- [ ] **Step 9: Type-check and run the full suite**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `SQLITE_PATH=/tmp/claude-1000/-home-cole-ulp-suite/be9b33ff-52bc-4d1b-aa8b-fe340d6e6770/scratchpad/verify-task3.db npx vitest run`
Expected: all passing, including all tests added across Tasks 1–3

- [ ] **Step 10: Commit**

```bash
git add lib/format-relative-time.ts app/saved-searches/page.tsx components/app-sidebar.tsx __tests__/format-relative-time.test.ts __tests__/saved-searches-page.test.ts
git commit -m "feat(saved-searches): add the saved-searches hub page and sidebar entry"
```
