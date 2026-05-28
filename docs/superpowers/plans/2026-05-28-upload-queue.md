# Upload Queue System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side FIFO upload queue (pLimit(1)), stream ZIP entries one-at-a-time via yauzl, support multi-file selection in the browser UI, and auto-process files dropped into an `./inbox/` folder.

**Architecture:** A `pLimit(1)` singleton in `lib/upload-queue.ts` serialises all uploads — HTTP and inbox alike — so only one file streams at a time regardless of how many arrive concurrently. Processing logic is extracted from the route into `lib/upload-processor.ts` so both the HTTP handler and the inbox watcher share the same pipeline. The browser UI accepts `multiple` files and loops through them serially, waiting for each SSE `done` event before POSTing the next.

**Tech Stack:** Next.js 14, better-sqlite3, ClickHouse JS client, p-limit (already installed), yauzl (already installed), chokidar v4 (new dep), Vitest

---

## File Map

| File | Action |
|---|---|
| `lib/upload-queue.ts` | **Create** — `pLimit(1)` singleton + `queueSize()` helper |
| `lib/upload-processor.ts` | **Create** — extract `insertBatch`, `recordSource`, `processTextStream` from route; add `processZipBuffer` (yauzl) |
| `app/api/upload/route.ts` | **Modify** — import from processor+queue; add queue guard to txt/csv; replace JSZip with `processZipBuffer`; remove moved functions |
| `lib/upload-jobs.ts` | **Modify** — fix hardcoded breakdown to use `makeRejectionMap()` |
| `app/upload/page.tsx` | **Modify** — multi-file queue state, serial SSE loop, queue progress badge |
| `lib/inbox-watcher.ts` | **Create** — chokidar v4 watcher on `./inbox/`; moves processed files to `done/`/`failed/` |
| `instrumentation.ts` | **Modify** — start inbox watcher alongside monitor rescan cron |
| `__tests__/upload-queue.test.ts` | **Create** — queue serialization unit tests |

---

### Task 1: Install chokidar + create lib/upload-queue.ts + tests

**Files:**
- Create: `lib/upload-queue.ts`
- Create: `__tests__/upload-queue.test.ts`

- [ ] **Step 1: Install chokidar**

```bash
npm install chokidar@^4
```

Expected: `package.json` gains `"chokidar": "^4.x.x"`.

- [ ] **Step 2: Write the failing test**

Create `__tests__/upload-queue.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { uploadQueue, queueSize } from '@/lib/upload-queue'

describe('uploadQueue', () => {
  test('runs tasks one at a time — second task waits for first', async () => {
    const order: number[] = []
    let resolveFirst!: () => void

    const task1 = uploadQueue(
      () => new Promise<void>(r => { resolveFirst = r }).then(() => { order.push(1) })
    )
    // queue task2 while task1 is still pending
    const task2 = uploadQueue(async () => { order.push(2) })

    // Neither has finished yet — task1 is running, task2 is pending
    expect(order).toEqual([])

    resolveFirst()
    await task1
    await task2

    // Must be sequential, not interleaved
    expect(order).toEqual([1, 2])
  })

  test('queueSize counts active + pending work', async () => {
    let resolveFirst!: () => void

    const task1 = uploadQueue(
      () => new Promise<void>(r => { resolveFirst = r })
    )
    // Enqueue a second task so pendingCount > 0
    uploadQueue(async () => {})

    expect(queueSize()).toBeGreaterThanOrEqual(1)

    resolveFirst()
    await task1
  })

  test('concurrency is 1 — activeCount never exceeds 1', async () => {
    let maxActive = 0
    const tasks = Array.from({ length: 5 }, (_, i) =>
      uploadQueue(async () => {
        maxActive = Math.max(maxActive, uploadQueue.activeCount)
        await new Promise(r => setTimeout(r, 5))
      })
    )
    await Promise.all(tasks)
    expect(maxActive).toBe(1)
  })
})
```

- [ ] **Step 3: Run test to confirm it fails**

```bash
npm test -- __tests__/upload-queue.test.ts
```

Expected: `FAIL` — `uploadQueue` not defined.

- [ ] **Step 4: Implement lib/upload-queue.ts**

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
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
npm test -- __tests__/upload-queue.test.ts
```

Expected:
```
✓ upload-queue > runs tasks one at a time
✓ upload-queue > queueSize counts active + pending work
✓ upload-queue > concurrency is 1 — activeCount never exceeds 1
Test Files  1 passed (1)
     Tests  3 passed (3)
