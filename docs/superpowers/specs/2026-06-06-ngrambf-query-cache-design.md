# ngrambf_v1 Indexes + Extended query_cache Design

**Date:** 2026-06-06
**Status:** Approved

## Goal

Eliminate two unindexed `position()` full-table scans that occur on every token search
query, and extend ClickHouse's native query result cache to two high-cost, frequently
repeated routes.

## Problem Statement

Every search request whose query term parses as a `token` type (pure alphanumeric/hyphen
word — the common case) executes this condition via `lib/ulp-search.ts`:

```sql
hasToken(url, {tok})           -- ✅ tokenbf_v1 skip index
hasToken(email, {tok})         -- ✅ tokenbf_v1 skip index
hasToken(password, {tok})      -- ✅ tokenbf_v1 skip index
position(url_host, {tok}) > 0    -- ❌ no skip index — full 1.46B row scan
position(email_domain, {tok}) > 0 -- ❌ no skip index — full 1.46B row scan
```

The two `position()` conditions force ClickHouse to read every granule of the credentials
table (~22,300 granules at 65,536 rows each). Because they are connected by OR, both
columns must have a skip index for any granule pruning to occur — if either lacks an index,
ClickHouse cannot prove the OR-condition is false for any granule.

Additionally:
- `/api/similar` runs a 60-second full `GROUP BY password, ngramSimHash()` scan with no
  result caching; the same query repeats on every page load.
- `/api/reuse` (MV path) runs an expensive `uniqMerge` count query even against the
  materialized view; page 1 unfiltered is a hot path hit by all users.

## Architecture

Three changes, two subsystems, three files:

| Subsystem | Change | File |
|---|---|---|
| ClickHouse DDL | Add ngrambf_v1 skip indexes to `url_host` + `email_domain` | `lib/clickhouse-migrations.ts` |
| API — similar | Add `use_query_cache` SETTINGS to the one query | `app/api/similar/route.ts` |
| API — reuse | Add `use_query_cache` SETTINGS to Q1 + count (MV path only) | `app/api/reuse/route.ts` |

No frontend changes. No schema changes to backing tables. No changes to fallback paths.
The response shape, error handling, and auth logic for all affected routes are unchanged.

---

## Section 1: DDL v4 — ngrambf_v1 Indexes

### File: `lib/clickhouse-migrations.ts`

#### Change 1: Bump DDL_VERSION constant

```typescript
// Line ~19: change from 3 to 4
const DDL_VERSION = 4
```

#### Change 2: Add v4 migration block

Insert immediately after the `if (lastDdl < 3)` block and before the
`if (lastDdl < DDL_VERSION)` version-update block:

```typescript
// v4 — ngrambf_v1 skip indexes on url_host + email_domain.
// These two columns are position()-scanned on every token search query
// (see lib/ulp-search.ts buildULPWhere, type='token'). Without skip indexes
// the full 1.46 B row table is scanned for both conditions on every request.
//
// ngrambf_v1 builds a bloom filter of all 4-character n-grams per granule.
// ClickHouse checks the filter before reading granule data: if none of the
// search term's 4-grams appear in the filter, the granule is skipped entirely.
//
// BOTH columns must be indexed because the WHERE condition is:
//   position(url_host, tok) > 0 OR position(email_domain, tok) > 0
// With OR, ClickHouse can only skip a granule when it can prove BOTH sides
// are false. If email_domain has no index, no granules are ever skippable.
//
// Parameters: ngrambf_v1(n, size, hash_functions, seed)
//   n=4        — 4-char n-grams; terms shorter than 4 chars fall back to
//                full scan (same as today — no regression)
//   size=1024  — 1 KB bloom filter per granule → ~22 MB total for 1.46 B rows
//   hash_functions=1 — minimal false-positive overhead
//   seed=0     — default
//
// MATERIALIZE INDEX fires a background mutation (mutations_sync=0 default):
// exec() returns immediately after queuing; the build completes in background
// (30–120 min). Monitor via:
//   SELECT * FROM system.mutations WHERE table = 'credentials'
//   AND command LIKE '%idx_ngram%' ORDER BY create_time DESC
//
// The existing runMigration(sql, materialize) helper fires the second arg
// non-awaited — same pattern as the v2 bloom_filter MATERIALIZEs.
if (lastDdl < 4) {
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_url_host
     url_host TYPE ngrambf_v1(4, 1024, 1, 0) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_url_host`
  )
  await runMigration(
    `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_email_domain
     email_domain TYPE ngrambf_v1(4, 1024, 1, 0) GRANULARITY 1`,
    `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_email_domain`
  )
  console.log('[ClickHouse migration] DDL v4 applied (ngrambf_v1 on url_host + email_domain — MATERIALIZE running in background)')
}
```

#### Why the existing runMigration helper is correct here

`runMigration(sql, materialize)` wraps the second arg in `client.exec().catch()` without
await — exactly what the v2 bloom_filter indexes use. `MATERIALIZE INDEX` queues a
background mutation; it does not block startup, reads, or subsequent writes. The
`ch_ddl_version` bump prevents re-running on restart.

#### Index size estimate

```
1.46B rows / 65,536 rows-per-granule ≈ 22,300 granules
22,300 granules × 1,024 bytes = ~22 MB per index
Two indexes: ~44 MB total disk overhead
```

---

## Section 2: query_cache — `/api/similar`

### File: `app/api/similar/route.ts`

#### The query that gets cached

```typescript
// Current SETTINGS string (inside the executeQuery call):
SETTINGS max_execution_time = 60, timeout_overflow_mode = 'break'

