# Inbox Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/inbox` page that shows the inbox watcher's live state (waiting/processing/done/failed files) with one-click retry for failed files, backed by a filesystem-reading status API.

**Architecture:** A `lib/inbox-helpers.ts` module encapsulates all filesystem reads and the path constants (shared by both API routes). `GET /api/inbox/status` merges filesystem state with live queue counters and recent `processing_jobs` rows. `POST /api/inbox/retry` moves files from `inbox/failed/` back to `inbox/`. The `/inbox` page polls the status API every 3 s. Sidebar nav gains an "Inbox" link under Import.

**Tech Stack:** Next.js 15, React 19, better-sqlite3, Node.js `fs`, lucide-react, Vitest

---

## File Map

| File | Action |
|---|---|
| `lib/inbox-helpers.ts` | **Create** — filesystem helpers + path constants (testable in isolation) |
| `__tests__/inbox-status.test.ts` | **Create** — unit tests for helpers (mocked `fs`) |
| `app/api/inbox/status/route.ts` | **Create** — admin GET: filesystem + queue state + DB history |
| `app/api/inbox/retry/route.ts` | **Create** — admin POST: move failed files back to inbox |
| `app/inbox/page.tsx` | **Create** — `/inbox` page polling every 3 s |
| `components/app-sidebar.tsx` | **Modify** — add Inbox nav item to Import group |

---

### Task 1: lib/inbox-helpers.ts + tests

**Files:**
- Create: `lib/inbox-helpers.ts`
- Create: `__tests__/inbox-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/inbox-status.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn(),
    statSync:    vi.fn(),
    renameSync:  vi.fn(),
  },
}))

import fs from 'fs'
import { getWaiting, getFailed, getDoneCount, retryFiles, retryAllFailed } from '@/lib/inbox-helpers'

const mockDirent = (name: string, isFile = true) => ({
  name,
  isFile: () => isFile,
  isDirectory: () => !isFile,
})

const mockStat = (size: number, mtime: Date) => ({
  size,
  mtime,
  isFile: () => true,
})

describe('getWaiting', () => {
  beforeEach(() => vi.clearAllMocks())

  test('returns files sorted oldest-first, excludes done/ and failed/ dirs', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('batch_002.txt'),
      mockDirent('done', false),
      mockDirent('failed', false),
      mockDirent('batch_001.txt'),
    ] as any)
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      const old = String(p).includes('001')
      return mockStat(old ? 100 : 200, new Date(old ? '2026-01-01' : '2026-01-02')) as any
    })

    const result = getWaiting()
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('batch_001.txt')   // oldest first
    expect(result[1].name).toBe('batch_002.txt')
  })

  test('returns empty array when directory does not exist', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(getWaiting()).toEqual([])
  })
})

describe('getDoneCount', () => {
  beforeEach(() => vi.clearAllMocks())

  test('returns count of files in done/', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('file1.txt'),
      mockDirent('file2.txt'),
    ] as any)
    expect(getDoneCount()).toBe(2)
  })

  test('returns 0 when done/ does not exist', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(getDoneCount()).toBe(0)
  })
})

describe('retryFiles', () => {
  beforeEach(() => vi.clearAllMocks())

  test('moves listed files from failed/ to inbox/', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    const moved = retryFiles(['a.txt', 'b.txt'])
    expect(moved).toEqual(['a.txt', 'b.txt'])
    expect(fs.renameSync).toHaveBeenCalledTimes(2)
  })

  test('rejects filenames containing path traversal', () => {
    const moved = retryFiles(['../../../etc/passwd', '..\\secret', 'safe.txt'])
    // only 'safe.txt' passes validation
    expect(moved).toEqual(['safe.txt'])
  })

  test('skips files that do not exist (renameSync throws)', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error('ENOENT') })
    const moved = retryFiles(['missing.txt'])
    expect(moved).toEqual([])
  })
})

describe('retryAllFailed', () => {
  beforeEach(() => vi.clearAllMocks())

  test('retries all files in failed/', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('a.txt'),
      mockDirent('b.zip'),
    ] as any)
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    const moved = retryAllFailed()
    expect(moved).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npm test -- __tests__/inbox-status.test.ts
```

Expected: FAIL — `inbox-helpers` not found.

- [ ] **Step 3: Create lib/inbox-helpers.ts**