```

- [ ] **Step 6: Commit**

```bash
git add lib/upload-queue.ts __tests__/upload-queue.test.ts package.json package-lock.json
git commit -m "feat(queue): add pLimit(1) upload queue + chokidar dependency"
```

---

### Task 2: Create lib/upload-processor.ts

**Files:**
- Create: `lib/upload-processor.ts`
- Modify: `lib/upload-jobs.ts` (line 38 — fix hardcoded breakdown)

Context: `insertBatch`, `recordSource`, and `processTextStream` currently live inside `app/api/upload/route.ts` — a Next.js API route. The inbox watcher (Task 5) cannot import from a route file. This task extracts those functions into `lib/upload-processor.ts` and adds `processZipBuffer` (yauzl-based, replaces JSZip). The route and the watcher both import from this shared module.

- [ ] **Step 1: Fix upload-jobs.ts hardcoded breakdown**

In `lib/upload-jobs.ts` line 38, the `createJob` function initialises `rejection_breakdown` with a hardcoded object that misses the `dedup` key added in a prior commit. Fix it to use `makeRejectionMap()`.

Open `lib/upload-jobs.ts`. At the top, add the import:

```ts
import { makeRejectionMap } from '@/lib/ulp-parser'
```

Replace line 38:
```ts
    rejection_breakdown: { blank: 0, no_fields: 0, no_password: 0 },
```
With:
```ts
    rejection_breakdown: makeRejectionMap(),
```

- [ ] **Step 2: Create lib/upload-processor.ts**

```ts
/**
 * Shared upload processing pipeline.
 *
 * Used by both the HTTP upload route (app/api/upload/route.ts) and the inbox
 * folder watcher (lib/inbox-watcher.ts).  Keeps ClickHouse insertion, source
 * recording, and parsing logic in one place.
 */

import { Readable } from 'stream'
import yauzl from 'yauzl'
import {
  parseULPStream,
  makeRejectionMap,
  type ULPCredential,
  type RejectionReason,
} from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { invalidateStatsCache } from '@/lib/stats-cache'
import { updateJob } from '@/lib/upload-jobs'

// ─── Public result type ───────────────────────────────────────────────────────

export interface ProcessResult {
  imported:            number
  skipped:             number
  errors:              number
  filename:            string
  breach_name:         string
  rejection_breakdown: Record<RejectionReason, number>
}

// ─── ClickHouse helpers ───────────────────────────────────────────────────────

/** Escape a value for ClickHouse CSV: wrap in double-quotes, double internal quotes. */
function csvField(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * Insert a batch into ClickHouse as a streaming CSV Readable.
 * Generator yields one row at a time — no large string materialised in heap.
 */
export async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
): Promise<void> {
  if (credentials.length === 0) return
  const chClient = getClient()

  const readable = Readable.from(
    (function* () {
      for (const c of credentials) {
        yield [
          csvField(c.url),
          csvField(c.email),
          csvField(c.password),
          csvField(c.domain),
          csvField(c.source_file),
          csvField(breach_name),
        ].join(',') + '\n'
      }
    })(),
    { objectMode: false },
  )

  await chClient.insert({
    table: 'ulp.credentials',
    columns: ['url', 'email', 'password', 'domain', 'source_file', 'breach_name'],
    values: readable,
    format: 'CSV',
    clickhouse_settings: {
      async_insert:          1 as any,
      wait_for_async_insert: 1 as any,
      max_execution_time:    0,
    },
  })
}

export async function recordSource(filename: string, lineCount: number): Promise<void> {
  const chClient = getClient()
  await chClient.insert({
    table: 'ulp.sources',
    values: [{ filename, line_count: lineCount }],
    format: 'JSONEachRow',
  })
}

// ─── Text stream processor ────────────────────────────────────────────────────

/**
 * Stream-process a .txt or .csv file.
 *
 * Reads in 500K-row batches — peak RAM is ~200 MB regardless of file size.
 * Pass jobId to push live progress via the in-memory SSE job store.
 */
