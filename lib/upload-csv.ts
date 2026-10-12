import type { ULPCredential } from '@/lib/ulp-parser'

/** Rows per string handed to the HTTP stream: one stream chunk per row cost 1.57 us/row, 2000 rows per chunk 0.57. */
export const CSV_ROWS_PER_CHUNK = 2000

/** One CSV field for ClickHouse: wrapped in double quotes, inner quotes doubled. A value without a quote skips the regex. */
export function csvField(v: string): string {
  return v.indexOf('"') === -1 ? '"' + v + '"' : '"' + v.replace(/"/g, '""') + '"'
}

/** The six columns of ulp.credentials the importer writes, in the order insertBatch names them. `breachField` is csvField(breach_name), computed once. */
export function csvRow(c: ULPCredential, breachField: string): string {
  return csvField(c.url) + ',' + csvField(c.email) + ',' + csvField(c.password) + ',' + csvField(c.domain) + ',' + csvField(c.source_file) + ',' + breachField + '\n'
}

export function* csvChunks(credentials: ULPCredential[], breach_name: string, rowsPerChunk = CSV_ROWS_PER_CHUNK): Generator<string> {
  const breachField = csvField(breach_name)
  let chunk = ''
  let n = 0
  for (const c of credentials) {
    chunk += csvRow(c, breachField)
    if (++n === rowsPerChunk) { yield chunk; chunk = ''; n = 0 }
  }
  if (n > 0) yield chunk
}
