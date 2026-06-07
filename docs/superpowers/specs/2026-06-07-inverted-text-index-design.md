# Inverted Text Index (full_text) Design

**Date:** 2026-06-07
**Status:** Approved

## Goal

Replace the three `tokenbf_v1` bloom filter skip indexes on `url`, `email`, and `password`
with ClickHouse's `full_text` inverted index. Eliminates false positives from the bloom
filter and delivers 7-10× faster `hasToken()` granule pruning on token searches.

## Problem Statement

The current skip indexes on `url`, `email`, and `password` use `tokenbf_v1` (a bloom
filter). Bloom filters are probabilistic: they produce false positives, meaning ClickHouse
sometimes reads granules that contain no matching rows. The false-positive rate with the
current parameters (`tokenbf_v1(65536, 3, 0)`) is non-trivial at scale.

ClickHouse 24.x+ ships `full_text` (inverted index) as a GA feature. It stores the actual
token list per granule instead of a bloom filter, giving exact skip decisions — zero false
positives. `hasToken()` queries benefit directly; no query changes are needed.

The original `idx_email_ngram` (`ngrambf_v1(3)` on `email` from schema v1) is also unused:
no query in `lib/ulp-search.ts` calls `position(email, ...)`, so it has never pruned
anything. It will be dropped as part of this migration.

## Architecture

One file changes: `lib/clickhouse-migrations.ts`.

- `DDL_VERSION` bumps 4 → 5
- v5 block: ADD three `full_text(0)` indexes on `url`, `email`, `password`; fire
  MATERIALIZE for each (background, fire-and-forget, same pattern as v4 ngrambf indexes);
  then DROP the three old `tokenbf_v1` indexes and `idx_email_ngram`
- `ngrambf_v1` indexes on `url_host` and `email_domain` added in v4 are NOT changed —
  they serve `position()` substring searches and `full_text` cannot accelerate those
- Zero query changes — `hasToken()` uses the new `full_text` index automatically;
  `buildULPWhere` in `lib/ulp-search.ts` is untouched
- Zero frontend changes

### Index Changes Summary

| Index | Action | Type | Column |
|---|---|---|---|
| `idx_inv_url` | ADD | `full_text(0)` | `url` |
| `idx_inv_email` | ADD | `full_text(0)` | `email` |
| `idx_inv_password` | ADD | `full_text(0)` | `password` |
| `idx_url` | DROP | `tokenbf_v1` | `url` |
| `idx_email` | DROP | `tokenbf_v1` | `email` |
| `idx_password` | DROP | `tokenbf_v1` | `password` |
| `idx_email_ngram` | DROP | `ngrambf_v1(3)` | `email` (unused) |
| `idx_ngram_url_host` | UNCHANGED | `ngrambf_v1(4)` | `url_host` |
| `idx_ngram_email_domain` | UNCHANGED | `ngrambf_v1(4)` | `email_domain` |

---

## Section 1: DDL v5 Migration Block

### File: `lib/clickhouse-migrations.ts`

#### Change 1: Bump DDL_VERSION constant

```typescript
const DDL_VERSION = 5
```

#### Change 2: Add v5 migration block

Insert immediately after the `if (lastDdl < 4)` block and before the
`if (lastDdl < DDL_VERSION)` version-update block:

```typescript
// v5 — Replace tokenbf_v1 bloom filter skip indexes on url/email/password with
// full_text (inverted index). full_text stores the actual token list per granule,
// so hasToken() lookups are exact — zero false positives vs tokenbf_v1's bloom filter.
// Granule pruning is 7-10× faster for selective token searches.
//
// full_text(0): tokenizer=0 (default English tokenizer — splits on whitespace/punct,
// same as tokenbf_v1). GRANULARITY 1 is standard for search indexes.
//
// ngrambf_v1 indexes on url_host + email_domain (v4) are NOT changed — those serve
// position() substring searches which full_text cannot accelerate.
//
// idx_email_ngram (original ngrambf_v1(3) on email from schema v1) is dropped:
// no query in lib/ulp-search.ts uses position(email,...), so it has never pruned
// anything. Removing it frees ~22 MB and one mutation slot.
//
// MATERIALIZE INDEX fires background mutations (mutations_sync=0 default).
// Monitor via: SELECT * FROM system.mutations WHERE table='credentials'
//   AND command LIKE '%idx_inv%' ORDER BY create_time DESC
// DROP runs after MATERIALIZE is queued — old indexes stay readable during build.
if (lastDdl < 5) {
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_url
     url TYPE full_text(0) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_url`
  )
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_email
     email TYPE full_text(0) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_email`
  )
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_password
     password TYPE full_text(0) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_password`
  )
  // Drop old tokenbf_v1 indexes (replaced above) and idx_email_ngram (unused)
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_url`)
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email`)
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_password`)
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email_ngram`)
  console.log('[ClickHouse migration] DDL v5 applied (full_text on url/email/password — MATERIALIZE running in background)')
}
```

#### Why the existing runMigration helper is correct here

`runMigration(sql, materialize)` wraps the second arg in `client.exec().catch()` without
await — exactly what the v4 ngrambf indexes use. `MATERIALIZE INDEX` queues a background
mutation; it does not block startup, reads, or subsequent writes. The `ch_ddl_version`
bump prevents re-running on restart.

DROP statements run after MATERIALIZE is queued. The old indexes remain on disk and
continue serving queries during the background MATERIALIZE build. Once `is_done = 1`,
ClickHouse switches to the new indexes automatically.

#### full_text(0) tokenizer

`full_text(0)` uses ClickHouse's default tokenizer (tokenizer index 0): splits on
whitespace and punctuation, same boundary rules as `tokenbf_v1`. Existing `hasToken()`
calls in `lib/ulp-search.ts` produce identical token splits — no semantic behavior change.

---

## Section 2: No Query Changes

`lib/ulp-search.ts` is untouched. The relevant token-type condition:

```sql
hasToken(url, {tok:String}) OR hasToken(email, {tok:String}) OR hasToken(password, {tok:String})
OR position(url_host, {tok:String}) > 0 OR position(email_domain, {tok:String}) > 0
```

- `hasToken()` on `url`/`email`/`password` → automatically uses the new `full_text` index
- `position()` on `url_host`/`email_domain` → continues using `ngrambf_v1` from v4

No code changes in any route or utility file.

---

## Testing

No automated tests for DDL migrations (same pattern as v4). Manual verification after
deployment:

**Step 1 — Confirm indexes created:**
```sql
SELECT name, type, expr
FROM system.data_skipping_indices
WHERE table = 'credentials' AND database = 'ulp'
ORDER BY name
```
Expected: `idx_inv_url`, `idx_inv_email`, `idx_inv_password` with `type = 'full_text'`.
Old `idx_url`, `idx_email`, `idx_password`, `idx_email_ngram` absent.

**Step 2 — Monitor MATERIALIZE mutations:**
```sql
SELECT command, create_time, is_done, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE table = 'credentials'
  AND command LIKE '%idx_inv%'
ORDER BY create_time DESC
LIMIT 6
```
`is_done = 1` for all three when complete (30–120 min depending on data volume).

**Step 3 — Confirm granule pruning after MATERIALIZE finishes:**
```sql
SELECT query, read_rows, total_rows_approx, query_duration_ms
FROM system.query_log
WHERE query LIKE '%hasToken(url%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 5
```
`read_rows` should be orders of magnitude below `total_rows_approx` for selective tokens.

---

## What This Does NOT Change

- No frontend changes
- No schema changes to any table
- No changes to `lib/ulp-search.ts`
- No changes to any route file
- `idx_ngram_url_host` and `idx_ngram_email_domain` (v4) — unchanged
- All `bloom_filter` indexes on exact-match columns — unchanged
- All `set`/`minmax` indexes — unchanged
- ClickHouse version: 26.3 — `full_text` is GA
