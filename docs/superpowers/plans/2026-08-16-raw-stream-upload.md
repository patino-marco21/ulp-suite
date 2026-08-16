# Raw-Stream Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `request.formData()` on both upload routes with direct `request.body` streaming, closing the memory-blowup gap measured in the 2026-08-16 ingest pipeline audit and fixing the v1 route's zip-buffering OOM-pattern regression, without changing anything downstream of the request body.

**Architecture:** Both routes read a `?filename=` query parameter instead of a FormData field, and pass `request.body` (already a `ReadableStream<Uint8Array>`) directly into the existing `processTextStream`/`processZipFile` functions, which are unchanged. The browser upload page sends the raw `File` as the request body instead of wrapping it in `FormData`. The `/docs` page's documented example is updated to match.

**Tech Stack:** Next.js 15 (App Router Route Handlers), Vitest, TypeScript.

## Global Constraints

- Clean cutover — no dual multipart/raw-stream support on either route (see `docs/superpowers/specs/2026-08-16-raw-stream-upload-design.md`, Decisions).
- Filename arrives as a `filename` query parameter, already URL-decoded by `URLSearchParams` — never call `decodeURIComponent` on it again.
- Preserve the existing casing split: lowercase the filename only for the `.txt`/`.csv`/`.zip` extension check; pass the original-case filename everywhere else (breach matching, job logging, response body) — exactly as `file.name` / `file.name.toLowerCase()` are split today.
- Response JSON shape is unchanged on both routes.
- Zip stays disk-buffered via the existing `pipeline(Readable.fromWeb(...), fs.createWriteStream(tmpPath))` + `processZipFile(tmpPath, ...)` pattern — do not attempt a no-disk streaming zip parser.

---

## Task 1: Redesign `app/api/upload/route.ts` for raw-stream uploads

**Files:**
- Modify: `app/api/upload/route.ts`
- Create: `__tests__/upload-route-raw-stream.test.ts`

**Interfaces:**
- Consumes: `processTextStream(stream: ReadableStream<Uint8Array>, filename: string, jobId?: string, onBatch?: (imported: number) => void): Promise<ProcessResult>` and `processZipFile(filepath: string, onEntry: (result: ProcessResult) => void): Promise<void>` from `@/lib/upload-processor` — both already exist with these exact signatures, unchanged by this plan.
- Produces: `POST` handler in `app/api/upload/route.ts` reads `filename` from `request.nextUrl.searchParams.get('filename')` and body bytes from `request.body`. Response JSON shape unchanged: `{success, jobId, streamUrl, queue_position}` for `.txt`/`.csv`, `{success, imported, skipped, tierDropped, errors, import_pct, rejection_breakdown, files, filename}` for `.zip`, `{success: false, error}` for all error cases.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/upload-route-raw-stream.test.ts`:

```ts
import { NextRequest } from 'next/server'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ role: 'admin' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/clickhouse-migrations', () => ({
  runClickHouseMigrations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/processing-log', () => ({
  logJob: vi.fn(),
}))
vi.mock('@/lib/upload-processor', () => ({
  processTextStream: vi.fn().mockResolvedValue({
    imported: 1, skipped: 0, errors: 0, filename: 'dump.txt',
    breach_name: 'test', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
  }),
  processZipFile: vi.fn().mockResolvedValue(undefined),
}))

import { processTextStream, processZipFile } from '@/lib/upload-processor'
import { POST } from '@/app/api/upload/route'

const mockProcessTextStream = processTextStream as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>

