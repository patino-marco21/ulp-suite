import { URL_CONTENT_KEY } from '@/lib/url-content-key'

/**
 * View-level exact-duplicate collapsing for the credential browser/search.
 *
 * "Exact duplicate" = same destination + same credential: identical
 * (url, email, password), where url is compared scheme- and
 * trailing-slash-insensitively (see lib/url-content-key.ts) — http://,
 * https://, and no-scheme captures of the same host+path collapse to one row.
 * These survive in storage because every storage-level
 * dedup keys on source_file + imported_at to preserve provenance (see
 * app/api/admin/dedup/route.ts and lib/upload-dedup.ts), so the same credential
 * arriving in multiple combolist files shows up 2–3× in results.
 *
 * scripts/dedup-credentials-content.sh removes the existing copies from storage;
 * this keeps the VIEW unique going forward (a new overlapping import can't make
 * the browser show dupes before the next storage pass), without another rewrite.
 *
 * Implementation: `LIMIT 1 BY url, email, password` on the data query (one row
 * per unique credential, in the active sort order) + `uniq(...)` for the count
 * (HyperLogLog — cheap/low-memory at any scale; ~0.5% error is fine for a result
 * tally). The identifiers resolve to the SELECT's normalized url/email/password
 * aliases, so dedup matches what the user actually sees.
 *
 * Semantics: with keyset cursor pagination the LIMIT BY collapses dupes within
 * each page window. After the storage dedup that's effectively all of them; a
 * brand-new dupe split across a page boundary is the only gap, and the next
 * storage pass closes it. Storage stays the source of truth — nothing is deleted.
 */
export const DEDUPE_BY = `${URL_CONTENT_KEY}, email, password`

/** `LIMIT 1 BY url, email, password` (place between ORDER BY and LIMIT) or ''. */
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
