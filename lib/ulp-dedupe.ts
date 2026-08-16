/**
 * View-level exact-duplicate collapsing for the credential browser/search.
 *
 * "Exact duplicate" = same destination + same credential: identical
 * (url, email, password), where url is compared scheme- and
 * trailing-slash-insensitively. These survive in storage because every
 * storage-level dedup keys on source_file + imported_at to preserve
 * provenance (see app/api/admin/dedup/route.ts and lib/upload-dedup.ts), so
 * the same credential arriving in multiple combolist files shows up 2-3x in
 * results.
 *
 * scripts/dedup-credentials-content.sh removes the existing copies from storage;
 * this keeps the VIEW unique going forward (a new overlapping import can't make
 * the browser show dupes before the next storage pass), without another rewrite.
 *
 * Implementation: `content_key_hash` is a MATERIALIZED UInt64 column
 * (cityHash64 of the same scheme/slash-insensitive url + email + password —
 * see docker/clickhouse/init/01-ulp-tables.sql and DDL v18 in
 * lib/clickhouse-migrations.ts), computed once at insert instead of live per
 * query. `LIMIT 1 BY <hash>` on the data query (one row per unique credential,
 * in the active sort order) + `uniq(<hash>)` for the count (HyperLogLog —
 * cheap/low-memory at any scale; ~0.5% error is fine for a result tally,
 * unchanged from before — this is the same hash uniq() already computed
 * internally, just relocated from query-time to insert-time).
 *
 * Semantics: with keyset cursor pagination the LIMIT BY collapses dupes within
 * each page window. After the storage dedup that's effectively all of them; a
 * brand-new dupe split across a page boundary is the only gap, and the next
 * storage pass closes it. Storage stays the source of truth — nothing is deleted.
 */
export const DEDUPE_BY = 'content_key_hash'

/** `LIMIT 1 BY <content key>` (place between ORDER BY and LIMIT) or ''. */
export function dedupeLimitBy(dedupe: boolean): string {
  return dedupe ? `LIMIT 1 BY ${DEDUPE_BY}` : ''
}

/**
 * Count expression for the result tally: distinct credentials when deduping
 * (`uniq` — approximate but fast/low-memory), else plain `count()`.
 */
export function dedupeCountExpr(dedupe: boolean): string {
  return dedupe ? `uniq(${DEDUPE_BY})` : 'count()'
}
