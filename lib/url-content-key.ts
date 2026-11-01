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

// ── Both keys as SQL over any column expressions ────────────────────────────────────────────────────
// docs/superpowers/specs/2026-11-01-near-duplicates-design.md. The normalised key is the same credential once a leading `www.`, capitals in the
// host and in the login, and any number of trailing slashes are ignored; the port, the path and its capitals, the query, the fragment and the
// password are compared as typed. `concat` cannot confuse two keys: the rest always starts with `/`, `?` or `#`, or is empty, because the host
// part stops at the first of them. `lower` is ASCII only, as measured. Hand copy: docker/clickhouse/init/01-ulp-tables.sql (a test locks it).

/** The three values a key is computed from: column names for the table and the stage, other expressions (`unhex(u)`) for a script. */
export interface KeyColumns {
  url: string
  email: string
  password: string
}

export const TABLE_KEY_COLUMNS: KeyColumns = { url: 'url', email: 'email', password: 'password' }

/** The exact key (content_key_hash): the URL without its scheme and one trailing slash, the login and the password as stored. */
export function exactKeySql(c: KeyColumns = TABLE_KEY_COLUMNS): string {
  return `cityHash64(replaceRegexpOne(replaceRegexpOne(${c.url}, '^(?i:https?://)', ''), '/$', ''), ${c.email}, ${c.password})`
}

const withoutScheme = (url: string) => `replaceRegexpOne(${url}, '^(?i:https?://)', '')`

/** The host as the normalised key sees it: no leading `www.`, lower case, up to the first `/`, `?` or `#` (a port and a `user:pw@` stay in it). */
export function normHostSql(url: string = TABLE_KEY_COLUMNS.url): string {
  return String.raw`lower(extract(${withoutScheme(url)}, '^(?i:www\\.)?([^/?#]*)'))`
}

/** The rest of the URL: path, query and fragment as typed, without any trailing slash. */
export function normRestSql(url: string = TABLE_KEY_COLUMNS.url): string {
  return String.raw`extract(${withoutScheme(url)}, '^[^/?#]*(.*?)/*$')`
}

/** The normalised key (norm_key_hash). */
export function normKeySql(c: KeyColumns = TABLE_KEY_COLUMNS): string {
  return `cityHash64(concat(${normHostSql(c.url)}, ${normRestSql(c.url)}), lower(${c.email}), ${c.password})`
}

/** The normalised key over the table's own columns: what DDL v30, the stage and the init SQL define. */
export const NORM_CONTENT_KEY = normKeySql()
