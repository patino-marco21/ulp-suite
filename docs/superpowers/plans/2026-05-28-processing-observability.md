# Processing Queue Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent `processing_jobs` audit log, a live `GET /api/upload/queue-status` endpoint, and an always-visible `QueueStatusPanel` on the upload page so long-running batch processing (inbox and HTTP) is fully observable.

**Architecture:** A new `processing_jobs` SQLite table is written by a shared `logJob()` helper, called from both the HTTP upload route and the inbox watcher. The status API reads that table plus live `pLimit` counters (`uploadQueue.activeCount`, `uploadQueue.pendingCount`) and a module-level `currentJob` variable set/cleared by each upload path. The upload page polls the API every 3 s and renders a collapsible panel showing queue state, lifetime totals, and recent job history.

**Tech Stack:** Next.js 15, better-sqlite3, React 19, Vitest, lucide-react

---

## File Map

| File | Action |
|---|---|
| `lib/sqlite.ts` | Add `processing_jobs` table + `idx_processing_jobs_created` index to `initSchema()` |
| `lib/processing-log.ts` | **Create** — `logJob()` writes one row per completed file |
| `lib/upload-queue.ts` | Add `setCurrentJob()` / `getCurrentJob()` module-level variable |
| `app/api/upload/queue-status/route.ts` | **Create** — admin GET endpoint returning queue state + history + totals |
| `app/api/upload/route.ts` | Update `runWithProgress` (add `filename` param + `logJob`); wire `setCurrentJob` in txt/csv and ZIP paths |
| `lib/inbox-watcher.ts` | Wire `setCurrentJob` + `logJob` into the upload queue callback |
| `app/upload/page.tsx` | Add `QueueStatusPanel` component + mount below main upload section |
| `__tests__/processing-log.test.ts` | **Create** — 3 unit tests for `logJob` (mocked SQLite) |

---

### Task 1: processing_jobs table + lib/processing-log.ts + tests

**Files:**
- Modify: `lib/sqlite.ts`
- Create: `lib/processing-log.ts`
- Create: `__tests__/processing-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/processing-log.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbRun: vi.fn(),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(undefined),
}))

import { dbRun } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

describe('logJob', () => {
  beforeEach(() => vi.clearAllMocks())

  test('inserts a done row with correct fields', () => {
    logJob({
      source:      'http',
      filename:    'test.txt',
      status:      'done',
      imported:    1000,
      skipped:     50,
      duration_ms: 3000,
      breach_name: 'SomeBreach',
    })

    expect(dbRun).toHaveBeenCalledOnce()
    const [sql, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sql).toContain('INSERT INTO processing_jobs')
    expect(params).toContain('http')
    expect(params).toContain('test.txt')
    expect(params).toContain('done')
    expect(params).toContain(1000)
    expect(params).toContain(50)
    expect(params).toContain(3000)
    expect(params).toContain('SomeBreach')
  })

  test('includes error_message for a failed row', () => {
    logJob({
      source:        'inbox',
      filename:      'bad.zip',
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   500,
      error_message: 'unexpected EOF',
    })

    const [, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params).toContain('failed')
    expect(params).toContain('unexpected EOF')
  })

  test('is silent when dbRun throws', () => {
    ;(dbRun as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('db locked') })
    expect(() => logJob({
      source: 'http', filename: 'x.txt', status: 'done',
      imported: 0, skipped: 0, duration_ms: 0,
    })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npm test -- __tests__/processing-log.test.ts
```

Expected: FAIL — `logJob` not found.

- [ ] **Step 3: Add `processing_jobs` table to lib/sqlite.ts**

Open `lib/sqlite.ts`. Find the `CREATE INDEX IF NOT EXISTS idx_webhook_outbox_status_next` block (around line 233). After the closing backtick + `)` of that block (after line 236), add:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS processing_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT    NOT NULL,
      filename      TEXT    NOT NULL,
      status        TEXT    NOT NULL,
      imported      INTEGER NOT NULL DEFAULT 0,
      skipped       INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      breach_name   TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_created
      ON processing_jobs (id DESC)
  `)
```

- [ ] **Step 4: Create lib/processing-log.ts**

