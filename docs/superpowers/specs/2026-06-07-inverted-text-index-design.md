# Inverted Text Index Design

**Date:** 2026-06-07
**Status:** Approved — implemented as DDL v5 + v6

> **⚠️ Post-implementation note (2026-06-07):** ClickHouse renamed the inverted index type
> from `full_text()` to `text(tokenizer = ...)` in version 26.2. DDL v5 used `full_text(0)`
> which silently failed on ClickHouse 26.3 (error swallowed by `runMigration`), while the
> DROP of old `tokenbf_v1` indexes succeeded — leaving the table with no skip indexes.
> DDL v6 was added as a follow-up fix using the correct `text(tokenizer = splitByNonAlpha,
> preprocessor = lower(col))` syntax. See Architecture section for updated DDL.

## Goal

Replace the three `tokenbf_v1` bloom filter skip indexes on `url`, `email`, and `password`
with ClickHouse's `text` inverted index. Eliminates false positives from the bloom
filter and delivers 7-10× faster `hasToken()` granule pruning on token searches.

## Problem Statement

The current skip indexes on `url`, `email`, and `password` use `tokenbf_v1` (a bloom
filter). Bloom filters are probabilistic: they produce false positives, meaning ClickHouse
sometimes reads granules that contain no matching rows. The false-positive rate with the
current parameters (`tokenbf_v1(65536, 3, 0)`) is non-trivial at scale.

ClickHouse ships a `text` inverted index (GA in 26.2+, formerly called `full_text` in 24.x–25.x).
It stores the actual token list per granule instead of a bloom filter, giving exact skip
decisions — zero false positives. `hasToken()` queries benefit directly; no query changes
are needed. The correct syntax in ClickHouse 26.x is
`TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(col))`.

The original `idx_email_ngram` (`ngrambf_v1(3)` on `email` from schema v1) is also unused:
no query in `lib/ulp-search.ts` calls `position(email, ...)`, so it has never pruned
anything. It will be dropped as part of this migration.

## Architecture

One file changes: `lib/clickhouse-migrations.ts`.

- `DDL_VERSION` bumps 4 → 5 → 6 (v5 planned but failed; v6 is the working implementation)
- v5 block (historical — silently failed on 26.x): tried `full_text(0)` syntax; successfully
  dropped old `tokenbf_v1` indexes but ADD INDEX failed → no skip indexes left
- v6 block (actual fix): DROP any partial v5 artifacts; ADD three
  `text(tokenizer = splitByNonAlpha, preprocessor = lower(col))` indexes on `url`, `email`,
  `password`; fire MATERIALIZE for each (background, fire-and-forget)
- `ngrambf_v1` indexes on `url_host` and `email_domain` added in v4 are NOT changed —
  they serve `position()` substring searches which `text()` cannot accelerate
- Zero query changes — `hasToken()` uses the new `text` index automatically;
  `buildULPWhere` in `lib/ulp-search.ts` is untouched
- Zero frontend changes

### Index Changes Summary

| Index | Action | Type | Column |
|---|---|---|---|
| `idx_inv_url` | ADD (DDL v6) | `text(splitByNonAlpha, lower)` | `url` |
| `idx_inv_email` | ADD (DDL v6) | `text(splitByNonAlpha, lower)` | `email` |
| `idx_inv_password` | ADD (DDL v6) | `text(splitByNonAlpha, lower)` | `password` |
| `idx_url` | DROP | `tokenbf_v1` | `url` |
| `idx_email` | DROP | `tokenbf_v1` | `email` |
| `idx_password` | DROP | `tokenbf_v1` | `password` |
| `idx_email_ngram` | DROP | `ngrambf_v1(3)` | `email` (unused) |
| `idx_ngram_url_host` | UNCHANGED | `ngrambf_v1(4)` | `url_host` |
| `idx_ngram_email_domain` | UNCHANGED | `ngrambf_v1(4)` | `email_domain` |

---

## Section 1: DDL Migration Block (v5 + v6)

### File: `lib/clickhouse-migrations.ts`

#### DDL v5 (historical — failed on ClickHouse 26.x)

v5 used `TYPE full_text(0)` which is not a valid index type in ClickHouse 26.2+.
The `runMigration` try/catch silently swallowed the error; the DROP INDEX calls for the
old `tokenbf_v1` indexes still succeeded; `ch_ddl_version` was bumped to 5. Result: table
left with no skip indexes → every `hasToken()` search full-scanned 1.46 B rows → timeout.

#### DDL v6 (actual working implementation)

```typescript
if (lastDdl < 6) {
  // Remove any partial or incorrectly-typed v5 artifacts first
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_url`)
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_email`)
  await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_password`)
  // Re-create with ClickHouse 26.x text() syntax
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_url
     url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_url`
  )
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_email
     email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email)) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_email`
  )
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_password
     password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password)) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_password`
  )
}
```

#### text() tokenizer and preprocessor

`text(tokenizer = splitByNonAlpha)` splits on non-alphanumeric ASCII characters — same
boundary rules as the old `tokenbf_v1`. `preprocessor = lower(col)` stores tokens in
lowercase, matching the `lower(value)` that `hasToken()` queries always pass in
`lib/ulp-search.ts`. This ensures correct index pruning for both URLs/emails
(predominantly lowercase) and mixed-case passwords.

`MATERIALIZE INDEX` fires background mutations. The `ch_ddl_version` bump prevents
re-running on restart. Idempotent: IF EXISTS / IF NOT EXISTS guards are safe on
repeated restarts.

---

## Section 2: No Query Changes

`lib/ulp-search.ts` is untouched. The relevant token-type condition:

```sql
hasToken(url, {tok:String}) OR hasToken(email, {tok:String}) OR hasToken(password, {tok:String})
OR position(url_host, {tok:String}) > 0 OR position(email_domain, {tok:String}) > 0
```

- `hasToken()` on `url`/`email`/`password` → automatically uses the new `text` index
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
Expected: `idx_inv_url`, `idx_inv_email`, `idx_inv_password` with `type = 'text'`.
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
- ClickHouse version: 26.3 — `text(tokenizer = splitByNonAlpha)` index (DDL v6)
