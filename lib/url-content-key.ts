/**
 * Scheme- and trailing-slash-insensitive form of a credential's `url` column.
 * This is the URL component of the content-identity key shared by:
 *  - lib/ulp-dedupe.ts                     (view-level browser dedupe, reversible)
 *  - lib/content-dedup.ts                  (scheduled cron, destructive rewrite+swap)
 *  - scripts/dedup-credentials-content.sh  (manual purge, destructive — hand-copy this
 *    exact expression there too; bash can't import TS)
 *
 * The same physical credential is often captured with a different or missing
 * scheme, or a trailing slash, depending on what the logging tool recorded at
 * capture time — not a deliberate distinction in the credential itself.
 * url_scheme remains its own column for anyone who wants it; this key never
 * touches it. Path, query string, and case elsewhere in the URL are untouched.
 *
 * (?i:...) is RE2's scoped case-insensitive non-capturing group. If a future
 * ClickHouse upgrade ever rejects this syntax, drop the (?i:...) and match
 * '^https?://' alone — every example seen in this dataset already uses a
 * lowercase scheme.
 */
export const URL_CONTENT_KEY =
  `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