describe('POST /api/upload — raw-stream body', () => {
  beforeEach(() => {
    mockProcessTextStream.mockClear()
    mockProcessZipFile.mockClear()
  })

  it('rejects a request with no filename query param', async () => {
    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: 'irrelevant body content',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ success: false, error: 'No filename provided' })
  })

  it('rejects an unsupported file extension', async () => {
    const req = new NextRequest('http://localhost/api/upload?filename=dump.exe', {
      method: 'POST',
      body: 'irrelevant body content',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toContain('Unsupported file type')
  })

  it('streams request.body straight into processTextStream with the query-param filename', async () => {
    const req = new NextRequest('http://localhost/api/upload?filename=dump.txt', {
      method: 'POST',
      body: 'https://a.com:user@a.com:pass\n',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.jobId).toBeTruthy()

    // runWithProgress fires processTextStream without the route handler
    // awaiting it — give the queued microtask a turn to run before asserting.
    await new Promise(r => setTimeout(r, 10))

    expect(mockProcessTextStream).toHaveBeenCalledTimes(1)
    const [streamArg, filenameArg, jobIdArg] = mockProcessTextStream.mock.calls[0]
    expect(streamArg).toBeInstanceOf(ReadableStream)
    expect(filenameArg).toBe('dump.txt')
    expect(jobIdArg).toBe(json.jobId)
  })

  it('preserves original filename casing for processing while matching extensions case-insensitively', async () => {
    const req = new NextRequest('http://localhost/api/upload?filename=Mixed-Case-Dump.TXT', {
      method: 'POST',
      body: 'https://a.com:user@a.com:pass\n',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)

    await new Promise(r => setTimeout(r, 10))

    expect(mockProcessTextStream).toHaveBeenCalledTimes(1)
    const [, filenameArg] = mockProcessTextStream.mock.calls[0]
    expect(filenameArg).toBe('Mixed-Case-Dump.TXT')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/upload-route-raw-stream.test.ts`

Expected: all four tests FAIL. The first two will fail because the current code's error paths don't match (`await request.formData()` on a plain string body behaves differently than the new filename-query-param check). The stream/casing tests will fail because `processTextStream` is never called the way the assertions expect — the current code path calls `formData.get('file')`, which is `null` for these requests, so it 400s with `"No file provided"` instead of proceeding.

- [ ] **Step 3: Rewrite the POST handler**

Replace the full contents of `app/api/upload/route.ts` with:

```ts
import fs from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { makeRejectionMap, type RejectionReason } from '@/lib/ulp-parser'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue, setCurrentJob } from '@/lib/upload-queue'
import { processTextStream, processZipFile, type ProcessResult } from '@/lib/upload-processor'
import { checkLimit, getClientIP } from '@/lib/rate-limiter'
import { logJob } from '@/lib/processing-log'

// 60 uploads per IP per 5 minutes — permits batch multi-file uploads while
// still blocking runaway automation.  Admin-only endpoint; session auth is the
// primary gate.  Previously 5/5 min which blocked normal batch use.
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
      tierDropped:         result.tierDropped,
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

  // Rate limit: 60 uploads per IP per 5 minutes
  const ip       = getClientIP(request)
  const rlResult = checkLimit(uploadLimiter, ip, 60, 5 * 60_000)
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

  const originalFilename = request.nextUrl.searchParams.get('filename')
  if (!originalFilename) {
    return NextResponse.json(
      { success: false, error: 'No filename provided' },
      { status: 400 },
    )
  }

  if (!request.body) {
    return NextResponse.json(
      { success: false, error: 'No file data received' },
      { status: 400 },
    )
  }
  const body = request.body

  const filename = originalFilename.toLowerCase()

  try {
    // ── Plain text / CSV ──────────────────────────────────────────────────────
    if (filename.endsWith('.txt') || filename.endsWith('.csv')) {
      const jobId       = crypto.randomUUID()
      const totalLines  = contentLength ? Math.floor(parseInt(contentLength) / 60) : 0
      const breach_name = matchBreach(originalFilename)
      createJob(jobId, totalLines, breach_name)

      runWithProgress(
        jobId,
        originalFilename,
        () => uploadQueue(async () => {
          setCurrentJob(originalFilename)
          try {
            return await processTextStream(body, originalFilename, jobId)
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
      const results: ProcessResult[] = []

      // Stream the upload body to a temp file on disk BEFORE processing.
      // Peak RAM stays at ~200 MB (one 500K-row batch at a time) regardless
      // of archive size — see lib/upload-processor.ts.
      const tmpPath = `/tmp/ulp-zip-${crypto.randomUUID()}.zip`
      let totalErrors = 0
      const failedEntries: string[] = []

      try {
        await pipeline(
          Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>),
          fs.createWriteStream(tmpPath),
        )

        await uploadQueue(async () => {
          setCurrentJob(originalFilename)
          try {
            await processZipFile(tmpPath, result => {
              if (result.imported > 0) results.push(result)
              if (result.errors > 0) {
                totalErrors += result.errors
                failedEntries.push(result.filename)
              }
            })
          } finally {
            setCurrentJob(null)
          }
        })
      } finally {
        fs.unlink(tmpPath, () => {})
      }

      const totalBreakdown = makeRejectionMap()
      let totalImported = 0
      let totalSkipped  = 0
      let totalTierDropped = 0

      for (const r of results) {
        totalImported += r.imported
        totalSkipped  += r.skipped
        totalTierDropped += r.tierDropped
        for (const [k, v] of Object.entries(r.rejection_breakdown)) {
          totalBreakdown[k as RejectionReason] += v
        }
      }

      logJob({
        source:      'http',
        filename:    originalFilename,
        status:      'done',
        imported:    totalImported,
        skipped:     totalSkipped,
        duration_ms: Date.now() - startAt,
        ...(failedEntries.length > 0
          ? { error_message: `${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'} skipped: ${failedEntries.join(', ')}` }
          : {}),
      })

      const total = totalImported + totalSkipped
      return NextResponse.json({
        success:             true,
        imported:            totalImported,
        skipped:             totalSkipped,
        tierDropped:         totalTierDropped,
        errors:              totalErrors,
        import_pct:          total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0,
        rejection_breakdown: totalBreakdown,
        files:               results.map(r => ({
          filename:    r.filename,
          breach_name: r.breach_name,
          imported:    r.imported,
        })),
        filename: originalFilename,
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/upload-route-raw-stream.test.ts`

Expected: all four tests PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: all tests pass (895+ pre-existing, plus the 4 new ones); typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/upload/route.ts __tests__/upload-route-raw-stream.test.ts
git commit -m "fix(upload): stream request.body directly instead of buffering via formData()

app/api/upload/route.ts called await request.formData() before any of the
pipeline's per-batch streaming logic ran -- measured in this session's
ingest pipeline audit at roughly 2x payload size in transient memory before
a single batch is produced, undercutting the zip handler's own ~200MB
peak-RAM claim. Reads request.body (already a ReadableStream) and a
?filename= query param instead; processTextStream/processZipFile are
unchanged.

See docs/superpowers/specs/2026-08-16-raw-stream-upload-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Redesign `app/api/v1/upload/route.ts` for raw-stream uploads

**Files:**
- Modify: `app/api/v1/upload/route.ts`
- Modify: `__tests__/upload-route-raw-stream.test.ts` (append a second `describe` block)

**Interfaces:**
- Consumes: same `processTextStream`/`processZipFile` signatures as Task 1. Also consumes `withApiKeyAuth(request: NextRequest, roles: string[]): Promise<{success: boolean, error?: string, status?: number, apiKey?: ApiKey, rateLimit?: RateLimitInfo}>`, `addRateLimitHeaders(response: NextResponse, rateLimit: RateLimitInfo): NextResponse`, and `logApiRequest(apiKey: ApiKey, request: NextRequest, endpoint: string): Promise<void>` from `@/lib/api-key-auth` — unchanged, already exist.
- Produces: same request-side contract as Task 1 (`?filename=` query param, raw body). Response JSON shape unchanged: `{success, imported, skipped, errors, filename}` for `.txt`/`.csv`, `{success, imported, skipped, errors, files, filename}` for `.zip`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/upload-route-raw-stream.test.ts` (add these imports near the top, alongside the existing ones, and this new `describe` block at the end of the file):

```ts
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { id: 'test-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn((response) => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
```

```ts
import { readFileSync } from 'fs'
import { POST as POST_V1 } from '@/app/api/v1/upload/route'

describe('POST /api/v1/upload — raw-stream body', () => {
  beforeEach(() => {
    mockProcessTextStream.mockClear()
    mockProcessZipFile.mockClear()
  })

  it('rejects a request with no filename query param', async () => {
    const req = new NextRequest('http://localhost/api/v1/upload', {
      method: 'POST',
      body: 'irrelevant body content',
    })
    const res = await POST_V1(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ success: false, error: 'No filename provided' })
  })

  it('streams request.body straight into processTextStream and awaits it before responding', async () => {
    const req = new NextRequest('http://localhost/api/v1/upload?filename=dump.txt', {
      method: 'POST',
      body: 'https://a.com:user@a.com:pass\n',
    })
    const res = await POST_V1(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      success: true, imported: 1, skipped: 0, errors: 0, filename: 'dump.txt',
    })

    expect(mockProcessTextStream).toHaveBeenCalledTimes(1)
    const [streamArg, filenameArg] = mockProcessTextStream.mock.calls[0]
    expect(streamArg).toBeInstanceOf(ReadableStream)
    expect(filenameArg).toBe('dump.txt')
  })

  it('no longer buffers zip uploads into memory before processing (regression test for the v1 OOM-pattern fix)', () => {
    const source = readFileSync(new URL('../app/api/v1/upload/route.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('arrayBuffer()')
    expect(source).not.toContain('processZipBuffer')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/upload-route-raw-stream.test.ts`

Expected: the three new tests FAIL. The first two fail the same way as Task 1's did (current code reads `formData`, not the query param/raw body). The regression test fails because the current source still contains both `arrayBuffer()` and `processZipBuffer`.

- [ ] **Step 3: Rewrite the POST handler**

Replace the full contents of `app/api/v1/upload/route.ts` with:

```ts
/**
 * Upload API v1 — ULP Credentials Upload
 * POST /api/v1/upload?filename=<name>  (raw file bytes as the request body)
 *
 * API-key authenticated (admin role).  Goes through the shared uploadQueue
 * (pLimit 1) so v1 API uploads are serialised with browser uploads and the
 * inbox watcher — no RAM spikes from concurrent streams.
 *
 * Uses the same processing pipeline as the HTTP upload route:
 *   - processTextStream  for .txt/.csv  (streaming, 500K-row batches)
 *   - processZipFile     for .zip       (yauzl lazy entry streaming, disk-buffered)
 *   - logJob             for observability (appears in /inbox monitor)
 *   - checkMonitorsForULPUpload  for domain monitor alerts
 */

import fs from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { uploadQueue } from "@/lib/upload-queue"
import { processTextStream, processZipFile, type ProcessResult } from "@/lib/upload-processor"
import { logJob } from "@/lib/processing-log"

export const dynamic    = "force-dynamic"
export const maxDuration = 300  // 5 minutes — large uploads need sustained time

const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024  // 10 GB

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/upload')

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    return NextResponse.json({ success: false, error: 'File too large (max 10 GB)' }, { status: 413 })
  }

  const originalFilename = request.nextUrl.searchParams.get('filename')
  if (!originalFilename) {
    return NextResponse.json({ success: false, error: 'No filename provided' }, { status: 400 })
  }

  if (!request.body) {
    return NextResponse.json({ success: false, error: 'No file data received' }, { status: 400 })
  }
  const body = request.body

  const name = originalFilename.toLowerCase()

  const startAt = Date.now()

  try {
    // ── Plain text / CSV ──────────────────────────────────────────────────────
    // Streaming: constant RAM regardless of file size.
    // Runs through the shared uploadQueue so it doesn't race with other uploads.
    if (name.endsWith('.txt') || name.endsWith('.csv')) {
      // Definite assignment: uploadQueue always resolves processTextStream
      // or throws, so `result` is always assigned when we reach the next line.
      // eslint-disable-next-line prefer-const
      let result!: ProcessResult

      await uploadQueue(async () => {
        result = await processTextStream(body, originalFilename)
      })
      const r = result
      logJob({
        source:      'http',
        filename:    originalFilename,
        status:      'done',
        imported:    r.imported,
        skipped:     r.skipped,
        duration_ms: Date.now() - startAt,
        breach_name: r.breach_name,
      })

      const response = NextResponse.json({
        success:  true,
        imported: r.imported,
        skipped:  r.skipped,
        errors:   r.errors,
        filename: r.filename,
      })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    // ── ZIP archive ───────────────────────────────────────────────────────────
    // Stream the upload body to a temp file on disk before processing, same
    // pattern as app/api/upload/route.ts — peak RAM stays at ~200 MB
    // regardless of archive size, instead of buffering the whole zip in heap.
    if (name.endsWith('.zip')) {
      const tmpPath = `/tmp/ulp-zip-${crypto.randomUUID()}.zip`
      const results: ProcessResult[] = []
      let totalErrors = 0
      const failedEntries: string[] = []

      try {
        await pipeline(
          Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>),
          fs.createWriteStream(tmpPath),
        )

        await uploadQueue(async () => {
          await processZipFile(tmpPath, result => {
            if (result.imported > 0) results.push(result)
            if (result.errors > 0) {
              totalErrors += result.errors
              failedEntries.push(result.filename)
            }
          })
        })
      } finally {
        fs.unlink(tmpPath, () => {})
      }

      let totalImported = 0
      let totalSkipped  = 0
      for (const r of results) { totalImported += r.imported; totalSkipped += r.skipped }

      logJob({
        source:      'http',
        filename:    originalFilename,
        status:      'done',
        imported:    totalImported,
        skipped:     totalSkipped,
        duration_ms: Date.now() - startAt,
        ...(failedEntries.length > 0
          ? { error_message: `${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'} skipped: ${failedEntries.join(', ')}` }
          : {}),
      })

      const response = NextResponse.json({
        success:  true,
        imported: totalImported,
        skipped:  totalSkipped,
        errors:   totalErrors,
        files:    results.map(r => ({ filename: r.filename, imported: r.imported })),
        filename: originalFilename,
      })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    return NextResponse.json({ success: false, error: 'Unsupported file type. Use .txt, .csv, or .zip' }, { status: 400 })
  } catch (error) {
    console.error('v1 upload error:', error)
    logJob({
      source:        'http',
      filename:      originalFilename,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/upload-route-raw-stream.test.ts`

Expected: all 7 tests (4 from Task 1 + 3 from this task) PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: all tests pass; typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/upload/route.ts __tests__/upload-route-raw-stream.test.ts
git commit -m "fix(upload): stream v1 API uploads directly, fix zip OOM-pattern regression

Same request.body redesign as the non-v1 route (previous commit), applied
to app/api/v1/upload/route.ts. Also fixes finding #2 from the ingest
pipeline audit: this route's zip path still did
Buffer.from(await file.arrayBuffer()) -- the exact pattern that caused a
documented 6GB OOM crash, already fixed in the non-v1 route. Now streams
to a temp file via the same proven pattern instead.

See docs/superpowers/specs/2026-08-16-raw-stream-upload-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Update the browser upload page's fetch call

**Files:**
- Modify: `app/upload/page.tsx:95-98`

**Interfaces:**
- Consumes: `POST /api/upload?filename=<name>` (raw body) from Task 1 — replaces the prior `POST /api/upload` (multipart) contract.
- Produces: no change to any other function's signature in this file — `processFileSingle` still returns `Promise<UploadResult | null>` and every downstream consumer (`processQueue`, the results UI) is untouched.

- [ ] **Step 1: Make the change**

In `app/upload/page.tsx`, inside `processFileSingle` (around line 95), replace:

```ts
      const formData = new FormData()
      formData.append('file', file)

      fetch('/api/upload', { method: 'POST', body: formData })
```

with:

```ts
      fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: clean — `body: file` is valid since `File` implements `BodyInit`.

- [ ] **Step 3: Manual verification in the browser**

No component-rendering test harness exists in this repo (confirmed earlier this session — no jsdom/testing-library dependency). Verify by hand:

1. Start the dev server: use the Browser tool's `preview_start` with the `ulp-suite-dev` launch config (or `npm run dev` if no `.claude/launch.json` config exists in this worktree — create one pointed at a free port if needed).
2. Log in as the seeded admin, navigate to `/upload`.
3. Drag a small real `.txt` credential file onto the drop zone.
4. Confirm: the network request is `POST /api/upload?filename=<name>` with the file's raw bytes as the body (check via `read_network_requests` or the Network tab) — NOT a `multipart/form-data` request.
5. Confirm: the SSE progress bar still updates (`liveImported`/`livePct` climbing), and the "Import complete" success card renders with correct imported/skipped counts.
6. Repeat with a `.zip` containing 2+ `.txt` entries — confirm the per-file breakdown list renders correctly.
7. Check the browser console and server logs for errors — none expected.

- [ ] **Step 4: Commit**

```bash
git add app/upload/page.tsx
git commit -m "fix(upload): send raw file body instead of FormData from the upload page

Matches the app/api/upload/route.ts raw-stream redesign. No other change --
SSE handling, the upload queue, and the results UI are all keyed off the
JSON response, which is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Update the `/docs` API documentation

**Files:**
- Modify: `app/docs/page.tsx:783-838`

**Interfaces:**
- Consumes: nothing (static content).
- Produces: nothing consumed elsewhere — this is documentation only.

- [ ] **Step 1: Update the example request and parameter table**

In `app/docs/page.tsx`, replace the "Form Data Parameters" block (around line 794-800):

```tsx
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Form Data Parameters</h4>
                  <ParameterTable params={[
                    { name: "file", type: "file", required: true, description: "Credential file in .txt, .csv, or .zip format. ZIP archives may contain multiple .txt/.csv files." },
                  ]} />
                </div>
```

with:

```tsx
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Query Parameters</h4>
                  <ParameterTable params={[
                    { name: "filename", type: "string", required: true, description: "Original filename, used to determine .txt/.csv/.zip handling and breach-name matching. The request body is the raw file bytes." },
                  ]} />
                </div>
```

Then replace the example request block (around line 802-808):

```tsx
                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/upload" \\
  -H "X-API-Key: bv_admin_api_key" \\
  -F "file=@stealer_logs.zip"`} />
                </div>
```

with:

```tsx
                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/upload?filename=stealer_logs.zip" \\
  -H "X-API-Key: bv_admin_api_key" \\
  --data-binary @stealer_logs.zip`} />
                </div>
```

The description text at line 790 ("Upload a credential file (.txt, .csv, or .zip)...") and the "Success Response" JSON example (lines 810-836) are unchanged — the response shape didn't change.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 3: Verify the docs page renders correctly**

Using the Browser tool: start the dev server, navigate to `/docs`, click the "Upload" section, confirm the new curl example and "Query Parameters" table render correctly and match Task 2's actual route behavior.

- [ ] **Step 4: Commit**

```bash
git add app/docs/page.tsx
git commit -m "docs: update /api/v1/upload documentation for the raw-stream redesign

Example request and parameter table now match the ?filename= query param +
raw body contract from the previous two commits. Response shape unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests pass (895 pre-existing + 7 new from Tasks 1-2).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 3: Run a production build**

Run: `npm run build`

Expected: build succeeds. Confirms the `import('stream/web')` type-only import and the `request.body`/`request.nextUrl` usage all compile correctly in a production build, not just under `next dev`.

- [ ] **Step 4: Manual end-to-end browser test**

Repeat Task 3 Step 3's manual verification end-to-end one more time against the fully-merged branch (all four commits applied together), covering: a `.txt` upload through the browser UI, a `.zip` upload through the browser UI, and confirm both show correct results and no console/server errors.

- [ ] **Step 5: Manual end-to-end v1 API test**

Using a real API key (check `/api-keys` in the app, or create one for this test): run the exact curl command from the updated `/docs` page against the running dev server, with a small real credential file, and confirm the JSON response matches the documented shape with correct `imported`/`skipped` counts.

- [ ] **Step 6: Final repo-wide grep for stragglers**

Run:

```bash
grep -rn "formData\|arrayBuffer()\|processZipBuffer" app/api/upload/route.ts app/api/v1/upload/route.ts
```

Expected: **no output** — confirms both routes are fully clear of the old FormData/buffering code.

---

## Self-Review

**Spec coverage:**
- `app/api/upload/route.ts` raw-stream redesign (finding #1) — Task 1 ✓
- `app/api/v1/upload/route.ts` raw-stream redesign + zip OOM-pattern fix (findings #1 + #2) — Task 2 ✓
- `app/upload/page.tsx` client fetch update — Task 3 ✓
- `app/docs/page.tsx` documentation update — Task 4 ✓
- Filename query param, casing convention, clean cutover, disk-buffered zip (all Decisions from the spec) — reflected in Global Constraints and every task's code ✓
- Full verification (test/typecheck/build/manual E2E) — Task 5 ✓

**Placeholder scan:** no TBD/TODO/"add appropriate"/"similar to Task N" patterns — every step shows complete, literal code or the exact grep/test command and its expected output.

**Type consistency:** `processTextStream(stream, filename, jobId?, onBatch?)` and `processZipFile(filepath, onEntry)` signatures match `lib/upload-processor.ts` exactly and are used identically across Tasks 1 and 2. `originalFilename` / `body` variable names are used consistently within each task (not renamed between steps). `ProcessResult` type is imported the same way in both routes, matching its existing export from `lib/upload-processor.ts`.
