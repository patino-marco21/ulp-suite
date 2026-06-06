# ngrambf_v1 + Query Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ngrambf_v1(4,1024,1,0) skip indexes to url_host and email_domain (DDL v4) to eliminate two unindexed full-table scans on every token search, and extend ClickHouse query result caching to /api/similar (10-min TTL) and the /api/reuse MV path (2-min TTL).

**Architecture:** Three independent file changes. The DDL migration uses the existing `runMigration(sql, materialize?)` helper — the second arg fires MATERIALIZE INDEX as a non-awaited background mutation, identical to the v2 bloom_filter pattern. The two route changes append `use_query_cache` settings to specific SQL SETTINGS strings with no logic, response shape, or fallback changes.

**Tech Stack:** ClickHouse (ngrambf_v1 skip indexes, use_query_cache), TypeScript, Next.js 15 App Router

---

## File Map

| File | Action | What changes |
|---|---|---|
| `lib/clickhouse-migrations.ts` | Modify | `DDL_VERSION` 3→4; add `if (lastDdl < 4)` block with two `runMigration` calls |
| `app/api/similar/route.ts` | Modify | SETTINGS on one query: append `use_query_cache = 1, query_cache_ttl = 600` |
| `app/api/reuse/route.ts` | Modify | SETTINGS on Q1 + count in MV path: append `use_query_cache = 1, query_cache_ttl = 120` |

No new files. No frontend changes. No changes to `lib/ulp-search.ts`, `lib/mv-ready.ts`, or any other file.

---

### Task 1: DDL v4 — ngrambf_v1 skip indexes

**Files:**
- Modify: `lib/clickhouse-migrations.ts`

**Context:**
The credentials table has two columns that are substring-scanned on every token search
(`position(url_host, tok) > 0 OR position(email_domain, tok) > 0` in `lib/ulp-search.ts`
`buildULPWhere`). Neither has a skip index, so every search reads all ~22,300 granules.
Because the two conditions are ORed, both columns must be indexed — ClickHouse can only
skip a granule when it can prove both OR branches are false.

The `runMigration(sql, materialize?)` helper (around line 136 of the file) runs `sql`
awaited and fires `materialize` non-awaited via `.catch()` — the MATERIALIZE INDEX
queues a background mutation in `system.mutations` and returns immediately. This is the
same pattern used by the v2 bloom_filter indexes at lines 168–176.

The v4 block must be inserted AFTER the closing `}` of the `if (lastDdl < 3)` block
and BEFORE the `if (lastDdl < DDL_VERSION)` version-update block.

- [ ] **Step 1: Verify TypeScript compiles before any changes (baseline)**

```bash
cd C:/Users/coler/Desktop/vault-refactor/bron-vault
npx tsc --noEmit
```

Expected: exit code 0. If pre-existing errors appear, note them — they are not caused by this task.

- [ ] **Step 2: Bump DDL_VERSION from 3 to 4**

In `lib/clickhouse-migrations.ts`, find line ~19:

```typescript
const DDL_VERSION = 3
```

Change to:

```typescript
const DDL_VERSION = 4
```

- [ ] **Step 3: Insert the v4 migration block**

In `lib/clickhouse-migrations.ts`, find this exact text (end of v3 block, around line 250):

```typescript
    console.log('[ClickHouse migration] DDL v3 applied (4 MV tables + 4 MVs)')
  }

  if (lastDdl < DDL_VERSION) {
```

Replace it with:

```typescript
    console.log('[ClickHouse migration] DDL v3 applied (4 MV tables + 4 MVs)')
  }

  // v4 — ngrambf_v1 skip indexes on url_host + email_domain.
  // These two columns are position()-scanned on every token search query
  // (see lib/ulp-search.ts buildULPWhere type='token'). Without skip indexes
  // the full 1.46 B row table must be scanned for both conditions per request.
  //
  // ngrambf_v1 builds a bloom filter of all 4-character n-grams per granule.
  // ClickHouse checks the filter before reading granule data: if none of the
  // search term's 4-grams appear in the filter, the granule is skipped entirely.
  //
  // BOTH columns are indexed because the WHERE condition is:
  //   position(url_host, tok) > 0 OR position(email_domain, tok) > 0
  // With OR, ClickHouse can only skip a granule when it can prove BOTH sides
  // are false — indexing only one column leaves the other side unconstrained.
  //
  // Parameters: ngrambf_v1(n=4, size=1024, hash_functions=1, seed=0)
  //   n=4        — 4-char n-grams; shorter terms fall back to full scan (no regression)
  //   size=1024  — 1 KB bloom filter per granule → ~22 MB total at 1.46 B rows
  //   GRANULARITY 1 — one filter per 65,536-row granule (matches all existing indexes)
  //
  // MATERIALIZE INDEX fires a background mutation (mutations_sync=0 default).
  // runMigration fires the second arg non-awaited (.catch()) — exec returns after
  // queueing, build completes in 30–120 min in background.
  // Monitor: SELECT command, is_done, parts_to_do FROM system.mutations
  //          WHERE table = 'credentials' AND command LIKE '%idx_ngram%'
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

  if (lastDdl < DDL_VERSION) {
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit code 0, no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "$(cat <<'EOF'
feat: DDL v4 — ngrambf_v1(4,1024,1,0) skip indexes on url_host + email_domain

Eliminates two full-table scans on every token search query.
position(url_host, tok) and position(email_domain, tok) previously
read all ~22k granules; ngrambf_v1 allows ClickHouse to skip
granules that contain none of the search term's 4-grams.
Both columns indexed because they appear in an OR condition.
MATERIALIZE INDEX fires as a background mutation on first startup.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: query_cache for /api/similar

**Files:**
- Modify: `app/api/similar/route.ts`

**Context:**
This route does `GROUP BY password, ngramSimHash(password, 3)` across all 1.46B credential
rows — up to 60 seconds per request. Password frequency changes only when new data is
imported. ClickHouse's `use_query_cache = 1` caches the result keyed on query text plus
all parameterized values (`minFreq`, `limit`). A 10-minute TTL eliminates repeat scans
from analysts reloading the page. Only the one `executeQuery` call gets this — the
in-process JavaScript Hamming distance clustering runs on every request regardless (it's
cheap: O(n²) over ≤500 rows, < 5ms).

- [ ] **Step 1: Locate the query in app/api/similar/route.ts**

Open `app/api/similar/route.ts`. Find the `executeQuery` call around line 49. The current SETTINGS line reads:

```
      SETTINGS max_execution_time = 60, timeout_overflow_mode = 'break'
