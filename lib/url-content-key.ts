/**
 * Scheme- and trailing-slash-insensitive form of a credential's `url` column.
 * This is the URL component of the content-identity key shared by:
 *  - lib/content-dedup.ts (scheduled cron, destructive rewrite+swap) —
 *    imports this.
 *  - lib/clickhouse-migrations.ts (DDL v18 content_key_hash MATERIALIZED
 *    column) — imports this, so it can't drift out of sync.
 *  - docker/clickhouse/init/01-ulp-tables.sql (fresh-deploy content_key_hash
 *    column definition) — hand-copy this exact expression there too; plain
 *    SQL can't import TS.
 *  - scripts/dedup-credentials-content.sh (manual purge, destructive —
 *    hand-copy this exact expression there too; bash can't import TS)
 *
 * lib/ulp-dedupe.ts (view-level browser dedupe) no longer computes this
 * expression live — it references the content_key_hash column by name
 * instead (see DDL v18 in lib/clickhouse-migrations.ts).
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
