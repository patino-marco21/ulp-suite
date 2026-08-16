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
import { capWebStream, MaxBytesExceededError } from '@/lib/size-capped-stream'
import { settingsManager } from '@/lib/settings'
import { formatBytes } from '@/lib/utils'

// 60 uploads per IP per 5 minutes — permits batch multi-file uploads while
// still blocking runaway automation.  Admin-only endpoint; session auth is the
// primary gate.  Previously 5/5 min which blocked normal batch use.
const uploadLimiter = new Map<string, { count: number; resetAt: number }>()

export const dynamic = 'force-dynamic'

// 5 minutes — large uploads (GBs of text) need sustained time.
export const maxDuration = 300

// Admin-configurable via Settings ("Max File Size") — see lib/settings.ts's
// getMaxUploadFileSizeBytes() for the clamp range and default (10 GB).

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

  const MAX_FILE_SIZE = await settingsManager.getMaxUploadFileSizeBytes()

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    return NextResponse.json(
      { success: false, error: `File too large (max ${formatBytes(MAX_FILE_SIZE)})` },
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
  // Content-Length (checked above) is only a client-supplied claim — it can
  // be omitted entirely (chunked transfer-encoding) or simply not match what
  // the client actually sends. This enforces the same 10 GB ceiling against
  // bytes actually observed, for both branches below.
  const body = capWebStream(request.body, MAX_FILE_SIZE)

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

      // Stream the upload body to a temp file on disk before processing.
      // Peak RAM here stays at ~200 MB (one 500K-row batch at a time)
      // regardless of archive size — see lib/upload-processor.ts. middleware.ts's
      // matcher excludes /api, so Next.js no longer clones this request's body
      // at the middleware layer on top of this (measured 2026-08-16: ~611 MB
      // real peak vs ~34 MB once that upstream clone was removed, for a
      // 300 MB upload). body above is also capped independently of
      // Content-Length, so a lying/absent header can't make this write past
      // MAX_FILE_SIZE either.
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
                failedEntries.push(
                  result.error_reason ? `${result.filename} (${result.error_reason})` : result.filename
                )
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
    if (error instanceof MaxBytesExceededError) {
      return NextResponse.json(
        { success: false, error: `File too large (max ${formatBytes(error.limitBytes)})` },
        { status: 413 },
      )
    }
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  }
}
