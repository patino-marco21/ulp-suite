/**
 * The row-level exports (csv, ulp, userpass, ndjson) as a stream (docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md).
 *
 * The route used to run one query, hold every row in memory and send one string, which is why an export was capped at 10,000 rows. Now the
 * rows are written as ClickHouse produces them, no faster than the browser reads them, and the cap is a million. Pure code: the route feeds
 * it ClickHouse's batches, the tests feed it generators.
 */
import { csvCell } from '@/lib/csv-safe'

/** Rows a streamed export may hold. The response carries it in X-Export-Cap and the page counts the rows it receives against it. */
export const EXPORT_ROW_CAP = 1_000_000
/** Rows the json export may hold: it is one pretty-printed array built in memory, so it keeps the old cap. */
export const JSON_EXPORT_ROW_CAP = 10_000

export type StreamFormat = 'csv' | 'ndjson' | 'ulp' | 'userpass'
export const STREAM_FORMATS: readonly StreamFormat[] = ['csv', 'ndjson', 'ulp', 'userpass']

export type ExportRow = Record<string, unknown>

export const CSV_COLUMNS = [
  'url', 'email', 'password', 'domain', 'source_file', 'breach_name', 'country_tier', 'login_type', 'password_length', 'password_mask',
  'url_scheme', 'is_corporate_email', 'email_domain', 'url_host', 'password_entropy_band', 'imported_at',
] as const

export const csvHeaderLine = (): string => CSV_COLUMNS.join(',') + '\n'

/** One row as one newline-terminated line of the format. The formula guard (csvCell) is for csv only. */
export function exportLine(format: StreamFormat, r: ExportRow, guard = true): string {
  switch (format) {
    case 'csv': return CSV_COLUMNS.map(c => csvCell(r[c], guard)).join(',') + '\n'
    case 'ndjson': return JSON.stringify(r) + '\n'
    case 'userpass': return `${r.email}:${r.password}\n`
    case 'ulp': return `${r.url}:${r.email}:${r.password}\n`
  }
}

/**
 * The export as a pull-based stream: for csv the header line first, then one line per row, a chunk per batch, nothing queued beyond one chunk,
 * so ClickHouse is read no faster than the consumer reads. It stops after `cap` rows and closes the source (for ClickHouse that destroys the
 * stream); `cancel()` closes it too; an error in the source errors the stream.
 */
export function createExportStream(
  batches: AsyncIterable<ExportRow[]>,
  opts: { format: StreamFormat; guard?: boolean; cap?: number },
): ReadableStream<Uint8Array> {
  const cap = opts.cap ?? EXPORT_ROW_CAP
  const guard = opts.guard !== false
  const encoder = new TextEncoder()
  const iterator = batches[Symbol.asyncIterator]()
  let header = opts.format === 'csv'
  let written = 0
  let sourceDone = false

  /** Stops the source unless it already ended. */
  const closeSource = async () => {
    if (sourceDone) return
    sourceDone = true
    await iterator.return?.()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let text = header ? csvHeaderLine() : ''
        header = false
        // keep reading until there is something to send or the source ends, so an empty batch cannot leave the stream waiting
        while (text === '' && written < cap && !sourceDone) {
          const next = await iterator.next()
          if (next.done) { sourceDone = true; break }
          for (const row of next.value) {
            if (written >= cap) break
            text += exportLine(opts.format, row, guard)
            written++
          }
        }
        if (text !== '') controller.enqueue(encoder.encode(text))
        if (written >= cap || sourceDone) {
          await closeSource()
          controller.close()
        }
      } catch (err) {
        await closeSource().catch(() => {})
        controller.error(err)
      }
    },
    async cancel() {
      await closeSource()
    },
  })
}