```ts
/**
 * Filesystem helpers for the inbox watcher directories.
 *
 * Extracted from API routes so they can be unit-tested in isolation
 * (tests mock 'fs' rather than needing a real filesystem).
 */

import fs   from 'fs'
import path from 'path'

export const INBOX_DIR  = path.resolve('./inbox')
export const DONE_DIR   = path.resolve('./inbox/done')
export const FAILED_DIR = path.resolve('./inbox/failed')

export interface InboxFileEntry {
  name:       string
  size_bytes: number
  mtime:      string   // ISO datetime string
}

function readFileEntries(dir: string): InboxFileEntry[] {
  try {
    return (fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile())
      .map(e => {
        const stat = fs.statSync(path.join(dir, e.name))
        return { name: e.name, size_bytes: stat.size, mtime: stat.mtime.toISOString() }
      })
  } catch {
    return []
  }
}

/** Files in inbox/ root — sorted oldest first (next to process). */
export function getWaiting(): InboxFileEntry[] {
  try {
    return (fs.readdirSync(INBOX_DIR, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile())   // skip done/ and failed/ subdirs
      .map(e => {
        const stat = fs.statSync(path.join(INBOX_DIR, e.name))
        return { name: e.name, size_bytes: stat.size, mtime: stat.mtime.toISOString() }
      })
      .sort((a, b) => a.mtime.localeCompare(b.mtime))
  } catch {
    return []
  }
}

/** Files in inbox/failed/. */
export function getFailed(): InboxFileEntry[] {
  return readFileEntries(FAILED_DIR)
}

/** Count of files in inbox/done/ — no file details (could be thousands). */
export function getDoneCount(): number {
  try {
    return (fs.readdirSync(DONE_DIR, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile()).length
  } catch {
    return 0
  }
}

/**
 * Move named files from inbox/failed/ → inbox/.
 * Skips filenames containing '/', '\\', or '..' (path traversal guard).
 * Returns the list of filenames actually moved.
 */
export function retryFiles(filenames: string[]): string[] {
  const moved: string[] = []
  for (const name of filenames) {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
    try {
      fs.renameSync(path.join(FAILED_DIR, name), path.join(INBOX_DIR, name))
      moved.push(name)
    } catch {
      // file missing or unreadable — skip
    }
  }
  return moved
}

/** Move ALL files from inbox/failed/ → inbox/. */
export function retryAllFailed(): string[] {
  try {
    const names = (fs.readdirSync(FAILED_DIR, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile())
      .map(e => e.name)
    return retryFiles(names)
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run tests — should pass**

```bash
npm test -- __tests__/inbox-status.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: 407 tests pass (399 + 8 new).

- [ ] **Step 6: Commit**

```bash
git add lib/inbox-helpers.ts __tests__/inbox-status.test.ts
git commit -m "feat(inbox): add inbox-helpers with filesystem read/retry logic + tests"
```

---

### Task 2: app/api/inbox/status/route.ts

**Files:**
- Create: `app/api/inbox/status/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { dbQuery } from '@/lib/sqlite'
import { uploadQueue, getCurrentJob } from '@/lib/upload-queue'
import { getWaiting, getFailed, getDoneCount } from '@/lib/inbox-helpers'

export const dynamic = 'force-dynamic'

interface DoneRow {
  id:            number
  filename:      string
  status:        string
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const waiting    = getWaiting()
  const failed     = getFailed()
  const done_count = getDoneCount()
  const current    = getCurrentJob()
  const depth      = uploadQueue.activeCount + uploadQueue.pendingCount

  const done_recent = dbQuery(
    `SELECT id, filename, status, imported, skipped, duration_ms, error_message, created_at
     FROM processing_jobs
     WHERE source = 'inbox'
     ORDER BY id DESC
     LIMIT 10`,
  ) as DoneRow[]

  return NextResponse.json({
    watcher_active: depth > 0 || current !== null,
    current_file:   current,
    queue_depth:    depth,
    waiting,
    failed,
    done_count,
    done_recent,
  })
}
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 407 tests pass.

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/inbox/status/route.ts
git commit -m "feat(inbox): add GET /api/inbox/status endpoint"
```

---

### Task 3: app/api/inbox/retry/route.ts

**Files:**
- Create: `app/api/inbox/retry/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { retryFiles, retryAllFailed } from '@/lib/inbox-helpers'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ success: false, error: 'Body must be an object' }, { status: 400 })
  }

  const b = body as Record<string, unknown>

  let moved: string[]

  if (b.all === true) {
    moved = retryAllFailed()
  } else if (typeof b.filename === 'string' && b.filename.length > 0) {
    moved = retryFiles([b.filename])
  } else {
    return NextResponse.json(
      { success: false, error: 'Body must be { filename: string } or { all: true }' },
      { status: 400 },
    )
  }

  return NextResponse.json({ success: true, moved })
}
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 407 tests pass.

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/inbox/retry/route.ts
git commit -m "feat(inbox): add POST /api/inbox/retry endpoint"
```

---

### Task 4: app/inbox/page.tsx

