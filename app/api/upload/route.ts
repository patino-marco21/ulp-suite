import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { makeRejectionMap, type RejectionReason } from '@/lib/ulp-parser'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue } from '@/lib/upload-queue'
import { processTextStream, processZipBuffer, type ProcessResult } from '@/lib/upload-processor'
import { checkLimit, getClientIP } from '@/lib/rate-limiter'

// 5 uploads per IP per 5 minutes — generous for admin use, blocks runaway loops.
const uploadLimiter = new Map<string, { count: number; resetAt: number }>()

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
    // Fire-and-forget: return jobId immediately; SSE stream delivers progress.
    // uploadQueue serialises concurrent submissions — only one stream at a time.
    if (filename.endsWith('.txt') || filename.endsWith('.csv')) {
      const jobId       = crypto.randomUUID()
      const totalLines  = contentLength ? Math.floor(parseInt(contentLength) / 60) : 0
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
