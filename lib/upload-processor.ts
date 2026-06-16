/**
 * Shared upload processing pipeline.
 *
 * Used by both the HTTP upload route (app/api/upload/route.ts) and the inbox
 * folder watcher (lib/inbox-watcher.ts).  Keeps ClickHouse insertion, source
 * recording, and parsing logic in one place.
 */

import { Readable } from 'stream'
import yauzl from 'yauzl'
import {
  parseULPStream,
  makeRejectionMap,
  type ULPCredential,
  type RejectionReason,
} from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import { batchDedupToken } from '@/lib/upload-dedup'
import { runContentDedupTick } from '@/lib/content-dedup'
import { parseIngestPolicy, policyActive, shouldDropAtIngest } from '@/lib/ingest-filter'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'

// ─── Public result type ───────────────────────────────────────────────────────

export interface ProcessResult {
  imported:            number
  skipped:             number
  errors:              number
  filename:            string
  breach_name:         string
  rejection_breakdown: Record<RejectionReason, number>
  /** True when the file was skipped because its filename is already in ulp.sources. */
  alreadyImported:     boolean
  /** Rows dropped pre-insert by the ingest tier filter (lib/ingest-filter.ts). */
  tierDropped:         number
}

// ─── ClickHouse helpers ───────────────────────────────────────────────────────

/** Escape a value for ClickHouse CSV: wrap in double-quotes, double internal quotes. */
function csvField(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * Authoritative "already imported" check. ulp.sources is written by recordSource
 * ONLY after a file fully imports, so its presence means the whole file is already
 * in ulp.credentials. Used both to skip re-imports (processTextStream) and to keep
 * recordSource idempotent.
 */
export async function sourceAlreadyImported(filename: string): Promise<boolean> {
  const res = await getClient().query({
    query:        `SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1`,
    query_params: { f: filename },
    format:       'JSONEachRow',
  })
  const rows = await res.json() as Array<{ c: string | number }>
  return Number(rows[0]?.c ?? 0) > 0
}

/**
 * Insert a batch into ClickHouse as a streaming CSV Readable.
 * Generator yields one row at a time — no large string materialised in heap.
 */
export async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
): Promise<void> {
  if (credentials.length === 0) return
  const chClient = getClient()

  // Deterministic content hash of this exact batch — see lib/upload-dedup.ts.
  const token = batchDedupToken(credentials, breach_name)

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
      async_insert:          1 as any,
      wait_for_async_insert: 1 as any,
      max_execution_time:    0,
      // Block-level insert dedup. ulp.credentials is ReplicatedMergeTree, so a
      // re-inserted byte-identical batch (inbox reprocess, retry, or request race)
      // is dropped by ClickHouse within its dedup window instead of appending
      // duplicate rows. The token is a content hash of this exact batch, so any
      // changed/new row still inserts. NOTE: ClickHouse requires async_insert
      // dedup to be on too, or the token is ignored under async_insert=1.
      insert_deduplicate:          1 as any,
      async_insert_deduplicate:    1 as any,
      insert_deduplication_token:  token as any,
      // Allow ClickHouse to use multiple threads for column compression per insert.
      // Default is 1; 4 uses spare CPU to speed up bulk loads.
      max_insert_threads:    4 as any,
    },
  })
}

export async function recordSource(filename: string, lineCount: number): Promise<void> {
  const chClient = getClient()

  // Idempotent: skip if this filename was already recorded in ulp.sources.
  // Prevents duplicate source rows when a file is re-processed (e.g. after an
  // OOM crash between processTextStream and renameSync, or a Force Scan race).
  // Safe because inbox processing is serialised via uploadQueue (pLimit 1).
  if (await sourceAlreadyImported(filename)) {
    console.log(`[upload-processor] recordSource: ${filename} already in ulp.sources — skipping`)
    return
  }

  await chClient.insert({
    table:  'ulp.sources',
    values: [{ filename, line_count: lineCount }],
    format: 'JSONEachRow',
  })
}

// ─── Text stream processor ────────────────────────────────────────────────────

/**
 * Stream-process a .txt or .csv file.
 *
 * Reads in 500K-row batches — peak RAM is ~200 MB regardless of file size.
 * Pass jobId to push live progress via the in-memory SSE job store.
 */
