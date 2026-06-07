# Inverted Text Index (DDL v6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `tokenbf_v1` bloom filter skip indexes on `url`/`email`/`password` with
ClickHouse 26.x `text()` inverted indexes, eliminating false positives and delivering
7-10× faster `hasToken()` granule pruning.

**Architecture:** One file changes: `lib/clickhouse-migrations.ts`. `DDL_VERSION` bumps 4→6.
DDL v5 (attempted `full_text(0)`) silently failed on ClickHouse 26.x — the `full_text`
type was renamed to `text(tokenizer = ...)` in 26.2. DDL v6 is the actual working
implementation: DROP partial v5 artifacts, ADD `text(tokenizer = splitByNonAlpha,
preprocessor = lower(col))` indexes, MATERIALIZE, then DROP old `tokenbf_v1` and
`idx_email_ngram`. No query changes anywhere — `hasToken()` uses the new index automatically.

**Tech Stack:** TypeScript, ClickHouse 26.3 (`text()` index GA in 26.2), `@clickhouse/client`

---

## File Structure

| Action | File | Change |
|---|---|---|
| Modify | `lib/clickhouse-migrations.ts` | Bump `DDL_VERSION` 4→6; insert v5 + v6 blocks after `if (lastDdl < 4)` |

---

### Task 1: Implement DDL v5 + v6 migration

**Files:**
- Modify: `lib/clickhouse-migrations.ts`

> **Note on testing:** No automated tests exist for DDL migrations in this codebase (same as v1–v4). The migration runs at startup against a live ClickHouse instance; correctness is verified post-deployment via `system.data_skipping_indices` and `system.mutations` (see Task 2). The Vitest suite still runs here to guard against accidental TypeScript regressions.

- [ ] **Step 1: Locate the two edit points in `lib/clickhouse-migrations.ts`**

Open `lib/clickhouse-migrations.ts`. Find:

1. The `DDL_VERSION` constant and its version-history comment block (~line 16–22):
   ```typescript
   // v1: columns + materialized columns + table settings
   // v2: additional skip indexes (breach_name + source_file bloom filters)
   // v3: MV backing tables (SummingMergeTree + AggregatingMergeTree) + 4 materialized views
   // v4: ngrambf_v1(4,1024,1,0) skip indexes on url_host + email_domain (substring search)
   const DDL_VERSION = 4
   ```

2. The end of the `if (lastDdl < 4)` block (~line 279–291) and the start of `if (lastDdl < DDL_VERSION)` right after it (~line 293):
   ```typescript
     console.log('[ClickHouse migration] DDL v4 applied (ngrambf_v1 on url_host + email_domain — MATERIALIZE running in background)')
   }

   if (lastDdl < DDL_VERSION) {
   ```

The v5 block goes between these two.

- [ ] **Step 2: Bump `DDL_VERSION` and extend the version-history comment**

Replace:
```typescript
// v4: ngrambf_v1(4,1024,1,0) skip indexes on url_host + email_domain (substring search)
const DDL_VERSION = 4
```

With:
```typescript
// v4: ngrambf_v1(4,1024,1,0) skip indexes on url_host + email_domain (substring search)
// v5: full_text(0) inverted indexes — FAILED on ClickHouse 26.x (wrong type name)
// v6: text(tokenizer=splitByNonAlpha) indexes replacing v5 failed attempt
const DDL_VERSION = 6
```

- [ ] **Step 3: Insert the v5 + v6 migration blocks**

After the `if (lastDdl < 4)` closing brace and before `if (lastDdl < DDL_VERSION)`:

```typescript
  // v5 — FAILED on ClickHouse 26.x (full_text type was renamed to text() in 26.2).
  // Kept as historical record. The DROPs in v5 still run and remove tokenbf_v1 indexes.
  if (lastDdl < 5) {
    // full_text(0) ADD INDEX fails silently on 26.x; DROP INDEX succeeds
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_password`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email_ngram`)
    console.log('[ClickHouse migration] DDL v5 applied (tokenbf_v1 indexes dropped)')
  }

  // v6 — Correct text() index syntax for ClickHouse 26.x.
  // preprocessor = lower(col) matches hasToken(col, lower(value)) in lib/ulp-search.ts.
  if (lastDdl < 6) {
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_password`)
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
    console.log('[ClickHouse migration] DDL v6 applied (text indexes — MATERIALIZE running in background)')
  }
```

- [ ] **Step 4: Run the test suite to verify no TypeScript regressions**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "fix: DDL v6 — correct text() index syntax for ClickHouse 26.x"
```

---

### Task 2: Post-deployment verification (manual)

> Run these queries after the app restarts with DDL v6 deployed. ClickHouse processes the `if (lastDdl < 6)` block on first startup; the MATERIALIZE mutations run in background (30–120 min).

- [ ] **Step 1: Confirm new indexes exist and old indexes are gone**

```sql
SELECT name, type, expr
FROM system.data_skipping_indices
WHERE table = 'credentials' AND database = 'ulp'
ORDER BY name
```

Expected — these rows MUST be present:

| name | type |
|---|---|
| `idx_bf_breach_name` | `bloom_filter` |
| `idx_bf_email_domain` | `bloom_filter` |
| `idx_bf_source_file` | `bloom_filter` |
| `idx_bf_url_host` | `bloom_filter` |
| `idx_inv_email` | `text` |
| `idx_inv_password` | `text` |
| `idx_inv_url` | `text` |
| `idx_ngram_email_domain` | `ngrambf_v1` |
| `idx_ngram_url_host` | `ngrambf_v1` |
| `idx_set_password_entropy` | `set` |

These rows must be ABSENT (dropped by v5):
- `idx_url`, `idx_email`, `idx_password` (old `tokenbf_v1`)
- `idx_email_ngram` (unused `ngrambf_v1`)

- [ ] **Step 2: Monitor the three MATERIALIZE mutations**

```sql
SELECT command, create_time, is_done, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE table = 'credentials'
  AND command LIKE '%idx_inv%'
ORDER BY create_time DESC
LIMIT 6
```

Expected: 3 rows (one per index — `idx_inv_url`, `idx_inv_email`, `idx_inv_password`).
`is_done = 1` when complete. `latest_fail_reason` should be empty string for all.

- [ ] **Step 3: Confirm granule pruning is active (run after `is_done = 1`)**

Perform a token search in the UI (e.g., search for "gmail"), then:

```sql
SELECT query, read_rows, total_rows_approx, query_duration_ms
FROM system.query_log
WHERE query LIKE '%hasToken(url%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 5
```

Expected: `read_rows` should be orders of magnitude below `total_rows_approx` for selective tokens. A query returning ~1000 results from 1.46B rows should read far fewer than 1.46B rows.
