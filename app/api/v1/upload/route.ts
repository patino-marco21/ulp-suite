/**
 * Upload API v1 — ULP Credentials Upload
 * POST /api/v1/upload?filename=<name>  (raw file bytes as the request body)
 *
 * API-key authenticated (admin role).  The whole body is received into the upload spool FIRST (lib/upload-spool.ts), then
 * the file goes through the shared uploadQueue (pLimit; browser uploads and the inbox watcher share it) and is imported
 * from the spool file under the stall watchdog (lib/import-runner.ts).  Receiving first means a wait in the queue or a
 * dropped connection can no longer strand the request or wedge a queue slot.  The response is still synchronous: it is
 * sent when the import has finished.
 *
 * Uses the same processing pipeline as the other routes:
 *   - processTextFile  for .txt/.csv  (streams the spool file; also matches credentials against domain monitors
 *                       in-process and fires alerts via fireMonitorAlertsFromMatches — not a separate step)
 *   - processZipFile   for .zip       (yauzl lazy entry streaming from the spool file)
 *   - logJob           for observability (appears in /inbox monitor)
 *   - logUploadAction  for the audit log (who, which file, how it ended)
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { uploadQueue } from "@/lib/upload-queue"
import { processTextFile, processZipFile, type ProcessResult } from "@/lib/upload-processor"
import { logJob } from "@/lib/processing-log"
import { settingsManager } from "@/lib/settings"
import { formatBytes } from "@/lib/utils"
import { runImportJob } from '@/lib/import-runner'
import { spoolRequestBody, discardSpool, describeSpoolError, type SpoolResult } from '@/lib/upload-spool'
import { logUploadAction } from '@/lib/audit-log'

export const dynamic    = "force-dynamic"
export const maxDuration = 300  // 5 minutes — large uploads need sustained time

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/upload')
  const actor = { id: Number(authResult.apiKey.userId) || null, email: null as string | null }
  const keyDetails = { api_key_id: authResult.apiKey.keyId, api_key_name: authResult.apiKey.name }

  // Admin-configurable via Settings ("Max File Size") — see lib/settings.ts's
  // getMaxUploadFileSizeBytes() for the clamp range and default (10 GB).
  const MAX_FILE_SIZE = await settingsManager.getMaxUploadFileSizeBytes()

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    return NextResponse.json({ success: false, error: `File too large (max ${formatBytes(MAX_FILE_SIZE)})` }, { status: 413 })
  }

  const originalFilename = request.nextUrl.searchParams.get('filename')
  if (!originalFilename) {
    return NextResponse.json({ success: false, error: 'No filename provided' }, { status: 400 })
  }

  if (!request.body) {
    return NextResponse.json({ success: false, error: 'No file data received' }, { status: 400 })
  }

  const name = originalFilename.toLowerCase()
  const isText = name.endsWith('.txt') || name.endsWith('.csv')
  const isZip  = name.endsWith('.zip')
  if (!isText && !isZip) {
    return NextResponse.json({ success: false, error: 'Unsupported file type. Use .txt, .csv, or .zip' }, { status: 400 })
  }

  const startAt = Date.now()
  let spool: SpoolResult | undefined

  try {
    // The body is held to the size cap against bytes actually seen, not the client-supplied Content-Length (which can be
    // omitted with chunked transfer-encoding or simply be wrong).
    spool = await spoolRequestBody(request.body, {
      maxBytes:      MAX_FILE_SIZE,
      signal:        request.signal,
      expectedBytes: contentLength ? parseInt(contentLength) : undefined,
    })
    const file = spool.path
    void logUploadAction(
      'upload.api.start', actor, null,
      { ...keyDetails, filename: originalFilename, bytes: spool.bytes, kind: isZip ? 'zip' : 'text' },
      request,
    )

    // ── Plain text / CSV ──────────────────────────────────────────────────────
    // Streaming: constant RAM regardless of file size.
    // Runs through the shared uploadQueue so it doesn't race with other uploads.
    if (isText) {
      // Definite assignment: uploadQueue always resolves the import or throws, so `result` is always assigned when we
      // reach the next line.
      // eslint-disable-next-line prefer-const
      let result!: ProcessResult

      await uploadQueue(async () => {
        result = await runImportJob({
          label: originalFilename,
          work:  ctx => processTextFile(file, originalFilename, undefined, undefined, ctx),
        })
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
      void logUploadAction('upload.api.complete', actor, null, {
        ...keyDetails, filename: originalFilename, imported: r.imported, skipped: r.skipped, duration_ms: Date.now() - startAt,
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
    const results: ProcessResult[] = []
    let totalErrors = 0
    const failedEntries: string[] = []

    await uploadQueue(async () => {
      await runImportJob({
        label: originalFilename,
        work:  ctx => processZipFile(file, result => {
          if (result.imported > 0) results.push(result)
          if (result.errors > 0) {
            totalErrors += result.errors
            failedEntries.push(
              result.error_reason ? `${result.filename} (${result.error_reason})` : result.filename
            )
          }
        }, ctx),
      })
    })

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
    void logUploadAction('upload.api.complete', actor, null, {
      ...keyDetails, filename: originalFilename, imported: totalImported, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
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
  } catch (error) {
    const known = describeSpoolError(error)
    const cancelled = !known && request.signal.aborted
    if (cancelled) {
      console.warn(`[v1 upload] client disconnected while uploading ${originalFilename}; nothing was imported`)
    } else {
      console.error('v1 upload error:', error)
    }
    logJob({
      source:        'http',
      filename:      originalFilename,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: error instanceof Error ? error.message : String(error),
    })
    void logUploadAction('upload.api.fail', actor, null, {
      ...keyDetails, filename: originalFilename, error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startAt,
    })
    if (known) {
      return NextResponse.json({ success: false, error: known.message }, { status: known.status })
    }
    if (cancelled) {
      return NextResponse.json({ success: false, error: 'Upload cancelled' }, { status: 400 })
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  } finally {
    if (spool) await discardSpool(spool.path)
  }
}
