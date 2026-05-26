import { Readable } from "stream"
import { type NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { parseULPContent, parseULPStream, makeRejectionMap, type ULPCredential, type RejectionReason, type StreamBatch } from "@/lib/ulp-parser"
import { getClient } from "@/lib/clickhouse"
import { checkMonitorsForULPUpload } from "@/lib/domain-monitor"
import { matchBreach } from "@/lib/breach-matcher"
import { runClickHouseMigrations } from "@/lib/clickhouse-migrations"
import { invalidateStatsCache } from "@/lib/stats-cache"
import JSZip from "jszip"
import { createJob, getJob, updateJob, pushEvent } from "@/lib/upload-jobs"

export const dynamic = 'force-dynamic'

// 5 minutes — large uploads (GBs of text) need sustained time.
// Vercel Pro/Enterprise allows up to 300 s; self-hosted Node has no limit.
export const maxDuration = 300

// 10 GB — raised from 500 MB so multi-GB stealer log dumps work out of the box.
// The streaming pipeline (processTextStream) keeps RAM constant regardless of size.
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024

/** Escape a field value for ClickHouse CSV: wrap in quotes, double internal quotes. */
function csvField(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * Insert a batch of credentials into ClickHouse as a streaming CSV Readable.
 *
 * Why CSV + Readable instead of JSONEachRow + array:
 *   - No heap materialisation of 500K objects + JSON serialisation
 *   - ClickHouse JS client streams the Readable as chunked HTTP body
 *   - Peak memory: O(1) per row instead of O(batch_size)
 */
async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
): Promise<void> {
  if (credentials.length === 0) return
  const chClient = getClient()

  // Generator yields one CSV row at a time — no large string materialised.
  // objectMode MUST be false: Readable.from() defaults to objectMode:true
  // (treats each element as an object), rejected by the ClickHouse CSV reader.
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
      // Buffer many small inserts server-side → fewer, larger MergeTree parts
      async_insert:          1 as any,
      // Block until the async buffer is flushed → gives us back-pressure
      wait_for_async_insert: 1 as any,
      // No time cap for insert operations (only applies to SELECT by default anyway)
      max_execution_time:    0,
    },
  })
}

async function recordSource(filename: string, lineCount: number): Promise<void> {
  const chClient = getClient()
  await chClient.insert({
    table: 'ulp.sources',
    values: [{ filename, line_count: lineCount }],
    format: 'JSONEachRow',
  })
}

/**
 * Streaming processor for .txt / .csv uploads.
 *
 * Reads the file as a ReadableStream<Uint8Array> and parses it line by line
 * in 500 K-row batches.  Peak RAM is proportional to batch size (~200 MB),
 * not file size — so a 50 GB dump uses the same memory as a 50 MB one.
 *
 * If jobId is provided, calls updateJob after each batch so the SSE endpoint
 * can push live progress to the browser.
 */
async function processTextStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  jobId?: string,
): Promise<{ imported: number; skipped: number; errors: number; filename: string; breach_name: string; rejection_breakdown: Record<RejectionReason, number> }> {
  const breach_name = matchBreach(filename)
  let imported = 0
  let skipped  = 0
  const rejection_breakdown = makeRejectionMap()

  for await (const batch of parseULPStream(stream, filename, 500_000)) {
    await insertBatch(batch.credentials, breach_name)
    imported += batch.credentials.length
    skipped  += batch.rejected
    for (const [k, v] of Object.entries(batch.breakdown)) {
      rejection_breakdown[k as RejectionReason] = (rejection_breakdown[k as RejectionReason] ?? 0) + v
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

/**
 * Wrap the upload processing to push SSE progress events during ingestion.
 * Events are pushed every 2 seconds AND on done/error.
 */
async function runWithProgress(
  jobId: string,
  fn: () => Promise<{ imported: number; skipped: number; errors: number; filename: string; breach_name: string; rejection_breakdown: Record<string, number> }>
): Promise<void> {
  // Push progress every 2 seconds
  const interval = setInterval(async () => {
    const j = getJob(jobId)
    if (j) await pushEvent(j).catch(() => {})
  }, 2000)

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

/**
 * In-memory processor used for ZIP entries (strings already decompressed by JSZip).
 * Uses the same 500 K batch size and async_insert as the streaming path.
 */
async function processTextContent(content: string, filename: string) {
  const { credentials, skipped, errors, rejection_breakdown } = parseULPContent(content, filename)
  const breach_name = matchBreach(filename)

  const BATCH_SIZE = 500_000
  for (let i = 0; i < credentials.length; i += BATCH_SIZE) {
    await insertBatch(credentials.slice(i, i + BATCH_SIZE), breach_name)
  }

  if (credentials.length > 0) {
    await recordSource(filename, credentials.length)
    invalidateStatsCache()
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
  }

  return { imported: credentials.length, skipped, errors, filename, breach_name, rejection_breakdown }
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  // Run schema migrations once per process startup
  await runClickHouseMigrations()

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
  if (!file) {
    return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 })
  }

  const filename = file.name.toLowerCase()

  try {
    // Plain-text or CSV — stream line by line; never loads full file into RAM.
    // Fire-and-forget: return jobId immediately; SSE stream delivers progress.
    if (filename.endsWith('.txt') || filename.endsWith('.csv')) {
      const jobId = crypto.randomUUID()
      const totalLines = contentLength ? Math.floor(parseInt(contentLength) / 60) : 0
      const breach_name = matchBreach(file.name)
      createJob(jobId, totalLines, breach_name)

      // Fire without await — runs in background while SSE streams progress
      runWithProgress(jobId, () => processTextStream(file.stream(), file.name, jobId)).catch(console.error)

      return NextResponse.json({
        success:   true,
        jobId,
        streamUrl: `/api/upload/progress/${jobId}`,
      })
    }

    // ZIP — JSZip needs the full buffer; entries are processed in-memory.
    // Individual text entries still use 500 K batches for inserts.
    if (filename.endsWith('.zip')) {
      const buffer = await file.arrayBuffer()
      const zip = await JSZip.loadAsync(buffer)

      let totalImported = 0
      let totalSkipped = 0
      let totalErrors = 0
      const totalBreakdown = makeRejectionMap()
      const files: Array<{ filename: string; breach_name: string; imported: number }> = []

      for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue
        const lp = zipPath.toLowerCase()
        if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) continue

        const content   = await zipEntry.async('string')
        const entryName = zipPath.split('/').pop() || zipPath
        const result    = await processTextContent(content, entryName)

        totalImported += result.imported
        totalSkipped  += result.skipped
        totalErrors   += result.errors
        // Merge per-file breakdown into totals
        for (const [k, v] of Object.entries(result.rejection_breakdown)) {
          totalBreakdown[k as RejectionReason] += v
        }
        if (result.imported > 0) {
          files.push({ filename: entryName, breach_name: result.breach_name, imported: result.imported })
        }
      }

      const total = totalImported + totalSkipped
      return NextResponse.json({
        success: true,
        imported:            totalImported,
        skipped:             totalSkipped,
        errors:              totalErrors,
        import_pct:          total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0,
        rejection_breakdown: totalBreakdown,
        files,
        filename: file.name,
      })
    }

    return NextResponse.json(
      { success: false, error: 'Unsupported file type. Upload a .txt, .csv, or .zip file.' },
      { status: 400 }
    )
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
