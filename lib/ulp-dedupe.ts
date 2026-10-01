/**
 * View-level exact-duplicate collapsing for the credential browser/search.
 *
 * "Exact duplicate" = same destination + same credential: identical
 * (url, email, password), where url is compared scheme- and
 * trailing-slash-insensitively. These survive in storage because every
 * storage-level dedup keys on source_file + imported_at to preserve
 * provenance (see lib/upload-dedup.ts), so
 * the same credential arriving in multiple combolist files shows up 2-3x in
 * results.
 *
 * lib/content-dedup.ts removes the existing copies from storage;
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
 * internally, just relocated from query-time to insert-time). With no filter
 * narrowing the view the count is a plain count() instead — see dedupeCountExpr.
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
 * Count expression for the result tally.
 *
 * - Not deduping: plain `count()`.
 * - Deduping a FILTERED search (`hasUserFilter`, the default when unspecified):
 *   distinct credentials via `uniq` (HyperLogLog). Filtered sets are pruned by
 *   indexes, and a not-yet-deduped duplicate inside one must not show up as an
 *   extra result ("2 results" for one displayed row).
 * - Deduping with NO user filter (the default Declutter + Unique browse view):
 *   plain `count()`. `ulp.credentials` is deduped at rest by lib/content-dedup.ts,
 *   so the row count already equals the distinct-credential count (measured
 *   2026-09-30: 1,393,449,551 rows and 1,393,449,551 distinct). Reading only the
 *   filter column instead of the 10.4 GiB hash column took this tally from 5.57 s
 *   to 0.19 s at 1.39B rows. The figure can exceed the true distinct count only by
 *   rows imported since the last rebuild, which the nightly tick bounds at
 *   DEDUP_MIN_EXCESS (~1%) — the same order as uniq's own error (measured
 *   -0.79% .. +0.32%).
 *
 * `onlyIf` turns either form into its -If variant (`uniqIf(hash, cond)` / `countIf(cond)`).
 */
export function dedupeCountExpr(dedupe: boolean, hasUserFilter = true, onlyIf?: string): string {
  const distinct = dedupe && hasUserFilter
  // `onlyIf` moves a row condition (the Declutter noise filter) from the WHERE into the aggregate, so one
  // scan of the search predicate can also produce the unrestricted count beside it.
  if (onlyIf) return distinct ? `uniqIf(${DEDUPE_BY}, ${onlyIf})` : `countIf(${onlyIf})`
  return distinct ? `uniq(${DEDUPE_BY})` : 'count()'
}