export async function processTextStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  jobId?: string,
): Promise<ProcessResult> {
  const breach_name        = matchBreach(filename)
  let imported             = 0
  let skipped              = 0
  const rejection_breakdown = makeRejectionMap()

  for await (const batch of parseULPStream(stream, filename, 500_000)) {
    await insertBatch(batch.credentials, breach_name)
    imported += batch.credentials.length
    skipped  += batch.rejected
    for (const [k, v] of Object.entries(batch.breakdown)) {
      rejection_breakdown[k as RejectionReason] =
        (rejection_breakdown[k as RejectionReason] ?? 0) + v
    }
    if (jobId) updateJob(jobId, { imported, skipped })
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    invalidateStatsCache()
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown }
}

// ─── ZIP processor (yauzl — lazy entry streaming) ────────────────────────────

/**
 * Process a ZIP buffer by streaming its .txt/.csv entries one at a time.
 *
 * yauzl with lazyEntries:true decompresses entries lazily — only one entry
 * lives in memory at once.  Peak RAM ≈ one entry's 500K-row batch (≈200 MB),
 * not the full decompressed archive size.
 *
 * onEntry is called after each successfully processed entry so the caller can
 * accumulate results incrementally.
 */
export async function processZipBuffer(
  buffer: Buffer,
  onEntry: (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)

      zipfile.readEntry()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        // Skip directory entries
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

        const lp = entry.fileName.toLowerCase()
        if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) { reject(streamErr); return }

          const entryName = entry.fileName.split('/').pop() || entry.fileName
          // Convert Node.js Readable → Web ReadableStream for processTextStream
          const webStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>

          processTextStream(webStream, entryName)
            .then(result => { onEntry(result); zipfile.readEntry() })
            .catch(reject)
        })
      })

      zipfile.on('end', resolve)
      zipfile.on('error', reject)
    })
  })
}
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: all existing tests still pass (389+). No test exercises the processor directly yet — that comes in Task 3.

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add lib/upload-processor.ts lib/upload-jobs.ts
git commit -m "feat(processor): extract upload pipeline into shared lib + yauzl ZIP streaming"
```

---

### Task 3: Refactor app/api/upload/route.ts

**Files:**
- Modify: `app/api/upload/route.ts`

Context: Replace the current file wholesale. Functions that moved to `lib/upload-processor.ts` (`insertBatch`, `recordSource`, `processTextStream`, `csvField`, `processTextContent`) are deleted. JSZip is removed. The txt/csv path gains a `uploadQueue()` wrapper. The ZIP path uses `processZipBuffer`. The `JSZip` import and the old `processTextContent` function are gone.

- [ ] **Step 1: Replace app/api/upload/route.ts**

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { makeRejectionMap, type RejectionReason } from '@/lib/ulp-parser'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue } from '@/lib/upload-queue'
import { processTextStream, processZipBuffer, type ProcessResult } from '@/lib/upload-processor'

export const dynamic = 'force-dynamic'

// 5 minutes — large uploads (GBs of text) need sustained time.
export const maxDuration = 300

// 10 GB per file maximum.
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024

// ─── SSE progress wrapper ─────────────────────────────────────────────────────

/**
 * Wraps a processing function with SSE progress events.
 * Pushes a heartbeat every 2 s; pushes a final event on done/error.
 */
async function runWithProgress(
  jobId: string,
  fn: () => Promise<ProcessResult>,
): Promise<void> {
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
  } catch (err) {
    updateJob(jobId, {
      status: 'error',
      error:  err instanceof Error ? err.message : 'Upload failed',
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
  } finally {
    clearInterval(interval)
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

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
    // Fire-and-forget: return jobId immediately; SSE stream delivers progress.
    // uploadQueue serialises concurrent submissions — only one stream at a time.
    if (filename.endsWith('.txt') || filename.endsWith('.csv')) {
      const jobId      = crypto.randomUUID()
      const totalLines = contentLength ? Math.floor(parseInt(contentLength) / 60) : 0
      const breach_name = matchBreach(file.name)
      createJob(jobId, totalLines, breach_name)

      runWithProgress(
        jobId,
        () => uploadQueue(() => processTextStream(file.stream(), file.name, jobId)),
      ).catch(console.error)

      return NextResponse.json({
        success:        true,
        jobId,
        streamUrl:      `/api/upload/progress/${jobId}`,
        queue_position: uploadQueue.pendingCount,
      })
    }

    // ── ZIP archive ───────────────────────────────────────────────────────────
    // Blocks the HTTP response until fully processed (maxDuration = 300 s).
    // yauzl streams each .txt/.csv entry lazily — only one entry in memory at a
    // time, so a 2 GB ZIP does not spike RAM.
    if (filename.endsWith('.zip')) {
      const buffer  = Buffer.from(await file.arrayBuffer())
      const results: ProcessResult[] = []

      await uploadQueue(() =>
        processZipBuffer(buffer, result => {
          if (result.imported > 0) results.push(result)
        }),
      )

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

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass (389+).

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "refactor(upload): queue guard + yauzl ZIP streaming, remove JSZip"
```