// New SETTINGS string:
SETTINGS max_execution_time = 60, timeout_overflow_mode = 'break',
         use_query_cache = 1, query_cache_ttl = 600
```

Only this one SETTINGS change. No other modifications to the file.

#### TTL rationale

600 seconds (10 minutes). Password frequency across 1.46B rows changes only when
new credential data is imported (a rare, operator-triggered event). A 10-minute cache
eliminates repeated 60-second scans from users reloading the page or multiple analysts
opening it simultaneously.

#### Cache key scoping

ClickHouse's query cache key includes the query text and all parameterized values.
`minFreq` and `limit` are ClickHouse-parameterized (`{minFreq:UInt32}`, `{limit:UInt32}`),
so each distinct `minFreq`+`limit` combination caches independently. The default case
(`minFreq=2, limit=200`) is the hot path that benefits most.

#### What is not cached

The in-process JavaScript clustering logic (Hamming distance grouping) runs on every
request regardless — only the ClickHouse round-trip is cached. This is correct: the
clustering is cheap (O(n²) over ≤500 rows, < 5ms) and avoids serializing/deserializing
cluster state.

---

## Section 3: query_cache — `/api/reuse` (MV path only)

### File: `app/api/reuse/route.ts`

#### Two queries that get cached (inside the `Promise.all` block, MV path only)

**Q1 — paginated list:**
```typescript
// Current:
SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'

// New:
SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break',
         use_query_cache = 1, query_cache_ttl = 120
```

**Count query:**
```typescript
// Current:
SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'

// New:
SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break',
         use_query_cache = 1, query_cache_ttl = 120
```

#### TTL rationale

120 seconds (2 minutes). Short enough to reflect newly imported data within one import
cycle; long enough to absorb rapid page reloads and concurrent analyst sessions hitting
the same `page=1` unfiltered view (the hot path).

#### Cache key scoping

`emailFilter`, `pwFilter`, `limit`, `offset` all flow through as ClickHouse parameterized
values and are included in the cache key. Page 1 unfiltered (`offset=0`, no filters) is
the primary hot path. Filtered queries (where emailFilter or pwFilter are set) also cache
independently per filter value.

#### What is NOT cached

- **Q2 (domain samples):** depends on Q1 row results; params include exact email+password
  tuple values from Q1. Too specific per page/filter to benefit. Unchanged.
- **Fallback path:** the full-scan fallback on `ulp.credentials` (when MV isn't ready)
  is not cached. This is intentional: the fallback is a transitional state, caching it
  would mask MV warmup failures and return stale "0 results" responses to subsequent requests.

---

## Testing

### Manual verification for ngrambf_v1

After deployment, confirm the indexes exist and MATERIALIZE completed:

```sql
-- Check indexes are defined
SELECT name, type, expr
FROM system.data_skipping_indices
WHERE table = 'credentials' AND database = 'ulp'
  AND name IN ('idx_ngram_url_host', 'idx_ngram_email_domain')

-- Check mutation status (should show is_done=1 when complete)
SELECT command, create_time, is_done, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE table = 'credentials'
  AND command LIKE '%idx_ngram%'
ORDER BY create_time DESC
LIMIT 4
```

Confirm granule pruning is working after MATERIALIZE completes:

```sql
-- Run a token search and check read_rows vs total rows
SELECT query, read_rows, total_rows_approx, query_duration_ms
FROM system.query_log
WHERE query LIKE '%position(url_host%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 5
```

With a good skip index, `read_rows` should be orders of magnitude less than `total_rows_approx`
for selective search terms.

### Manual verification for query_cache

```sql
-- After hitting /api/similar twice, check cache hit count
SELECT query, result_rows, cache_hits
FROM system.query_cache
ORDER BY last_refreshed DESC
LIMIT 10
```

Or check query_log:
```sql
SELECT query, read_rows, query_cache_hits
FROM system.query_log
WHERE query LIKE '%ngramSimHash%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 4
```

---

## Implementation Order

1. **`lib/clickhouse-migrations.ts`** — bump DDL_VERSION + add v4 block (DDL must land
   first so it runs on startup before any route traffic)
2. **`app/api/similar/route.ts`** — add query_cache SETTINGS
3. **`app/api/reuse/route.ts`** — add query_cache SETTINGS to MV path
4. **Verification** — confirm indexes created, mutations queued, cache hits appearing

---

## What This Does NOT Change

- No frontend changes
- No schema changes to any table
- No changes to `lib/ulp-search.ts` (the position() calls stay; the index makes them fast)
- No changes to the similar route's clustering logic
- No changes to the reuse route's Q2 (domain samples), fallback path, or response shape
- PREWHERE: already auto-applied by `optimize_move_to_prewhere=1` (ClickHouse default) — no explicit hints needed
- Stats route: already has 5-minute app-level `getStatsCache()` — CH query_cache would be redundant
- v1/lookup: already has 60s query_cache — unchanged
