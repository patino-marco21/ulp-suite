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
import { capWebStream, MaxBytesExceededError } from "@/lib/size-capped-stream"

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
  // Content-Length (checked above) is only a client-supplied claim — it can
  // be omitted entirely (chunked transfer-encoding) or simply not match what
  // the client actually sends. This enforces the same 10 GB ceiling against
  // bytes actually observed, for both branches below.
  const body = capWebStream(request.body, MAX_FILE_SIZE)

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
    // pattern as app/api/upload/route.ts — peak RAM here stays at ~200 MB
    // regardless of archive size, instead of buffering the whole zip in
    // heap. body above is also capped independently of Content-Length, and
    // middleware.ts's matcher excludes /api so Next.js doesn't separately
    // clone this request's body upstream — see the equivalent comment in
    // app/api/upload/route.ts's zip branch for the measured numbers.
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
    if (error instanceof MaxBytesExceededError) {
      return NextResponse.json(
        { success: false, error: 'File too large (max 10 GB)' },
        { status: 413 },
      )
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