---

### Task 4: Multi-file UI — app/upload/page.tsx

**Files:**
- Modify: `app/upload/page.tsx`

Context: The current page processes one file at a time via a single `processFile(file)` call. This task rewires it to accept multiple files, display a queue badge ("File 2 of 5"), and loop through files serially — each file waits for its SSE `done` event before the next starts. The existing success/error/progress JSX is reused unchanged; only state management and the progress header change.

- [ ] **Step 1: Add queue state variables and processing ref**

Find the existing `useState` block (lines ~49–58) and extend it:

```ts
  const [state, setState] = useState<UploadState>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const [liveImported, setLiveImported] = useState(0)
  const [liveSkipped, setLiveSkipped]   = useState(0)
  const [livePct, setLivePct]           = useState(0)
  const [elapsedMs, setElapsedMs]       = useState(0)
  const eventSourceRef                  = useRef<EventSource | null>(null)

  // ── Queue state (new) ──────────────────────────────────────────────────────
  const [fileQueue, setFileQueue]     = useState<File[]>([])
  const [queueIndex, setQueueIndex]   = useState(0)
  const [allResults, setAllResults]   = useState<UploadResult[]>([])
  const isProcessingRef               = useRef(false)

  const inputRef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 2: Replace processFile with processFileSingle (returns Promise)**

Delete the old `processFile` `useCallback` entirely. Replace it with `processFileSingle`:

```ts
  /**
   * Process a single file. Returns a Promise that resolves when the file is
   * fully done (SSE done/error for text files; sync response for ZIPs).
   * Always resolves — never rejects — so the queue loop continues on errors.
   */
  const processFileSingle = useCallback((file: File): Promise<void> => {
    return new Promise<void>((resolve) => {
      const ext = file.name.toLowerCase()
      if (!ext.endsWith('.txt') && !ext.endsWith('.csv') && !ext.endsWith('.zip')) {
        resolve()
        return
      }

      setState('uploading')
      setProgress(20)
      setResult(null)
      setErrorMsg('')

      const formData = new FormData()
      formData.append('file', file)

      fetch('/api/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then((data: any) => {
          setProgress(90)
          if (!data.success) throw new Error(data.error || 'Upload failed')

          if (data.jobId) {
            // SSE path — resolve when server signals done or error
            setLiveImported(0); setLiveSkipped(0); setLivePct(0); setElapsedMs(0)
            const es = new EventSource(`/api/upload/progress/${data.jobId}`)
            eventSourceRef.current = es

            es.onmessage = (e: MessageEvent) => {
              const d = JSON.parse(e.data)
              setLiveImported(d.imported ?? 0)
              setLiveSkipped(d.skipped   ?? 0)
              setLivePct(d.pct           ?? 0)
              setElapsedMs(d.elapsed_ms  ?? 0)

              if (d.status === 'done') {
                const r: UploadResult = {
                  imported:            d.imported,
                  skipped:             d.skipped,
                  errors:              0,
                  filename:            file.name,
                  breach_name:         '',
                  rejection_breakdown: d.rejection_breakdown ?? {},
                }
                setResult(r)
                setAllResults(prev => [...prev, r])
                es.close()
                resolve()
              }
              if (d.status === 'error') {
                setErrorMsg(d.error || 'Upload failed')
                setState('error')
                toast({ title: d.error || 'Upload failed', variant: 'destructive' })
                es.close()
                resolve()
              }
            }
            es.onerror = () => { es.close(); resolve() }
          } else {
            // Sync path (ZIP)
            const r = data as UploadResult
            setResult(r)
            setAllResults(prev => [...prev, r])
            resolve()
          }
        })
        .catch(err => {
          setErrorMsg(err instanceof Error ? err.message : 'Upload failed')
          setState('error')
          setProgress(0)
          resolve()
        })
    })
  }, [toast])
