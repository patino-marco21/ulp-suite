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

export function batchDedupToken(credentials: ULPCredential[], breach_name: string): string {
  const h = crypto.createHash('md5')
  for (const c of credentials) {
    h.update(c.url)
    h.update('\x00')
    h.update(c.email)
    h.update('\x00')
    h.update(c.password)
    h.update('\x00')
    h.update(c.domain)
    h.update('\x00')
    h.update(c.source_file)
    h.update('\x01')
  }
  h.update('\x02')
  h.update(breach_name)
  return h.digest('hex')
}