**Files:**
- Create: `app/inbox/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import {
  Inbox, CheckCircle, XCircle, Loader2, RefreshCw,
  Clock, AlertCircle, HardDrive, Timer,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAuth, isAdmin } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"

// ─── Types ───────────────────────────────────────────────────────────────────

interface InboxFileEntry {
  name:       string
  size_bytes: number
  mtime:      string
}

interface DoneEntry {
  id:            number
  filename:      string
  status:        'done' | 'failed'
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
}

interface InboxStatus {
  watcher_active: boolean
  current_file:   string | null
  queue_depth:    number
  waiting:        InboxFileEntry[]
  failed:         InboxFileEntry[]
  done_count:     number
  done_recent:    DoneEntry[]
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`
  if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`
  return `${b} B`
}

function fmtRelTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1_000)
  if (diff < 5)    return 'just now'
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function fmtDuration(ms: number): string {
  if (ms < 1_000)    return `${ms}ms`
  if (ms < 60_000)   return `${(ms / 1_000).toFixed(0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { user, loading: authLoading } = useAuth(true)
  const userIsAdmin = isAdmin(user)
  const { toast } = useToast()

  const [data, setData]               = useState<InboxStatus | null>(null)
  const [loadError, setLoadError]     = useState(false)
  const [retrying, setRetrying]       = useState<string | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/api/inbox/status')
        if (!res.ok) { setLoadError(true); return }
        const json = await res.json()
        if (!cancelled) { setData(json); setLoadError(false) }
      } catch {
        if (!cancelled) setLoadError(true)
      }
    }
    poll()
    const id = setInterval(poll, 3_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const retry = useCallback(async (filename: string) => {
    setRetrying(filename)
    try {
      const res = await fetch('/api/inbox/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      if (res.ok) toast({ title: `${filename} queued for retry` })
      else        toast({ title: 'Retry failed', variant: 'destructive' })
    } catch {
      toast({ title: 'Retry failed', variant: 'destructive' })
    } finally {
      setRetrying(null)
    }
  }, [toast])

  const retryAll = useCallback(async () => {
    setRetryingAll(true)
    try {
      const res  = await fetch('/api/inbox/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const json = await res.json()
      toast({ title: `${json.moved?.length ?? 0} files queued for retry` })
    } catch {
      toast({ title: 'Retry all failed', variant: 'destructive' })
    } finally {
      setRetryingAll(false)
    }
  }, [toast])

  if (authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }

  if (!userIsAdmin) {
    return (
      <div className="flex h-full items-center justify-center">
        <Alert className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Admin access required.</AlertDescription>
        </Alert>
      </div>
    )
  }

  const isActive = data?.watcher_active ?? false

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Inbox className="h-6 w-6" /> Inbox Monitor
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Drop <code className="text-xs bg-muted px-1 rounded">.txt</code>,{' '}
            <code className="text-xs bg-muted px-1 rounded">.csv</code>, or{' '}
            <code className="text-xs bg-muted px-1 rounded">.zip</code> files into{' '}
            <code className="text-xs bg-muted px-1 rounded">./inbox/</code> to process them automatically.
          </p>
        </div>
        <Badge variant="outline" className={`text-xs ${isActive ? 'text-green-600 border-green-500/40' : 'text-muted-foreground'}`}>
          {isActive ? '● Live' : '○ Idle'}
        </Badge>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Could not load inbox status.</AlertDescription>
        </Alert>
      )}

      {/* Status bar */}
      {data && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-6 text-sm flex-wrap">
              <div className="flex items-center gap-1.5">
                {isActive
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin text-green-500" />
                  : <span className="text-muted-foreground">○</span>
                }
                <span className={isActive ? 'text-green-600 dark:text-green-400 font-medium' : 'text-muted-foreground'}>
                  {isActive ? 'Processing' : 'Idle'}
                </span>
              </div>
              {data.current_file && (
                <span className="font-mono text-xs text-muted-foreground truncate max-w-xs" title={data.current_file}>
                  {data.current_file}
                  {data.queue_depth > 1 && (
                    <span className="ml-2">+{data.queue_depth - 1} waiting in queue</span>
                  )}
                </span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                Auto-refreshes every 3s
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Waiting */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Waiting ({data?.waiting.length ?? 0} files)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          {!data || data.waiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No files waiting — drop <code className="text-xs bg-muted px-1 rounded">.txt</code>/
              <code className="text-xs bg-muted px-1 rounded">.csv</code>/
              <code className="text-xs bg-muted px-1 rounded">.zip</code> files into{' '}
              <code className="text-xs bg-muted px-1 rounded">./inbox/</code> to start.
            </p>
          ) : (
            <div className="space-y-1">
              {data.waiting.map(f => (
                <div key={f.name} className="flex items-center gap-2 text-xs py-0.5">
                  <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={f.name}>{f.name}</span>
                  <span className={`tabular-nums shrink-0 ${f.size_bytes > 1_073_741_824 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                    {fmtBytes(f.size_bytes)}
                  </span>
                  <span className="text-muted-foreground shrink-0">{fmtRelTime(f.mtime)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Failed */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span className={data && data.failed.length > 0 ? 'text-red-600 dark:text-red-400' : ''}>
              Failed ({data?.failed.length ?? 0} files)
            </span>
            {data && data.failed.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={retryAll}
                disabled={retryingAll}
                className="h-7 text-xs"
              >
                {retryingAll
                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  : <RefreshCw className="h-3 w-3 mr-1" />
                }
                Retry All
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          {!data || data.failed.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failed files.</p>
          ) : (
            <div className="space-y-1.5">
              {data.failed.map(f => (
                <div key={f.name} className="flex items-center gap-2 text-xs py-0.5">
                  <XCircle className="h-3 w-3 shrink-0 text-red-500" />
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={f.name}>{f.name}</span>
                  <span className="text-muted-foreground shrink-0">{fmtBytes(f.size_bytes)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => retry(f.name)}
                    disabled={retrying === f.name}
                    className="h-6 px-2 text-xs"
                  >
                    {retrying === f.name
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />
                    }
                    <span className="ml-1">Retry</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Completed */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">
            Completed ({data?.done_count ?? 0} total — last 10 shown)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          {!data || data.done_recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files processed yet.</p>
          ) : (
            <div className="space-y-0.5">
              {data.done_recent.map(job => (
                <div key={job.id} className="flex items-center gap-2 text-xs py-0.5">
                  {job.status === 'done'
                    ? <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                    : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                  }
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={job.filename}>
                    {job.filename}
                  </span>
                  {job.status === 'done' ? (
                    <>
                      <span className="tabular-nums shrink-0">{fmtRows(job.imported)} rows</span>
                      <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                      </span>
                    </>
                  ) : (
                    <span className="text-red-500 truncate max-w-xs" title={job.error_message ?? ''}>
                      {job.error_message ?? 'failed'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0. If `HardDrive` or `Timer` icons aren't found, substitute: `HardDrive → FileText`, `Timer → Clock`.

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: 407 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/inbox/page.tsx
git commit -m "feat(inbox): add /inbox monitor page with live polling and retry UI"
```

---

### Task 5: Sidebar nav + final verification

**Files:**
- Modify: `components/app-sidebar.tsx`

- [ ] **Step 1: Add Inbox icon to imports**

Find line 3 of `components/app-sidebar.tsx`:
```ts
import { Upload, Database, Settings, Users, LucideIcon, Key, BookOpen, ClipboardList, FileText, Radio, BarChart2, AlertTriangle, Layers, ShieldAlert, Search, Shield } from "lucide-react"
```

Replace with (add `Inbox`):
```ts
import { Upload, Database, Settings, Users, LucideIcon, Key, BookOpen, ClipboardList, FileText, Radio, BarChart2, AlertTriangle, Layers, ShieldAlert, Search, Shield, Inbox } from "lucide-react"
```

- [ ] **Step 2: Add Inbox to the Import group**

Find the Import group in `menuGroups` (around line 49):
```ts
  {
    title: "Import",
    items: [
      { title: "Upload", url: "/upload", icon: Upload, adminOnly: true },
      { title: "Sources", url: "/sources", icon: FileText },
    ],
  },
```

Replace with:
```ts
  {
    title: "Import",
    items: [
      { title: "Upload", url: "/upload", icon: Upload, adminOnly: true },
      { title: "Inbox",  url: "/inbox",  icon: Inbox,  adminOnly: true },
      { title: "Sources", url: "/sources", icon: FileText },
    ],
  },
```

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: 407 tests pass.

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Verify git log**

```bash
git log --oneline -5
```

Expected (most recent first):
```
<sha>  feat(inbox): add Inbox nav item to sidebar
<sha>  feat(inbox): add /inbox monitor page with live polling and retry UI
<sha>  feat(inbox): add POST /api/inbox/retry endpoint
<sha>  feat(inbox): add GET /api/inbox/status endpoint
<sha>  feat(inbox): add inbox-helpers with filesystem read/retry logic + tests
```

- [ ] **Step 6: Commit and push**

```bash
git add components/app-sidebar.tsx
git commit -m "feat(inbox): add Inbox nav item to sidebar"
git push
```

---

## On the Ubuntu laptop after `git pull && docker compose up -d --build`

```bash
# The inbox/ folder is now visible on the host (volume mount added):
ls ~/ulp-suite/inbox/
ls ~/ulp-suite/inbox/done/
ls ~/ulp-suite/inbox/failed/

# Drop files in:
cp /path/to/dumps/*.txt ~/ulp-suite/inbox/

# Watch in the browser at http://localhost:3000/inbox
# Inbox link appears under "Import" in the sidebar
```