```ts
/**
 * Persistent audit log for upload pipeline jobs.
 *
 * One row per completed file — written by the HTTP upload route and the
 * inbox watcher.  Silent on error so logging never crashes a pipeline.
 */

import { dbRun } from '@/lib/sqlite'

export interface JobLogEntry {
  source:         'http' | 'inbox'
  filename:       string
  status:         'done' | 'failed'
  imported:       number
  skipped:        number
  duration_ms:    number
  error_message?: string
  breach_name?:   string
}

export function logJob(entry: JobLogEntry): void {
  try {
    dbRun(
      `INSERT INTO processing_jobs
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.source,
        entry.filename,
        entry.status,
        entry.imported,
        entry.skipped,
        entry.duration_ms,
        entry.error_message ?? null,
        entry.breach_name   ?? null,
      ],
    )
  } catch {
    // Logging must never crash the upload pipeline
  }
}
```

- [ ] **Step 5: Run tests — should pass**

```bash
npm test -- __tests__/processing-log.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: 399 tests pass (396 + 3 new).

- [ ] **Step 7: Commit**

```bash
git add lib/sqlite.ts lib/processing-log.ts __tests__/processing-log.test.ts
git commit -m "feat(observability): processing_jobs table + logJob helper"
```

---

### Task 2: setCurrentJob + queue-status API

**Files:**
- Modify: `lib/upload-queue.ts`
- Create: `app/api/upload/queue-status/route.ts`

- [ ] **Step 1: Add setCurrentJob / getCurrentJob to lib/upload-queue.ts**

Open `lib/upload-queue.ts`. The full file after the change:

```ts
/**
 * Global upload concurrency limiter.
 *
 * pLimit(1) = one file processed at a time; all others wait in FIFO order.
 * Both the HTTP upload route and the inbox watcher share this queue so they
 * never compete for memory.
 *
 * Raise to 2–3 on machines with ≥16 GB RAM and multi-core CPUs if throughput
 * matters more than peak-memory predictability.
 */
import pLimit from 'p-limit'

export const uploadQueue = pLimit(1)

/** Total number of uploads currently running + waiting. */
export function queueSize(): number {
  return uploadQueue.activeCount + uploadQueue.pendingCount
}

// ── Current job tracking ──────────────────────────────────────────────────────

let _currentJob: string | null = null

/** Set the filename of the job currently being processed. Pass null when done. */
export function setCurrentJob(name: string | null): void {
  _currentJob = name
}

/** Returns the filename currently being processed, or null if the queue is idle. */
export function getCurrentJob(): string | null {
  return _currentJob
}
```

- [ ] **Step 2: Run tsc to confirm clean**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npx tsc --noEmit 2>&1 && echo TSC_CLEAN
```

Expected: TSC_CLEAN.

- [ ] **Step 3: Create app/api/upload/queue-status/route.ts**

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { dbQuery } from '@/lib/sqlite'
import { uploadQueue, getCurrentJob } from '@/lib/upload-queue'

export const dynamic = 'force-dynamic'

interface ProcessingJobRow {
  id:            number
  source:        string
  filename:      string
  status:        string
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  breach_name:   string | null
  created_at:    string
}

interface TotalsRow {
  status:       string
  file_count:   number
  total_imported: number
  total_skipped:  number
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const recent = dbQuery(
    `SELECT id, source, filename, status, imported, skipped,
            duration_ms, error_message, breach_name, created_at
     FROM processing_jobs
     ORDER BY id DESC
     LIMIT 20`,
  ) as ProcessingJobRow[]

  const totalsRows = dbQuery(
    `SELECT status,
            COUNT(*)   AS file_count,
            SUM(imported) AS total_imported,
            SUM(skipped)  AS total_skipped
     FROM processing_jobs
     GROUP BY status`,
  ) as TotalsRow[]

  const done   = totalsRows.find(r => r.status === 'done')
  const failed = totalsRows.find(r => r.status === 'failed')

  return NextResponse.json({
    queue: {
      active:       uploadQueue.activeCount,
      pending:      uploadQueue.pendingCount,
      current_file: getCurrentJob(),
    },
    recent,
    totals: {
      files_done:    done?.file_count    ?? 0,
      files_failed:  failed?.file_count  ?? 0,
      rows_imported: done?.total_imported ?? 0,
      rows_skipped:  done?.total_skipped  ?? 0,
    },
  })
}
```

