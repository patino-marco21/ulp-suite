/**
 * Deterministic per-batch deduplication token for ClickHouse inserts.
 *
 * ulp.credentials is now ReplicatedMergeTree, so ClickHouse keeps a dedup log
 * (replicated_deduplication_window) keyed on insert_deduplication_token. If the
 * SAME batch is inserted again within that window — e.g. the inbox watcher
 * reprocesses a file, a retry fires, or a request races — ClickHouse drops the
 * duplicate insert instead of appending duplicate rows.
 *
 * The token is a content hash of the exact rows being inserted (every field,
 * in order, including source_file and breach_name), so:
 *   - a byte-identical re-import of the same file produces the same token → deduped
 *   - any changed/new row produces a different token → inserted (never lost)
 *   - identical credentials from a DIFFERENT file differ (source_file is hashed) →
 *     kept, preserving cross-source provenance
 *
 * NOTE: this only catches re-inserts within ClickHouse's dedup window
 * (replicated_deduplication_window_seconds, default 1h). It is defense-in-depth
 * on top of the inbox claim/lock; it is NOT a substitute for the ulp.sources
 * "already imported" check for files re-uploaded long afterwards.
 */

import crypto from 'crypto'
import type { ULPCredential } from '@/lib/ulp-parser'

/** Rows hashed per md5.update call: one update per field made ten native calls per row (1.61 us/row), one per 2000 rows is 0.44. */
const ROWS_PER_UPDATE = 2000

export function batchDedupToken(credentials: ULPCredential[], breach_name: string): string {
  const h = crypto.createHash('md5')
  let chunk = ''
  let n = 0
  for (const c of credentials) {
    // The same byte stream as one update per field: each field is followed by a separator, so no field can pair a surrogate with the next one.
    chunk += c.url + '\x00' + c.email + '\x00' + c.password + '\x00' + c.domain + '\x00' + c.source_file + '\x01'
    if (++n === ROWS_PER_UPDATE) { h.update(chunk); chunk = ''; n = 0 }
  }
  if (n > 0) h.update(chunk)
  h.update('\x02')
  h.update(breach_name)
  return h.digest('hex')
}
