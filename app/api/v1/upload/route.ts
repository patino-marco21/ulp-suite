/**
 * Upload API v1 - ULP Credentials Upload
 * POST /api/v1/upload  (multipart: file .txt or .zip)
 * ADMIN ONLY
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { parseULPContent, parseULPStream, type ULPCredential } from "@/lib/ulp-parser"
import { getClient } from "@/lib/clickhouse"
import JSZip from "jszip"

export const dynamic    = "force-dynamic"
export const maxDuration = 300  // 5 minutes — large uploads need sustained time

const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024  // 10 GB

async function insertBatch(credentials: ULPCredential[]) {
  if (!credentials.length) return
  const client = getClient()
  await client.insert({
    table: 'ulp.credentials',
    values: credentials,
    format: 'JSONEachRow',
    clickhouse_settings: {
      async_insert:          1 as any,   // server-side buffering
      wait_for_async_insert: 1 as any,   // back-pressure: wait for flush
      max_execution_time:    0,          // no cap for inserts
    },
  })
}

async function recordSource(filename: string, lineCount: number) {
  const client = getClient()
  await client.insert({
    table: 'ulp.sources',
    values: [{ filename, line_count: lineCount }],
    format: 'JSONEachRow',
  })
}

/** Streaming processor — never loads the full file into memory. */
async function processStream(stream: ReadableStream<Uint8Array>, filename: string) {
  let imported = 0
  for await (const batch of parseULPStream(stream, filename, 500_000)) {
    await insertBatch(batch)
    imported += batch.length
  }
  if (imported > 0) await recordSource(filename, imported)
  return { imported, skipped: 0, errors: 0, filename }
}

/** In-memory processor for ZIP entries (already decompressed strings). */
async function processContent(content: string, filename: string) {
  const { credentials, skipped, errors } = parseULPContent(content, filename)
  const BATCH = 500_000
  for (let i = 0; i < credentials.length; i += BATCH) {
    await insertBatch(credentials.slice(i, i + BATCH))
  }
  if (credentials.length > 0) await recordSource(filename, credentials.length)
  return { imported: credentials.length, skipped, errors, filename }
}

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

  try {
    // Plain-text: stream line by line — constant RAM regardless of file size
    if (name.endsWith('.txt') || name.endsWith('.csv')) {
      const result   = await processStream(file.stream(), file.name)
      const response = NextResponse.json({ success: true, ...result })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    if (name.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      let imported = 0, skipped = 0, errors = 0
      const files: string[] = []

      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue
        const lp = path.toLowerCase()
        if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) continue
        const content    = await entry.async('string')
        const entryName  = path.split('/').pop() || path
        const result     = await processContent(content, entryName)
        imported += result.imported; skipped += result.skipped; errors += result.errors
        if (result.imported > 0) files.push(entryName)
      }

      const response = NextResponse.json({ success: true, imported, skipped, errors, files, filename: file.name })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    return NextResponse.json({ success: false, error: 'Unsupported file type. Use .txt, .csv, or .zip' }, { status: 400 })
  } catch (error) {
    console.error('v1 upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