```

- [ ] **Step 3: Add processQueue**

Add this `useCallback` immediately after `processFileSingle`:

```ts
  /** Enqueue multiple files and process them one at a time. */
  const processQueue = useCallback(async (files: File[]) => {
    if (isProcessingRef.current) return
    const valid = files.filter(f => f.name.match(/\.(txt|csv|zip)$/i))
    if (valid.length === 0) {
      toast({ title: 'No supported files selected (.txt, .csv, .zip)', variant: 'destructive' })
      return
    }

    isProcessingRef.current = true
    setFileQueue(valid)
    setAllResults([])
    setQueueIndex(0)

    for (let i = 0; i < valid.length; i++) {
      setQueueIndex(i)
      await processFileSingle(valid[i])
    }

    setState('success')
    isProcessingRef.current = false
  }, [processFileSingle, toast])
```

- [ ] **Step 4: Update handleDrop and handleFileInput**

Replace the two existing handlers:

```ts
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) processQueue(files)
  }, [processQueue])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) processQueue(files)
    e.target.value = ''
  }, [processQueue])
```

- [ ] **Step 5: Update reset to clear queue state**

Replace the existing `reset` function:

```ts
  const reset = () => {
    setState('idle')
    setProgress(0)
    setResult(null)
    setErrorMsg('')
    setFileQueue([])
    setQueueIndex(0)
    setAllResults([])
    isProcessingRef.current = false
  }
```

- [ ] **Step 6: Add `multiple` to file input + update drop zone text**

Find the `<input>` tag inside the drop zone Card (around line 213–218):

```tsx
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".txt,.csv,.zip"
              className="hidden"
              onChange={handleFileInput}
            />
```

Update the drop zone text lines (around lines 203–204):
```tsx
            <p className="text-lg font-medium">Drop files here or click to browse</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Select multiple files — processed one at a time in order
            </p>
