import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole, type JWTPayload } from '@/lib/auth'
import { makeRejectionMap, type RejectionReason } from '@/lib/ulp-parser'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue, setCurrentJob } from '@/lib/upload-queue'
import { processTextFile, processZipFile, type ProcessResult } from '@/lib/upload-processor'
import { checkLimit, getClientIP } from '@/lib/rate-limiter'
import { logJob } from '@/lib/processing-log'
import { settingsManager } from '@/lib/settings'
import { formatBytes } from '@/lib/utils'
import { runImportJob } from '@/lib/import-runner'
import { spoolRequestBody, discardSpool, describeSpoolError, type SpoolResult } from '@/lib/upload-spool'
import { logUploadAction } from '@/lib/audit-log'

// 60 uploads per IP per 5 minutes — permits batch multi-file uploads while
// still blocking runaway automation.  Admin-only endpoint; session auth is the
// primary gate.  Previously 5/5 min which blocked normal batch use.
const uploadLimiter = new Map<string, { count: number; resetAt: number }>()

export const dynamic = 'force-dynamic'

// 5 minutes — large uploads (GBs of text) need sustained time.
export const maxDuration = 300

// Admin-configurable via Settings ("Max File Size") — see lib/settings.ts's
// getMaxUploadFileSizeBytes() for the clamp range and default (10 GB).

interface Actor { id: number | null; email: string | null }

function actorOf(user: JWTPayload | null): Actor {
  return { id: user ? Number(user.userId) : null, email: user?.email || null }
}

// ─── SSE progress wrapper ─────────────────────────────────────────────────────

/**
 * Wraps a processing function with SSE progress events + audit logging.
 * Pushes a heartbeat every 2 s; pushes a final event on done/error.
 */
async function runWithProgress(
  jobId:    string,
  filename: string,
  actor:    Actor,
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
    void logUploadAction('upload.complete', actor, jobId, {
      filename, imported: result.imported, skipped: result.skipped, duration_ms: Date.now() - startAt,
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
    void logUploadAction('upload.fail', actor, jobId, {
      filename, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startAt,
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
  const actor = actorOf(user)

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

  const filename = originalFilename.toLowerCase()
  const isText = filename.endsWith('.txt') || filename.endsWith('.csv')
  const isZip  = filename.endsWith('.zip')
  if (!isText && !isZip) {
    return NextResponse.json(
      { success: false, error: 'Unsupported file type. Upload a .txt, .csv, or .zip file.' },
      { status: 400 },
    )
  }

  // Receive the WHOLE body before doing anything else, and only then reply. The old route answered first and let the body
  // trickle into the importer; a stall, a queue wait, the 300 s request timeout or a client disconnect then left a job that
  // never finished and held its slot of the shared queue (docs/superpowers/specs/2026-10-02-import-reliability-design.md).
  // The body is also held to the size cap against bytes actually seen, not the client-supplied Content-Length.
  let spool: SpoolResult
  try {
    spool = await spoolRequestBody(request.body, {
      maxBytes:      MAX_FILE_SIZE,
      signal:        request.signal,
      expectedBytes: contentLength ? parseInt(contentLength) : undefined,
    })
  } catch (error) {
    const known = describeSpoolError(error)
    if (known) return NextResponse.json({ success: false, error: known.message }, { status: known.status })
    if (request.signal.aborted) {
      console.warn(`[upload] client disconnected while uploading ${originalFilename}; nothing was imported`)
      return NextResponse.json({ success: false, error: 'Upload cancelled' }, { status: 400 })
    }
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  }

  // For text the queue owns the spool file from here on; for ZIP this handler does until it responds.
  let handedOff = false
  try {
    // ── Plain text / CSV ──────────────────────────────────────────────────────
    if (isText) {
      const jobId       = crypto.randomUUID()
      const breach_name = matchBreach(originalFilename)
      createJob(jobId, Math.floor(spool.bytes / 60), breach_name)
      void logUploadAction(
        'upload.start', actor, jobId,
        { filename: originalFilename, bytes: spool.bytes, via: 'ui' },
        request,
      )

      runWithProgress(
        jobId,
        originalFilename,
        actor,
        () => uploadQueue(async () => {
          setCurrentJob(originalFilename)
          try {
            return await runImportJob({
              label: originalFilename,
              work:  ctx => processTextFile(spool.path, originalFilename, jobId, undefined, ctx),
            })
          } finally {
            setCurrentJob(null)
            await discardSpool(spool.path)
          }
        }),
      ).catch(console.error)
      handedOff = true

      return NextResponse.json({
        success:        true,
        jobId,
        streamUrl:      `/api/upload/progress/${jobId}`,
        queue_position: uploadQueue.pendingCount,
      })
    }

    // ── ZIP archive ───────────────────────────────────────────────────────────
    const startAt = Date.now()
    const results: ProcessResult[] = []
    let totalErrors = 0
    const failedEntries: string[] = []
    void logUploadAction(
      'upload.start', actor, null,
      { filename: originalFilename, bytes: spool.bytes, via: 'ui', kind: 'zip' },
      request,
    )

    try {
      await uploadQueue(async () => {
        setCurrentJob(originalFilename)
        try {
          await runImportJob({
            label: originalFilename,
            work:  ctx => processZipFile(spool.path, result => {
              if (result.imported > 0) results.push(result)
              if (result.errors > 0) {
                totalErrors += result.errors
                failedEntries.push(
                  result.error_reason ? `${result.filename} (${result.error_reason})` : result.filename
                )
              }
            }, ctx),
          })
        } finally {
          setCurrentJob(null)
        }
      })
    } catch (error) {
      void logUploadAction('upload.fail', actor, null, {
        filename: originalFilename,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startAt,
      })
      throw error
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
    void logUploadAction('upload.complete', actor, null, {
      filename: originalFilename, imported: totalImported, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
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
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  } finally {
    if (!handedOff) await discardSpool(spool.path)
  }
}