export async function processTextStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  jobId?: string,
  /** Called after each 500K-row batch with the cumulative imported count. */
  onBatch?: (imported: number) => void,
): Promise<ProcessResult> {
  const breach_name        = matchBreach(filename)

  // Durable re-upload guard: if this filename is already in ulp.sources it was
  // fully imported before, so skip re-reading/inserting it entirely. This is the
  // authoritative, time-unbounded guard against the inbox watcher reprocessing a
  // file or a duplicate re-upload — complementary to ClickHouse's insert-dedup
  // token, which only covers re-inserts within its (1h default) dedup window.
  if (await sourceAlreadyImported(filename)) {
    console.log(`[upload-processor] ${filename} already in ulp.sources — skipping re-import`)
    return {
      imported: 0, skipped: 0, errors: 0, filename, breach_name,
      rejection_breakdown: makeRejectionMap(), alreadyImported: true, tierDropped: 0,
    }
  }

  let imported             = 0
  let skipped              = 0
  let tierDropped          = 0
  const rejection_breakdown = makeRejectionMap()

  // Ingest tier filter — drops low-value rows BEFORE insert. Off unless
  // INGEST_FILTER_DROP_TIERS / INGEST_FILTER_DROP_SUFFIXES is configured.
  const dropPolicy = parseIngestPolicy()
  const filterOn   = policyActive(dropPolicy)

  for await (const batch of parseULPStream(stream, filename, 500_000)) {
    let creds = batch.credentials
    if (filterOn) {
      const kept = creds.filter(c => !shouldDropAtIngest(c.email, c.url, dropPolicy))
      tierDropped += creds.length - kept.length
      creds = kept
    }
    await insertBatch(creds, breach_name)
    imported += creds.length
    skipped  += batch.rejected
    for (const [k, v] of Object.entries(batch.breakdown)) {
      rejection_breakdown[k as RejectionReason] =
        (rejection_breakdown[k as RejectionReason] ?? 0) + v
    }
    if (jobId)   updateJob(jobId, { imported, skipped })
    if (onBatch) onBatch(imported)
  }

  if (filterOn && tierDropped > 0) {
    console.log(`[ingest-filter] ${filename}: dropped ${tierDropped} low-tier rows pre-insert`)
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
    // Import-time prevention: clean up any exact (url,email,password) duplicates
    // this import added (cross-file copies the per-stream Set can't catch).
    // Fire-and-forget; report-only unless CONTENT_DEDUP_APPLY=true.
    runContentDedupTick({ trigger: 'import' }).catch(err =>
      console.error('Content-dedup post-import error:', err)
    )
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
}

// ─── ZIP processor (yauzl — lazy entry streaming) ────────────────────────────

/**
 * Drive a yauzl ZipFile through its .txt/.csv entries one at a time.
 *
 * yauzl with lazyEntries:true decompresses entries lazily — only one entry
 * lives in memory at once.  Peak RAM ≈ one entry's 500K-row batch (≈200 MB),
 * not the full decompressed archive size.
 *
 * A single bad entry (encrypted, corrupted/CRC mismatch, etc.) only fails
 * that entry — it's reported via onEntry with errors:1 and processing
 * continues with the rest of the archive. Without this, ULP zips that bundle
 * dozens of stealer-log files would abort entirely (and discard already-
 * imported credentials' result counts) because of one bad file.
 * zipfile-level errors (e.g. unreadable central directory) remain fatal.
 *
 * onEntry is called after each processed entry — successful or not — so the
 * caller can accumulate results incrementally.
 */
function processZipEntries(
  zipfile: yauzl.ZipFile,
  onEntry: (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    zipfile.readEntry()

    zipfile.on('entry', (entry: yauzl.Entry) => {
      // Skip directory entries
      if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

      const lp = entry.fileName.toLowerCase()
      if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
        zipfile.readEntry()
        return
      }

      const entryName = entry.fileName.split('/').pop() || entry.fileName

      const skipEntry = (entryErr: unknown) => {
        console.error(
          `[upload-processor] skipping zip entry "${entry.fileName}": ` +
          (entryErr instanceof Error ? entryErr.message : String(entryErr))
        )
        onEntry({
          imported:            0,
          skipped:             0,
          errors:              1,
          filename:            entryName,
          breach_name:         matchBreach(entryName),
          rejection_breakdown: makeRejectionMap(),
          alreadyImported:     false,
          tierDropped:         0,
        })
        zipfile.readEntry()
      }

      zipfile.openReadStream(entry, (streamErr, readStream) => {
        if (streamErr) { skipEntry(streamErr); return }

        // Convert Node.js Readable → Web ReadableStream for processTextStream
        const webStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>

        processTextStream(webStream, entryName)
          .then(result => { onEntry(result); zipfile.readEntry() })
          .catch(skipEntry)
      })
    })

    zipfile.on('end', resolve)
    zipfile.on('error', reject)
  })
}

/**
 * Process a ZIP buffer by streaming its .txt/.csv entries one at a time.
 */
export async function processZipBuffer(
  buffer: Buffer,
  onEntry: (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      processZipEntries(zipfile, onEntry).then(resolve, reject)
    })
  })
}

/**
 * Process a ZIP file on disk by streaming its .txt/.csv entries one at a time.
 *
 * Uses yauzl.open — reads lazily from disk, no Buffer needed.
 * Ideal for the inbox watcher where we already have a file path.
 */
export async function processZipFile(
  filepath: string,
  onEntry:  (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      processZipEntries(zipfile, onEntry).then(resolve, reject)
    })
  })
}