```

- [ ] **Step 7: Add queue badge to the uploading card**

Find the uploading `<Card>` (around lines 225–251). Inside `<CardContent>`, add the queue badge as the very first child:

```tsx
      {state === 'uploading' && (
        <Card>
          <CardContent className="p-6 space-y-4">
            {/* Queue position badge */}
            {fileQueue.length > 1 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono truncate max-w-[200px]" title={fileQueue[queueIndex]?.name}>
                  {fileQueue[queueIndex]?.name}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {queueIndex + 1} / {fileQueue.length}
                </Badge>
              </div>
            )}
            {/* existing spinner + progress bar unchanged below */}
            <div className="flex items-center justify-between text-sm">
```

- [ ] **Step 8: Update success section to show aggregate results**

The success section currently renders when `state === 'success' && result`. Replace the condition and add aggregate computation at the top of the success card:

Find the line `{state === 'success' && result && (` and replace the entire success Card with:

```tsx
      {state === 'success' && allResults.length > 0 && (() => {
        // Aggregate results across all queued files
        const totalImported = allResults.reduce((s, r) => s + r.imported, 0)
        const totalSkipped  = allResults.reduce((s, r) => s + r.skipped,  0)
        const totalErrors   = allResults.reduce((s, r) => s + r.errors,   0)
        const mergedBreakdown = allResults.reduce((acc, r) => {
          for (const [k, v] of Object.entries(r.rejection_breakdown ?? {}))
            acc[k] = (acc[k] ?? 0) + v
          return acc
        }, {} as Record<string, number>)
        const total      = totalImported + totalSkipped
        const import_pct = total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0
        // For multi-file: collect per-file rows for the files table
        const fileRows = allResults.length > 1
          ? allResults.flatMap(r =>
              r.files ?? [{ filename: r.filename, breach_name: r.breach_name ?? '', imported: r.imported }]
            )
          : allResults[0].files
        const displayResult: UploadResult = {
          imported:            totalImported,
          skipped:             totalSkipped,
          errors:              totalErrors,
          import_pct,
          filename:            allResults.length === 1
                                 ? allResults[0].filename
                                 : `${allResults.length} files`,
          breach_name:         allResults.length === 1 ? allResults[0].breach_name : undefined,
          rejection_breakdown: mergedBreakdown,
          files:               fileRows,
        }

        return (
          <Card className="border-green-500/30 bg-green-500/5">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                <CardTitle className="text-green-600 dark:text-green-400">Import complete</CardTitle>
              </div>
              <CardDescription className="flex items-center gap-2 flex-wrap">
                <span>{displayResult.filename}</span>
                {displayResult.breach_name && (
                  <Badge variant="outline" className="text-xs">{displayResult.breach_name}</Badge>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <StatBox label="Imported" value={displayResult.imported.toLocaleString()} color="green" />
                <StatBox label="Skipped"  value={displayResult.skipped.toLocaleString()}  color="yellow" />
                <StatBox label="Errors"   value={displayResult.errors.toLocaleString()}   color="red" />
              </div>

              {displayResult.import_pct !== undefined && (
                <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-muted-foreground">Import rate</span>
                      <span className={`text-sm font-semibold tabular-nums ${
                        import_pct >= 80 ? 'text-green-600 dark:text-green-400'
                        : import_pct >= 50 ? 'text-yellow-600 dark:text-yellow-400'
                        : 'text-red-600 dark:text-red-400'
                      }`}>
                        {import_pct}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          import_pct >= 80 ? 'bg-green-500'
                          : import_pct >= 50 ? 'bg-yellow-500'
                          : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(100, import_pct)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {displayResult.rejection_breakdown && displayResult.skipped > 0 && (() => {
                const rejTotal    = displayResult.imported + displayResult.skipped
                const rejections  = topRejections(displayResult.rejection_breakdown, rejTotal)
                if (rejections.length === 0) return null
                return (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground font-medium">Why lines were skipped</p>
                    </div>
                    <div className="space-y-1.5">
                      {rejections.map(r => (
                        <div key={r.reason} className="flex items-center gap-2 text-xs">
                          <div className="w-24 shrink-0">
                            <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-orange-400/70" style={{ width: `${Math.min(100, r.pct)}%` }} />
                            </div>
                          </div>
                          <span className="tabular-nums text-muted-foreground shrink-0 w-10 text-right">{r.pct}%</span>
                          <span className="text-muted-foreground truncate">{r.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}

              {displayResult.files && displayResult.files.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Files imported ({displayResult.files.length}):
                  </p>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {displayResult.files.map(f => (
                      <div key={f.filename} className="flex items-center gap-2 text-xs py-0.5">
                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="font-mono truncate flex-1" title={f.filename}>{f.filename}</span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {f.imported.toLocaleString()} rows
                        </span>
                        {f.breach_name && (
                          <Badge variant="outline" className="text-xs shrink-0">{f.breach_name}</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button onClick={reset} variant="outline">Upload more</Button>
                <Button asChild>
                  <Link href="/credentials">Search credentials</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })()}
```

- [ ] **Step 9: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 10: Run full test suite**

```bash
npm test
```

Expected: all tests pass (392+).

- [ ] **Step 11: Commit**

```bash
git add app/upload/page.tsx
git commit -m "feat(upload-ui): multi-file queue with serial SSE processing and aggregate results"
```

---

### Task 5: lib/inbox-watcher.ts + instrumentation.ts

**Files:**
- Create: `lib/inbox-watcher.ts`
- Modify: `instrumentation.ts`

Context: The inbox watcher watches `./inbox/` for `.txt`, `.csv`, and `.zip` files. Any file that appears is queued through `uploadQueue` (shared with HTTP uploads — they don't compete). On success the file is moved to `./inbox/done/`; on failure to `./inbox/failed/`. It starts in `instrumentation.ts` alongside the monitor rescan cron (production only, prevents hot-reload duplication).

- [ ] **Step 1: Create lib/inbox-watcher.ts**

```ts
/**
 * Inbox folder watcher.
 *
 * Drop .txt, .csv, or .zip files into ./inbox/ and they are processed
 * automatically through the same streaming pipeline as the HTTP upload API.
 *
 * Directory layout (auto-created on startup):
 *   ./inbox/         — place files here
 *   ./inbox/done/    — successfully processed files are moved here
 *   ./inbox/failed/  — failed files are moved here
 *
 * Uses the global uploadQueue (pLimit(1)) so inbox jobs and HTTP uploads
 * share the same single-at-a-time constraint and never compete for RAM.
 */

import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import { uploadQueue, queueSize } from '@/lib/upload-queue'
import { processTextStream, processZipBuffer } from '@/lib/upload-processor'

const INBOX = path.resolve('./inbox')
const DONE  = path.resolve('./inbox/done')
const FAIL  = path.resolve('./inbox/failed')

let started = false

export function startInboxWatcher(): void {
  if (started) return
  started = true

  // Ensure directories exist before the watcher starts
  ;[INBOX, DONE, FAIL].forEach(d => fs.mkdirSync(d, { recursive: true }))

  console.log(`[inbox-watcher] started — watching ${INBOX}`)

  // Dynamic import keeps chokidar out of the client bundle (tree-shaking safe)
  import('chokidar')
    .then(mod => {
      const { watch } = mod as typeof import('chokidar')

      watch(INBOX, {
        persistent:    true,
        ignoreInitial: false,  // process files already in inbox on startup
        depth:         0,      // only watch root of inbox/, not subdirectories
      }).on('add', (filePath: string) => {
        // Filter to supported extensions in the event handler (v4 dropped glob support)
        const ext = path.extname(filePath).toLowerCase()
        if (!['.txt', '.csv', '.zip'].includes(ext)) return

        // Ignore files already in done/ or failed/ (chokidar depth:0 should prevent
        // this, but guard defensively against any edge-case re-trigger)
        if (filePath.startsWith(DONE) || filePath.startsWith(FAIL)) return

        const filename = path.basename(filePath)
        console.log(`[inbox-watcher] queued: ${filename} (queue: ${queueSize()})`)

        uploadQueue(async () => {
          console.log(`[inbox-watcher] processing: ${filename}`)
          try {
            if (ext === '.zip') {
              const buffer = Buffer.from(fs.readFileSync(filePath))
              await processZipBuffer(buffer, result => {
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
              console.log(
                `[inbox-watcher] done: ${filename} ` +
                `imported=${result.imported} skipped=${result.skipped}`
              )
            }
            // Move to done/ — rename is atomic on same filesystem
            fs.renameSync(filePath, path.join(DONE, filename))
          } catch (err) {
            console.error(`[inbox-watcher] failed: ${filename}`, err)
            try { fs.renameSync(filePath, path.join(FAIL, filename)) } catch {}
          }
        })
      }).on('error', (err: Error) => {
        console.error('[inbox-watcher] watcher error:', err)
      })
    })
    .catch(err => {
      console.error('[inbox-watcher] failed to load chokidar:', err)
    })
}
```

- [ ] **Step 2: Wire inbox watcher into instrumentation.ts**

Open `instrumentation.ts`. Inside the `if (process.env.NODE_ENV === 'production')` block, add the inbox watcher start after `startMonitorRescanCron()`:

```ts
    // Start scheduled monitor re-scanner (production only — prevents dev hot-reload duplicates)
    if (process.env.NODE_ENV === 'production') {
      try {
        const { startMonitorRescanCron } = await import('./lib/monitor-rescan-cron')
        startMonitorRescanCron()
      } catch (err) {
        console.error('[instrumentation] Monitor rescan cron failed to start:', err)
      }

      try {
        const { startInboxWatcher } = await import('./lib/inbox-watcher')
        startInboxWatcher()
      } catch (err) {
        console.error('[instrumentation] Inbox watcher failed to start:', err)
      }
    }
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: all tests pass (392+).

- [ ] **Step 5: Commit**

```bash
git add lib/inbox-watcher.ts instrumentation.ts
git commit -m "feat(inbox): chokidar folder watcher auto-processes files dropped into ./inbox/"
```

---

### Task 6: Final verification + push

**Files:** None modified.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected:
```
Test Files  8 passed (8)
     Tests  392 passed (392)
```

(389 existing + 3 new queue tests)

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 3: Verify git log**

```bash
git log --oneline -8
```

Expected (most recent first):
```
<sha>  feat(inbox): chokidar folder watcher auto-processes files dropped into ./inbox/
<sha>  feat(upload-ui): multi-file queue with serial SSE processing and aggregate results
<sha>  refactor(upload): queue guard + yauzl ZIP streaming, remove JSZip
<sha>  feat(processor): extract upload pipeline into shared lib + yauzl ZIP streaming
<sha>  feat(queue): add pLimit(1) upload queue + chokidar dependency
```

- [ ] **Step 4: Push**

```bash
git push
```

---

## Usage after deployment

**Multi-file browser upload:**
- Open `/upload` — the file picker now accepts multiple files
- Drag a folder of `.txt` files onto the drop zone, or Ctrl+click to select many
- Progress shows "File N / M: filename.txt" while processing
- Final screen shows aggregate totals

**Inbox folder (bulk/automated):**
```bash
# Copy any number of files — the watcher picks them up one at a time
cp /path/to/dumps/*.txt ./inbox/

# Watch progress in Docker logs
docker compose logs -f app | grep inbox-watcher

# Processed files move to inbox/done/; failed files to inbox/failed/
ls inbox/done/
```
