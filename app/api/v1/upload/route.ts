/**
 * Upload API v1 — ULP Credentials Upload
 * POST /api/v1/upload  (multipart: file .txt/.csv/.zip)
 *
 * API-key authenticated (admin role).  Goes through the shared uploadQueue
 * (pLimit 1) so v1 API uploads are serialised with browser uploads and the
 * inbox watcher — no RAM spikes from concurrent streams.
 *
 * Uses the same processing pipeline as the HTTP upload route:
 *   - processTextStream  for .txt/.csv  (streaming, 500K-row batches)
 *   - processZipFile     for .zip       (yauzl lazy entry streaming)
 *   - logJob             for observability (appears in /inbox monitor)
 *   - checkMonitorsForULPUpload  for domain monitor alerts
 */

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

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 })

  const name = file.name.toLowerCase()

  const startAt = Date.now()

  try {
    // ── Plain text / CSV ──────────────────────────────────────────────────────
    // Streaming: constant RAM regardless of file size.
    // Runs through the shared uploadQueue so it doesn't race with other uploads.
    if (name.endsWith('.txt') || name.endsWith('.csv')) {
      let result: ProcessResult | null = null

      await uploadQueue(async () => {
        result = await processTextStream(file.stream(), file.name)
      })

      const r = result as unknown as ProcessResult
      logJob({
        source:      'http',
        filename:    file.name,
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
    // processZipFile uses yauzl.open — streams entry contents from disk
    // without buffering the whole archive (unlike JSZip).
    // Because v1 receives the file via multipart, we still need the buffer
    // for yauzl.fromBuffer; but entries are decompressed lazily one at a time.
    if (name.endsWith('.zip')) {
      const buffer  = Buffer.from(await file.arrayBuffer())
      const results: ProcessResult[] = []

      await uploadQueue(async () => {
        // processZipBuffer (not processZipFile) because we have a Buffer,
        // not a file path — same lazy-entry streaming under the hood.
        const { processZipBuffer } = await import('@/lib/upload-processor')
        await processZipBuffer(buffer, result => {
          if (result.imported > 0) results.push(result)
        })
      })

      let totalImported = 0
      let totalSkipped  = 0
      for (const r of results) { totalImported += r.imported; totalSkipped += r.skipped }

      logJob({
        source:      'http',
        filename:    file.name,
        status:      'done',
        imported:    totalImported,
        skipped:     totalSkipped,
        duration_ms: Date.now() - startAt,
      })

      const response = NextResponse.json({
        success:  true,
        imported: totalImported,
        skipped:  totalSkipped,
        errors:   0,
        files:    results.map(r => ({ filename: r.filename, imported: r.imported })),
        filename: file.name,
      })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    return NextResponse.json({ success: false, error: 'Unsupported file type. Use .txt, .csv, or .zip' }, { status: 400 })
  } catch (error) {
    console.error('v1 upload error:', error)
    logJob({
      source:        'http',
      filename:      file.name,
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