- [ ] **Step 4: Run full suite**

```bash
npm test
```

Expected: 399 tests pass.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/upload-queue.ts app/api/upload/queue-status/route.ts
git commit -m "feat(observability): setCurrentJob/getCurrentJob + queue-status API"
```

---

### Task 3: Wire logJob + setCurrentJob into app/api/upload/route.ts

**Files:**
- Modify: `app/api/upload/route.ts`

Context: `runWithProgress` gets a `filename` parameter so it can call `logJob`. The txt/csv queued function wraps `processTextStream` with `setCurrentJob`/`setCurrentJob(null)`. The ZIP block does the same. Read the current file first.

- [ ] **Step 1: Replace the full route.ts**

Write this content to `C:\Users\coler\Desktop\vault-refactor\bron-vault\app\api\upload\route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { makeRejectionMap, type RejectionReason } from '@/lib/ulp-parser'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue, setCurrentJob } from '@/lib/upload-queue'
import { processTextStream, processZipBuffer, type ProcessResult } from '@/lib/upload-processor'
import { checkLimit, getClientIP } from '@/lib/rate-limiter'
import { logJob } from '@/lib/processing-log'

// 5 uploads per IP per 5 minutes — generous for admin use, blocks runaway loops.
const uploadLimiter = new Map<string, { count: number; resetAt: number }>()

export const dynamic = 'force-dynamic'

// 5 minutes — large uploads (GBs of text) need sustained time.
export const maxDuration = 300

// 10 GB per file maximum.
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024

// ─── SSE progress wrapper ─────────────────────────────────────────────────────

/**
 * Wraps a processing function with SSE progress events + audit logging.
 * Pushes a heartbeat every 2 s; pushes a final event on done/error.
 */