```

- [ ] **Step 2: Add query_cache SETTINGS**

Change the `executeQuery` block from:

```typescript
    const rows = await executeQuery(`
      SELECT
        password,
        count() AS freq,
        toString(ngramSimHash(password, 3)) AS phash
      FROM ulp.credentials
      GROUP BY password
      HAVING freq >= {minFreq:UInt32}
      ORDER BY freq DESC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 60, timeout_overflow_mode = 'break'
    `, { minFreq, limit }) as Array<{ password: string; freq: string; phash: string }>
```

To:

```typescript
    const rows = await executeQuery(`
      SELECT
        password,
        count() AS freq,
        toString(ngramSimHash(password, 3)) AS phash
      FROM ulp.credentials
      GROUP BY password
      HAVING freq >= {minFreq:UInt32}
      ORDER BY freq DESC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 60, timeout_overflow_mode = 'break',
               use_query_cache = 1, query_cache_ttl = 600
    `, { minFreq, limit }) as Array<{ password: string; freq: string; phash: string }>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit code 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/similar/route.ts
git commit -m "$(cat <<'EOF'
perf: add use_query_cache=1 (10 min TTL) to /api/similar

The GROUP BY password + ngramSimHash() full scan takes up to 60s.
Password frequency changes only on new data imports; a 10-minute
ClickHouse query cache eliminates repeat scans from page reloads
and concurrent analysts.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: query_cache for /api/reuse (MV path only)

**Files:**
- Modify: `app/api/reuse/route.ts`

**Context:**
This file has two code paths:
- **Fallback path** (`if (!ready) { ... return }`, lines ~28–84): full scan of
  `ulp.credentials` when the MV isn't warm. DO NOT touch this path.
- **MV path** (after the `if (!ready)` block): uses `ulp.reuse_pairs`. This path
  has a `Promise.all([Q1, count])` — both queries get `use_query_cache = 1, query_cache_ttl = 120`.

Q2 (domain samples for the current page, ~line 132 onward) is NOT cached — it's
pair-specific and fires serial after Q1.

TTL is 120 seconds (2 minutes): short enough to reflect newly imported data within
one import cycle, long enough to absorb rapid page reloads and simultaneous analyst
sessions on the default page-1 unfiltered view.

- [ ] **Step 1: Locate Q1 in the MV path Promise.all**

Open `app/api/reuse/route.ts`. Find the `Promise.all` around line 104. Q1 is the
first argument — a `SELECT email, password, uniqMerge(domain_hll) AS domain_count FROM ulp.reuse_pairs` query. Its current SETTINGS line reads:

```
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'
```

- [ ] **Step 2: Add query_cache to Q1**

Change Q1 from:

```typescript
      executeQuery(`
        SELECT email, password, uniqMerge(domain_hll) AS domain_count
        FROM ulp.reuse_pairs
        ${mvWhere}
        GROUP BY email, password
        HAVING domain_count > 1
        ORDER BY domain_count DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'
      `, mvQueryParams),
```

To:

```typescript
      executeQuery(`
        SELECT email, password, uniqMerge(domain_hll) AS domain_count
        FROM ulp.reuse_pairs
        ${mvWhere}
        GROUP BY email, password
        HAVING domain_count > 1
        ORDER BY domain_count DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break',
                 use_query_cache = 1, query_cache_ttl = 120
      `, mvQueryParams),
```

- [ ] **Step 3: Add query_cache to the count query**

The count query is the second argument of the same `Promise.all`. Change it from:

```typescript
      executeQuery(`
        SELECT count() AS total
        FROM (
          SELECT email, password
          FROM ulp.reuse_pairs
          ${mvWhere}
          GROUP BY email, password
          HAVING uniqMerge(domain_hll) > 1
        )
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'
      `, mvCountParams),
```

To:

```typescript
      executeQuery(`
        SELECT count() AS total
        FROM (
          SELECT email, password
          FROM ulp.reuse_pairs
          ${mvWhere}
          GROUP BY email, password
          HAVING uniqMerge(domain_hll) > 1
        )
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break',
                 use_query_cache = 1, query_cache_ttl = 120
      `, mvCountParams),
```

- [ ] **Step 4: Confirm fallback path is unchanged**

In `app/api/reuse/route.ts`, scroll to the `if (!ready) {` block (around line 28).
Confirm both queries inside the fallback still have their original SETTINGS with NO
`use_query_cache`. The rows query SETTINGS should be:

```
        SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break'
```

And the count query SETTINGS should be:

```
        SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break'
```

If `use_query_cache` appears in either fallback query, remove it before continuing.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit code 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/reuse/route.ts
git commit -m "$(cat <<'EOF'
perf: add use_query_cache=1 (2 min TTL) to /api/reuse MV path

The uniqMerge count query is expensive even against the MV.
Page 1 unfiltered is a hot path hit by all analysts simultaneously.
2-minute TTL absorbs repeat loads while reflecting new imports promptly.
Fallback path (full scan during MV warmup) is intentionally uncached.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Post-deployment verification

**Context:**
Run these SQL queries via clickhouse-client or the admin SQL interface after deploying.
MATERIALIZE INDEX runs as a background mutation — it may take 30–120 minutes to complete
on 1.46B rows. The indexes ARE usable for new parts immediately; only existing parts
need the background build to benefit.

- [ ] **Step 1: Verify both ngrambf_v1 indexes exist**

```sql
SELECT name, type, expr
FROM system.data_skipping_indices
WHERE database = 'ulp'
  AND table = 'credentials'
  AND name IN ('idx_ngram_url_host', 'idx_ngram_email_domain')
ORDER BY name
```

Expected — 2 rows:
```
name                    type                        expr
idx_ngram_email_domain  ngrambf_v1(4, 1024, 1, 0)  email_domain
idx_ngram_url_host      ngrambf_v1(4, 1024, 1, 0)  url_host
```

If 0 rows: the DDL v4 migration did not run. Check the SQLite setting:
```sql
-- In the app's SQLite DB (not ClickHouse):
SELECT value FROM app_settings WHERE key = 'ch_ddl_version'
```
If it shows `3`, the migration hasn't run — restart the server to trigger it.

- [ ] **Step 2: Check MATERIALIZE INDEX mutation status**

```sql
SELECT
  command,
  create_time,
  is_done,
  parts_to_do,
  parts_done,
  latest_fail_reason
FROM system.mutations
WHERE database = 'ulp'
  AND table = 'credentials'
  AND (command LIKE '%idx_ngram_url_host%'
       OR command LIKE '%idx_ngram_email_domain%')
ORDER BY create_time DESC
LIMIT 4
```

Expected: 2 rows. `is_done = 1` and `parts_to_do = 0` when complete. `latest_fail_reason` should be empty.
While building: `is_done = 0`, `parts_to_do > 0` — this is normal; re-run periodically to track progress.

- [ ] **Step 3: Verify granule pruning after MATERIALIZE completes**

Run a token search from the UI (e.g., search "google"). Then:

```sql
SELECT
  query,
  read_rows,
  total_rows_approx,
  query_duration_ms
FROM system.query_log
WHERE query LIKE '%position(url_host%'
  AND type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 5 MINUTE
ORDER BY event_time DESC
LIMIT 5
```

Expected: `read_rows` is a small fraction of `total_rows_approx` (~1.46B). A selective
term like "google" should read < 5% of total rows. Before this change, `read_rows ≈ total_rows_approx`.

- [ ] **Step 4: Verify query_cache for /api/similar**

Load the similar-passwords page twice. Then:

```sql
SELECT
  query,
  read_rows,
  query_cache_hits,
  query_duration_ms
FROM system.query_log
WHERE query LIKE '%ngramSimHash%'
  AND type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 5 MINUTE
ORDER BY event_time DESC
LIMIT 4
```

Expected: First request — `query_cache_hits = 0`, `read_rows ≈ 1.46B`, `query_duration_ms ≈ 60000`. Second request — `query_cache_hits = 1`, `read_rows = 0`, `query_duration_ms < 100`.

- [ ] **Step 5: Verify query_cache for /api/reuse**

Load the reuse page (page 1, no filters) twice. Then:

```sql
SELECT
  query,
  read_rows,
  query_cache_hits,
  query_duration_ms
FROM system.query_log
WHERE query LIKE '%ulp.reuse_pairs%'
  AND type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 5 MINUTE
ORDER BY event_time DESC
LIMIT 8
```

Expected: First load — both Q1 and count queries have `query_cache_hits = 0`. Second load — both have `query_cache_hits = 1`, `read_rows = 0`, near-instant.
