import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole, type JWTPayload } from '@/lib/auth'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue, setCurrentJob } from '@/lib/upload-queue'
import { processTextFile, type ProcessResult } from '@/lib/upload-processor'
import { isTxtName, onlyTxtMessage } from '@/lib/txt-only'
import { checkLimit, getClientIP } from '@/lib/rate-limiter'
import { logJob } from '@/lib/processing-log'
import { jobAccounting, tallyOf } from '@/lib/import-summary'
import { settingsManager } from '@/lib/settings'
import { formatBytes } from '@/lib/utils'
import { runImportJob } from '@/lib/import-runner'
import { spoolRequestBody, discardSpool, describeSpoolError, type SpoolResult } from '@/lib/upload-spool'
import { logUploadAction } from '@/lib/audit-log'
import { isIngestHeldError } from '@/lib/ingest-quality-gate'
import { holdSpooledFile } from '@/lib/inbox-helpers'

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
      phase:               undefined,
      imported:            result.imported,
      known:               result.known,
      inFileDuplicates:    result.inFileDuplicates,
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
      known:       result.known,
      skipped:     result.skipped,
      duration_ms: Date.now() - startAt,
      breach_name: result.breach_name,
      ...result.timings,
      ...jobAccounting(tallyOf(result)),
    })
    void logUploadAction('upload.complete', actor, jobId, {
      filename, imported: result.imported, known: result.known, skipped: result.skipped, duration_ms: Date.now() - startAt,
    })
  } catch (err) {
    // A held file is not a failed import: the quality gate stopped it before one row was stored, and the upload is kept in inbox/held/.
    const heldError = isIngestHeldError(err) ? err : null
    const message = err instanceof Error ? err.message : 'Upload failed'
    updateJob(jobId, {
      status: 'error',
      error:  heldError ? `${message} The file was kept; an admin can review it and release it in the Inbox.` : message,
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
    logJob({
      source:        'http',
      filename,
      status:        heldError ? 'held' : 'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: err instanceof Error ? err.message : String(err),
      ...(heldError ? { gate_report: JSON.stringify(heldError.report) } : {}),
    })
    void logUploadAction('upload.fail', actor, jobId, {
      filename, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startAt, ...(heldError ? { held: true } : {}),
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

  // Plain text only (lib/txt-only.ts): archives and .csv are refused before a byte is spooled.
  if (!isTxtName(originalFilename)) {
    return NextResponse.json(
      { success: false, error: onlyTxtMessage(originalFilename) },
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

  // The queue owns the spool file from here on.
  const requestStartedAt = Date.now()
  let handedOff = false
  try {
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
        } catch (err) {
          // Keep a file the quality gate held (the spool file moves to inbox/held/); everything else is discarded below, as before.
          if (isIngestHeldError(err)) holdSpooledFile(spool.path, originalFilename)
          throw err
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
  
  } catch (error) {
    if (isIngestHeldError(error)) {
      // The quality gate stopped an entry of the archive. The archive is kept in inbox/held/; an admin can review it and release it in the Inbox.
      const kept = holdSpooledFile(spool.path, originalFilename)
      logJob({
        source: 'http', filename: originalFilename, status: 'held', imported: 0, skipped: 0, duration_ms: Date.now() - requestStartedAt,
        error_message: error.message, gate_report: JSON.stringify(error.report),
      })
      return NextResponse.json({ success: false, held: true, kept: kept !== null, error: error.message, report: error.report }, { status: 422 })
    }
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  } finally {
    if (!handedOff) await discardSpool(spool.path)
  }
}