async function runWithProgress(
  jobId:    string,
  filename: string,
  fn:       () => Promise<ProcessResult>,
): Promise<void> {
  const startAt = Date.now()
  const interval = setInterval(async () => {
    const j = getJob(jobId)
    if (j) await pushEvent(j).catch(() => {})
  }, 2_000)

  try {
    const result = await fn()
    updateJob(jobId, {
      status:              'done',
      imported:            result.imported,
      skipped:             result.skipped,
      rejection_breakdown: result.rejection_breakdown,
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
    logJob({
      source:      'http',
      filename,
      status:      'done',
      imported:    result.imported,
      skipped:     result.skipped,
      duration_ms: Date.now() - startAt,
      breach_name: result.breach_name,
    })
  } catch (err) {
    updateJob(jobId, {
      status: 'error',
      error:  err instanceof Error ? err.message : 'Upload failed',
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
    logJob({
      source:        'http',
      filename,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    clearInterval(interval)
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  // Rate limit: 5 uploads per IP per 5 minutes
  const ip       = getClientIP(request)
  const rlResult = checkLimit(uploadLimiter, ip, 5, 5 * 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many uploads — please wait before uploading again.' },
      {
        status: 429,
        headers: {
          'Retry-After':           String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit':     '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(rlResult.resetAt),
        },
      }
    )
  }

  await runClickHouseMigrations()

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    return NextResponse.json(
      { success: false, error: 'File too large (max 10 GB)' },
      { status: 413 },
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid form data' },
      { status: 400 },
    )
  }

  const file = formData.get('file') as File | null
  if (!file) {
    return NextResponse.json(
      { success: false, error: 'No file provided' },
      { status: 400 },
    )
  }

  const filename = file.name.toLowerCase()

  try {
    // ── Plain text / CSV ──────────────────────────────────────────────────────
    if (filename.endsWith('.txt') || filename.endsWith('.csv')) {
      const jobId       = crypto.randomUUID()
      const totalLines  = contentLength ? Math.floor(parseInt(contentLength) / 60) : 0
      const breach_name = matchBreach(file.name)
      createJob(jobId, totalLines, breach_name)

      runWithProgress(
        jobId,
        file.name,
        () => uploadQueue(async () => {
          setCurrentJob(file.name)
          try {
            return await processTextStream(file.stream(), file.name, jobId)
          } finally {
            setCurrentJob(null)
          }
        }),
      ).catch(console.error)

      return NextResponse.json({
        success:        true,
        jobId,
        streamUrl:      `/api/upload/progress/${jobId}`,
        queue_position: uploadQueue.pendingCount,
      })
    }

    // ── ZIP archive ───────────────────────────────────────────────────────────
    if (filename.endsWith('.zip')) {
      const startAt = Date.now()
      const buffer  = Buffer.from(await file.arrayBuffer())
      const results: ProcessResult[] = []

      await uploadQueue(async () => {
        setCurrentJob(file.name)
        try {
          await processZipBuffer(buffer, result => {
            if (result.imported > 0) results.push(result)
          })
        } finally {
          setCurrentJob(null)
        }
      })

      const totalBreakdown = makeRejectionMap()
      let totalImported = 0
      let totalSkipped  = 0

      for (const r of results) {
        totalImported += r.imported
        totalSkipped  += r.skipped
        for (const [k, v] of Object.entries(r.rejection_breakdown)) {
          totalBreakdown[k as RejectionReason] += v
        }
      }

      logJob({
        source:      'http',
        filename:    file.name,
        status:      'done',
        imported:    totalImported,
        skipped:     totalSkipped,
        duration_ms: Date.now() - startAt,
      })

      const total = totalImported + totalSkipped
      return NextResponse.json({
        success:             true,
        imported:            totalImported,
        skipped:             totalSkipped,
        errors:              0,
        import_pct:          total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0,
        rejection_breakdown: totalBreakdown,
        files:               results.map(r => ({
          filename:    r.filename,
          breach_name: r.breach_name,
          imported:    r.imported,
        })),
        filename: file.name,
      })
    }

    return NextResponse.json(
      { success: false, error: 'Unsupported file type. Upload a .txt, .csv, or .zip file.' },
      { status: 400 },
    )
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 399 tests pass.

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "feat(observability): wire logJob + setCurrentJob into upload route"
```

---

### Task 4: Wire logJob + setCurrentJob into lib/inbox-watcher.ts

**Files:**
- Modify: `lib/inbox-watcher.ts`

Context: Read the file first. Add `setCurrentJob`/`setCurrentJob(null)` inside the `uploadQueue` callback, and `logJob` calls for success and failure.

- [ ] **Step 1: Add imports**

Open `lib/inbox-watcher.ts`. Add two new imports to the existing import block:

```ts
import { uploadQueue, queueSize, setCurrentJob } from '@/lib/upload-queue'
import { logJob } from '@/lib/processing-log'
```

(Replace the existing `import { uploadQueue, queueSize }` line.)

- [ ] **Step 2: Replace the uploadQueue callback**

Find the existing `uploadQueue(async () => { ... })` call. Replace the entire callback with:

```ts
        uploadQueue(async () => {
          const startAt = Date.now()
          console.log(`[inbox-watcher] processing: ${filename}`)
          setCurrentJob(filename)
          // Accumulate totals across all ZIP entries (or single file)
          let imported = 0
          let skipped  = 0
          try {
            if (ext === '.zip') {
              await processZipFile(filePath, result => {
                imported += result.imported
                skipped  += result.skipped
                if (result.imported > 0) {
                  console.log(
                    `[inbox-watcher]   ${result.filename}: ` +
                    `imported=${result.imported} skipped=${result.skipped}`
                  )
                }
              })
            } else {
              const nodeStream = fs.createReadStream(filePath)
              const webStream  = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
              const result     = await processTextStream(webStream, filename)
              imported = result.imported
              skipped  = result.skipped
              console.log(
                `[inbox-watcher] done: ${filename} ` +
                `imported=${result.imported} skipped=${result.skipped}`
              )
            }
            logJob({
              source:      'inbox',
              filename,
              status:      'done',
              imported,
              skipped,
              duration_ms: Date.now() - startAt,
            })
            fs.renameSync(filePath, path.join(DONE, filename))
          } catch (err) {
            console.error(`[inbox-watcher] failed: ${filename}`, err)
            logJob({
              source:        'inbox',
              filename,
              status:        'failed',
              imported,
              skipped,
              duration_ms:   Date.now() - startAt,
              error_message: err instanceof Error ? err.message : String(err),
            })
            try { fs.renameSync(filePath, path.join(FAIL, filename)) } catch {}
          } finally {
            setCurrentJob(null)
          }
        })
```

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: 399 tests pass.

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/inbox-watcher.ts
git commit -m "feat(observability): wire logJob + setCurrentJob into inbox watcher"
```

---

### Task 5: QueueStatusPanel in app/upload/page.tsx

**Files:**
- Modify: `app/upload/page.tsx`

Context: Read the current file. The panel is a self-contained component added at the end of the file (before or after `ParseSamplePanel`) and mounted in the JSX between the success/error section and the Format Reference card.

- [ ] **Step 1: Add Activity and Clock to lucide-react imports**

Find the existing lucide-react import line at the top of the file:

```ts
import { Upload, FileText, FileArchive, CheckCircle, AlertCircle, Loader2, X, TrendingDown, FlaskConical, CheckCheck, XCircle, ChevronDown, ChevronUp } from "lucide-react"
```

Replace with:

```ts
import { Upload, FileText, FileArchive, CheckCircle, AlertCircle, Loader2, X, TrendingDown, FlaskConical, CheckCheck, XCircle, ChevronDown, ChevronUp, Activity, Clock, Inbox } from "lucide-react"
```

- [ ] **Step 2: Add QueueStatusPanel component**

Add this entire component to the **end of the file**, after the closing `}` of `ParseSamplePanel` and before the final export closing:

```tsx
// ─── Queue Status Panel ───────────────────────────────────────────────────────

interface QueueJob {
  id:            number
  source:        'http' | 'inbox'
  filename:      string
  status:        'done' | 'failed'
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  breach_name:   string | null
  created_at:    string
}

interface QueueStatus {
  queue: {
    active:       number
    pending:      number
    current_file: string | null
  }
  recent: QueueJob[]
  totals: {
    files_done:    number
    files_failed:  number
    rows_imported: number
    rows_skipped:  number
  }
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

function QueueStatusPanel() {
  const [open, setOpen]       = useState(true)
  const [data, setData]       = useState<QueueStatus | null>(null)
  const [error, setError]     = useState(false)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch('/api/upload/queue-status')
        if (!res.ok) { setError(true); return }
        const json = await res.json()
        if (!cancelled) { setData(json); setError(false) }
      } catch {
        if (!cancelled) setError(true)
      }
    }

    poll()
    const id = setInterval(poll, 3_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const isActive = (data?.queue.active ?? 0) > 0 || (data?.queue.pending ?? 0) > 0

  const summary = data
    ? `${fmtRows(data.totals.rows_imported)} rows · ${data.totals.files_done} files · ${data.totals.files_failed} failed`
    : 'Loading…'

  return (
    <Card className="mt-6">
      <CardHeader
        className="cursor-pointer select-none py-3"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className={`h-4 w-4 ${isActive ? 'text-green-500 animate-pulse' : 'text-muted-foreground'}`} />
            <CardTitle className="text-base">Processing Queue</CardTitle>
            {isActive && (
              <Badge variant="outline" className="text-xs text-green-600 border-green-500/40">
                ● Live
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!open && <span className="text-xs text-muted-foreground">{summary}</span>}
            {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 pb-4 space-y-3">
          {error && (
            <p className="text-xs text-muted-foreground">Could not load queue status.</p>
          )}

          {data && (
            <>
              {/* Current state */}
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <div className="flex items-center gap-1.5">
                  {isActive
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-green-500" />
                    : <span className="h-3.5 w-3.5 flex items-center justify-center text-muted-foreground">○</span>
                  }
                  <span className={isActive ? 'text-green-600 dark:text-green-400 font-medium' : 'text-muted-foreground'}>
                    {isActive ? 'Processing' : 'Idle'}
                  </span>
                </div>
                {data.queue.current_file && (
                  <span className="text-xs font-mono text-muted-foreground truncate max-w-xs" title={data.queue.current_file}>
                    {data.queue.current_file}
                    {data.queue.pending > 0 && (
                      <span className="ml-2 text-muted-foreground">+{data.queue.pending} waiting</span>
                    )}
                  </span>
                )}
              </div>

              {/* Lifetime totals */}
              <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                <span><span className="font-medium text-foreground">{fmtRows(data.totals.rows_imported)}</span> rows imported</span>
                <span><span className="font-medium text-foreground">{data.totals.files_done}</span> files done</span>
                {data.totals.files_failed > 0 && (
                  <span className="text-red-500"><span className="font-medium">{data.totals.files_failed}</span> failed</span>
                )}
              </div>

              {/* Recent jobs */}
              {data.recent.length > 0 && (
                <div className="space-y-0.5 max-h-52 overflow-y-auto">
                  {data.recent.map(job => (
                    <div key={job.id} className="flex items-center gap-2 text-xs py-0.5">
                      {job.status === 'done'
                        ? <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                        : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                      }
                      <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                        {job.source === 'http' ? 'http' : <Inbox className="h-2.5 w-2.5" />}
                      </Badge>
                      <span className="font-mono truncate flex-1 text-muted-foreground" title={job.filename}>
                        {job.filename}
                      </span>
                      {job.status === 'done' ? (
                        <>
                          <span className="tabular-nums shrink-0">{fmtRows(job.imported)} rows</span>
                          <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                          </span>
                        </>
                      ) : (
                        <span className="text-red-500 truncate max-w-[200px]" title={job.error_message ?? ''}>
                          {job.error_message ?? 'failed'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {data.recent.length === 0 && (
                <p className="text-xs text-muted-foreground">No jobs processed yet.</p>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
```

- [ ] **Step 3: Mount QueueStatusPanel in the JSX**

Find the Format Reference card (search for `{/* Format guide */}` or `<Card className="mt-6">`). Insert `<QueueStatusPanel />` immediately **before** that card:

```tsx
      {/* Queue status — always visible for admins */}
      <QueueStatusPanel />

      {/* Format guide */}
      <Card className="mt-6">
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0. If there are errors about `Activity`, `Clock`, or `Inbox` not existing in lucide-react, check available icon names with: `grep -r "export.*Activity\|export.*Clock\|export.*Inbox" node_modules/lucide-react/dist/esm/ | head -5`. If an icon is missing, substitute: `Activity` → `Zap`, `Inbox` → `FolderInput`, `Clock` → `Timer`.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: 399 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/upload/page.tsx
git commit -m "feat(observability): QueueStatusPanel with live polling on upload page"
```

---

### Task 6: Final verification + push

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected:
```
Test Files  10 passed (10)
     Tests  399 passed (399)
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Verify git log**

```bash
git log --oneline -6
```

Expected:
```
<sha>  feat(observability): QueueStatusPanel with live polling on upload page
<sha>  feat(observability): wire logJob + setCurrentJob into inbox watcher
<sha>  feat(observability): wire logJob + setCurrentJob into upload route
<sha>  feat(observability): setCurrentJob/getCurrentJob + queue-status API
<sha>  feat(observability): processing_jobs table + logJob helper
```

- [ ] **Step 4: Push**

```bash
git push
```

---

## What you get after this is implemented

**From the browser at `/upload`:**
- A "Processing Queue" card is always visible (can be collapsed to a single line)
- While idle: shows lifetime totals — `2.4M rows · 847 files · 3 failed`
- While processing: pulses green, shows current filename + `+N waiting`
- Recent completions: filename, rows imported, duration, source badge
- Failed files: shown in red with the error message

**From the terminal (for scripted drops):**
```bash
# Drop 500 files and walk away
cp /mnt/nas/stealer_logs/*.txt ./inbox/

# Come back the next morning and check via curl:
curl -s -H "Cookie: ..." http://localhost:3000/api/upload/queue-status | jq '.totals'
# → { files_done: 498, files_failed: 2, rows_imported: 4821039, rows_skipped: 192847 }

# Or just open the browser — the panel shows everything
```
