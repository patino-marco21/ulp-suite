# Precompute the credentials dedupe/count identity key

- **Date:** 2026-08-15
- **Status:** Approved (design)
- **Scope:** Add a `content_key_hash` materialized column to `ulp.credentials` (DDL v18) and repoint `lib/ulp-dedupe.ts`'s two SQL-generating functions at it. No changes to any API route file.

## Problem

The Credentials Browser's default view (Declutter + "Unique" both on-by-default) shows a total count computed via `uniq(${DEDUPE_BY})`, where `DEDUPE_BY = ${URL_CONTENT_KEY}, email, password` and `URL_CONTENT_KEY` is a double-regex expression (`replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`) evaluated live, per row, with no bound — `app/api/credentials/route.ts`'s count query has no `LIMIT`. At current scale (1.48B rows in `ulp.credentials`), this takes ~58-63s, confirmed by direct reproduction against the live instance (query returned `843020260`, matching the UI exactly, in 62.9s real time).

The same `DEDUPE_BY` expression also drives `LIMIT 1 BY` in the row-fetch query (`dedupeLimitBy`) and in `app/api/export/route.ts`'s dedup path. The row-fetch itself is NOT slow today (confirmed: 1.5s for the exact default-view query) because the default sort (`domain_asc`) is primary-key-leading and lets ClickHouse stop early after 200 post-dedupe rows — but any other filter combination with `dedupe=1` (a login_type filter, tier filter, or any WHERE clause that doesn't narrow the scan much) would hit the same unbounded-regex cost, since `is_noise = 0` alone barely reduces the scanned row count.

This is the same failure mode already fixed once in this codebase for `is_noise` (`b29bcf4`, "a 78.9s browse, with the no-LIMIT count() paying full cost") — that fix moved an expensive per-row WHERE predicate into a column computed once at insert (`MATERIALIZED`). The dedupe/count path never got the equivalent treatment.

## Decisions made during brainstorming

- **Single `UInt64` hash column, not a raw normalized-URL string column.** `cityHash64(url_content_key_expr, email, password)` combines all three dedupe-identity components into one 8-byte value — matches what `uniq()` already computes internally today (no new collision risk, just relocated from query-time to insert-time), and is meaningfully cheaper on disk than storing the normalized URL text again across 1.48B+ rows, given the disk-headroom analysis from the same session (~11-12GB for the hash column vs. materially more for a string column, against 549GB free).
- **Considered and rejected (for now): caching the count instead of fixing the root cause.** A periodic background job (piggybacking on the existing 15-minute monitor cron in `instrumentation.ts`) could serve a stale-but-fast count for the exact no-filter default view. Rejected as the primary fix because it only helps that one specific filter combination — this app has a dozen+ filter params and dedupe is default-on, so any other filter with `dedupe=1` would still hit the live unbounded `uniq()` call. The materialized-column fix is universal across all filter combinations; a cache isn't.
- **Scope boundary: `lib/content-dedup.ts` (scheduled destructive rewrite+swap dedup) and `scripts/dedup-credentials-content.sh` are NOT touched.** Both use the same content-identity concept (via `lib/url-content-key.ts`'s `URL_CONTENT_KEY`, documented as shared across all three consumers — see `2026-06-28-credential-url-content-key-design.md`) but are separate, currently-inactive (`CONTENT_DEDUP_APPLY=false`) pipelines with their own design history. This design only changes the live, user-facing view-level dedupe (`lib/ulp-dedupe.ts`).

## Design

**`docker/clickhouse/init/01-ulp-tables.sql`** — add, alongside the existing `is_noise` materialized column:

```sql
-- content_key_hash: precomputed dedupe/count identity for the browser's
-- default-on "Unique" filter (mirrors lib/ulp-dedupe.ts DEDUPE_BY). Computed
-- ONCE here instead of live per query — see DDL v18 in clickhouse-migrations.ts
-- for why (58s-class unbounded uniq() scan; same class of problem is_noise
-- (v12) already fixed for Declutter).
content_key_hash UInt64 MATERIALIZED cityHash64(
    replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''),
    email, password
),
```

**`lib/clickhouse-migrations.ts`** — DDL v18, following the exact v12 pattern:

```sql
ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS content_key_hash UInt64 MATERIALIZED cityHash64(
  replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password
)
ALTER TABLE ulp.credentials MATERIALIZE COLUMN content_key_hash
```

Runs automatically on next app startup, same as v12/13/15 — background mutation; old parts compute the column on-the-fly (correct, just not yet fast) until rewritten by the mutation.

**`lib/ulp-dedupe.ts`** — the only application-code file that changes:

```ts
export const DEDUPE_BY = 'content_key_hash'

export function dedupeLimitBy(dedupe: boolean): string {
  return dedupe ? `LIMIT 1 BY ${DEDUPE_BY}` : ''
}

export function dedupeCountExpr(dedupe: boolean): string {
  return dedupe ? `uniq(${DEDUPE_BY})` : 'count()'
}
```

`app/api/credentials/route.ts` and `app/api/export/route.ts` call these two functions as black boxes and need no changes themselves — both already import `dedupeLimitBy`/`dedupeCountExpr` rather than building the SQL inline.

**Rollout / monitoring** — the backfill isn't covered by `lib/clickhouse-memory-guard.ts` (that paces ingest, not mutations); monitor it via the existing `/api/monitoring/mutations` endpoint / `system.mutations`. Expect it to take meaningfully longer than the June `is_noise` backfill given the table has grown substantially since then — no hard duration estimate, watch rather than assume.

**Testing** — new `scripts/diagnose-dedupe-count-perf.sh` timing old-expression vs. new-column (mirrors `scripts/diagnose-noise-rows.sh`'s pattern from the `is_noise` fix), plus updated `__tests__/ulp-dedupe.test.ts` asserting both functions emit `content_key_hash`.

## Out of scope

- `lib/content-dedup.ts` and `scripts/dedup-credentials-content.sh` — separate, currently-inactive pipelines (see Decisions above).
- `lib/url-content-key.ts` / `URL_CONTENT_KEY` — stays as-is, still used by the two out-of-scope consumers above.
- Caching the count (considered, rejected — see Decisions above).
- Any change to `app/api/credentials/route.ts` or `app/api/export/route.ts` — both already call the right helper functions; only the helpers' internals change.
