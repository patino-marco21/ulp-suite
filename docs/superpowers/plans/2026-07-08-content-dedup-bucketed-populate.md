# Content-Dedup Bucketed Populate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chunk `lib/content-dedup.ts`'s rewrite+swap populate step by content-key hash bucket, so background-merge memory pressure gets a real gap to settle between buckets instead of accumulating across one continuously-growing INSERT — the confirmed root cause of six failed live rollout attempts against real `ulp.credentials` data.

**Architecture:** Replace the single unchunked `buildPopulateDedupedTableSql()` with `buildPopulateDedupedTableSqlForBucket(bucketIndex, bucketCount)`, adding a `cityHash64(CONTENT_KEY) % bucketCount = bucketIndex` filter that reuses the exact correctness guarantee from the original bucketed-DELETE design (a content-duplicate group always hashes to the same bucket). `runContentDedupTick()`'s populate step becomes a sequential loop over `contentDedupBucketCount()` buckets (default 32).

**Tech Stack:** TypeScript (Next.js `lib` module), Vitest, ClickHouse (`INSERT ... SELECT ... WHERE ... ORDER BY ... LIMIT 1 BY`).

## Global Constraints

- Bucket count default is 32, via a new `contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number` function reading `CONTENT_DEDUP_BUCKET_COUNT`, matching this file's existing `dedupCronHours`/`minExcessToApply`/`dedupCronHourUtc` convention exactly (optional `env` param, `parseInt`, validated fallback `n >= 1`).
- `buildPopulateDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string` replaces `buildPopulateDedupedTableSql()` entirely — same `INSERT INTO AUTO_DEDUP_TABLE SELECT * FROM ulp.credentials ... ORDER BY CONTENT_DEDUP_SURVIVOR_ORDER LIMIT 1 BY CONTENT_KEY` shape, with an added `WHERE cityHash64(CONTENT_KEY) % bucketCount = bucketIndex` filter.
- `CONTENT_DEDUP_MAX_BLOCK_SIZE` is removed entirely (no `max_block_size` override in the bucketed query) — it provided no benefit at full-table scale and risks a "too many parts" problem at bucket scale; the exact right value (if any) is for a future finding, not this plan.
- `max_bytes_before_external_sort`, `max_threads`, `max_insert_threads`, `max_execution_time = 1800`, `timeout_overflow_mode = 'throw'` are retained unchanged in the bucketed populate query (all confirmed live to help; none of the reasoning behind them changes with bucketing).
- `buildCatchupInsertSql()` is NOT bucketed — unchanged from its current form.
- Buckets run sequentially in `runContentDedupTick()`, not in parallel.
- Scope is limited to `lib/content-dedup.ts`, `__tests__/content-dedup.test.ts`, and `.env.example`. `lib/dedup-cron.ts` and all `app/api` routes are unchanged.
- `CONTENT_DEDUP_APPLY` stays `false` in the real `.env` throughout this plan except during Task 3's single supervised invocation, which overrides it only within that invocation's own process.

---

### Task 1: Bucket the populate step

**Files:**
- Modify: `lib/content-dedup.ts`
- Modify: `__tests__/content-dedup.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces (used by Tasks 2-3): `contentDedupBucketCount(env): number`, `buildPopulateDedupedTableSqlForBucket(bucketIndex, bucketCount): string`, `runContentDedupTick(opts): Promise<DedupTickResult>` (unchanged signature/return shape; populate step internally becomes a bucket loop).
- Removed: `buildPopulateDedupedTableSql()`, `CONTENT_DEDUP_MAX_BLOCK_SIZE` — confirmed via repo-wide grep that nothing outside this file and its test file references either.

- [ ] **Step 1: Update the test file (will fail to import — expected RED)**

In `__tests__/content-dedup.test.ts`, replace this import block:

```ts
import {
  CONTENT_KEY,
  buildStatsSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffSql,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  CONTENT_DEDUP_MAX_BLOCK_SIZE,
  buildPopulateDedupedTableSql,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
```

with:

```ts
import {
  CONTENT_KEY,
  buildStatsSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffSql,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
```

Replace this block:

```ts
  describe('CONTENT_DEDUP_MAX_BLOCK_SIZE', () => {
    test('is 16,384', () => {
      expect(CONTENT_DEDUP_MAX_BLOCK_SIZE).toBe(16_384)
    })
  })

  describe('buildPopulateDedupedTableSql', () => {
    test('inserts a deduped copy keeping the earliest imported_at per content key, with disk-spill, bounded threads, a capped block size, and a raised timeout', () => {
      const sql = buildPopulateDedupedTableSql()
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain('SELECT * FROM ulp.credentials')
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
      expect(sql).toContain(`max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_block_size = ${CONTENT_DEDUP_MAX_BLOCK_SIZE}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
    })
  })
```

with:

```ts
  describe('contentDedupBucketCount', () => {
    test('defaults to 32', () => {
      expect(contentDedupBucketCount({})).toBe(32)
    })
    test('honors a positive override', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '16' })).toBe(16)
    })
    test('invalid or non-positive falls back to 32', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '0' })).toBe(32)
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: 'nope' })).toBe(32)
    })
  })

  describe('buildPopulateDedupedTableSqlForBucket', () => {
    test('inserts a deduped copy of one bucket, keeping the earliest imported_at per content key, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(5, 32)
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain('SELECT * FROM ulp.credentials')
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 5`)
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
      expect(sql).toContain(`max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
      expect(sql).not.toContain('max_block_size')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(0, 32)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 0`)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- content-dedup`
Expected: FAIL — `content-dedup.ts` has no exported member `contentDedupBucketCount` (or similar import error).

- [ ] **Step 3: Update `lib/content-dedup.ts`**

Replace the file's top-of-file doc comment's `MECHANISM` paragraph (currently ending "... Full design: docs/superpowers/specs/2026-07-07-content-dedup-rewrite-swap-design.md") by adding a new paragraph immediately after the existing `PRIOR DESIGNS` paragraph (before `CATCH-UP`):

```ts
 * POPULATE SCALE: six live attempts against the real table each hit
 * MEMORY_LIMIT_EXCEEDED at roughly the same point regardless of per-block
 * settings tuned (disk-spill sort, thread limiting, and a capped block size
 * each confirmed live -- the first two roughly doubled progress before
 * failure, the third had no measurable effect). Root cause: a single
 * continuously-growing INSERT accumulates background-merge memory pressure
 * over its whole duration, which per-block settings don't address. The
 * populate step is chunked by content-key hash bucket for the same reason
 * the old bucketed-DELETE design chunked its DELETE -- a content-duplicate
 * group always hashes to the same bucket, so chunking cannot affect
 * correctness -- but for a different purpose: giving background merges a
 * real gap to settle between sequential buckets, rather than bounding
 * per-mutation part-rewrite cost. Full design:
 * docs/superpowers/specs/2026-07-08-content-dedup-bucketed-populate-design.md
```

Replace this block:

```ts
/**
 * Caps the row count of each block ClickHouse forms while executing the
 * populate/catch-up SELECT (default 65,536). For `INSERT ... SELECT`
 * specifically, the insert reuses the exact blocks the SELECT produces --
 * `max_insert_block_size` has no effect here (it only governs standalone
 * INSERT VALUES-style statements), so this is the lever that actually bounds
 * how many rows' worth of this table's ~9 MATERIALIZED columns get computed
 * together in one block. Confirmed live 2026-07-08: even with disk-spill
 * sort and max_threads=2, the populate query still hit a THIRD
 * MEMORY_LIMIT_EXCEEDED (a large single allocation) after writing 64M of the
 * expected ~356M rows -- each fix so far has roughly doubled progress before
 * failure (10.6M -> 32M -> 64M), consistent with a genuine per-block memory
 * ceiling rather than a fluke.
 */
export const CONTENT_DEDUP_MAX_BLOCK_SIZE = 16_384

/**
 * Builds AUTO_DEDUP_TABLE: one row per content key, keeping the earliest
 * imported_at. `max_execution_time = 1800, timeout_overflow_mode = 'throw'`
 * mirrors scripts/dedup-credentials-content.sh's own equivalent INSERT step
 * exactly -- the client's default max_execution_time (60s, lib/clickhouse.ts)
 * is far too short for a full-table sort at this scale.
 */
export function buildPopulateDedupedTableSql(): string {
  return `INSERT INTO ${AUTO_DEDUP_TABLE}
  SELECT * FROM ulp.credentials
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_block_size = ${CONTENT_DEDUP_MAX_BLOCK_SIZE}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}
```

with:

```ts
/**
 * Number of hash buckets the populate step is chunked into. Default 32:
 * comfortable safety margin under the ~64M-row point where an unchunked
 * populate reliably hit MEMORY_LIMIT_EXCEEDED (~11M rows/bucket at this
 * table's real scale, ~5.8x margin), while keeping the number of full
 * source-table re-scans modest -- every bucket's hash filter is unprunable,
 * so each bucket costs one full table scan regardless of bucket count.
 */
export function contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.CONTENT_DEDUP_BUCKET_COUNT ?? '32', 10)
  return Number.isFinite(n) && n >= 1 ? n : 32
}

/**
 * Builds AUTO_DEDUP_TABLE's share for one bucket: one row per content key
 * whose hash falls in this bucket, keeping the earliest imported_at. A
 * content-duplicate group's rows always share the same CONTENT_KEY, so they
 * always hash to the same bucket and can never split across two --
 * chunking cannot affect correctness. `max_execution_time = 1800,
 * timeout_overflow_mode = 'throw'` mirrors scripts/dedup-credentials-content.sh's
 * own equivalent INSERT step exactly -- the client's default
 * max_execution_time (60s, lib/clickhouse.ts) is far too short at this
 * scale. No max_block_size override (see POPULATE SCALE above): bucketing
 * itself now bounds the operation's scale, and a small block size risks a
 * "too many parts" problem at bucket scale that it didn't at full-table
 * scale.
 */
export function buildPopulateDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `INSERT INTO ${AUTO_DEDUP_TABLE}
  SELECT * FROM ulp.credentials
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}
```

Replace this block (the populate step inside `runContentDedupTick`):

```ts
    // 5. Populate.
    console.log(`[content-dedup] ${trigger}: building deduped table (~${excess} duplicate rows to remove)`)
    await client.exec({ query: buildPopulateDedupedTableSql() })
```

with:

```ts
    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
    // comment for why this runs as a sequential loop instead of one INSERT.
    const bucketCount = contentDedupBucketCount()
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- content-dedup`
Expected: PASS — all tests in `__tests__/content-dedup.test.ts` green.

- [ ] **Step 5: Update `.env.example`**

Find this block in `.env.example`:

```
# only REPORTS the exact duplicate count until you flip CONTENT_DEDUP_APPLY on.
# Run scripts/dedup-credentials-content.sh in dry-run for a detailed sample, then:
#   CONTENT_DEDUP_APPLY=true   → allow the background DELETE FROM to run
CONTENT_DEDUP_APPLY=false
```

Replace with (fixing the stale "DELETE FROM" reference — the mechanism is insert-select-rename, not a DELETE, as of this session's earlier rewrite+swap redesign):

```
# only REPORTS the exact duplicate count until you flip CONTENT_DEDUP_APPLY on.
# Run scripts/dedup-credentials-content.sh in dry-run for a detailed sample, then:
#   CONTENT_DEDUP_APPLY=true   → allow the background rewrite (insert-select-rename) to run
CONTENT_DEDUP_APPLY=false
```

Find this block:

```
# Don't fire a (heavy) dedup mutation unless at least this many excess rows exist.
DEDUP_MIN_EXCESS=1000
```

Replace with (adding the new bucket-count knob immediately after):

```
# Don't fire a (heavy) dedup rebuild unless at least this many excess rows exist.
DEDUP_MIN_EXCESS=1000
# Number of hash buckets the populate step is chunked into -- gives
# background merges a real gap to settle between buckets instead of
# accumulating pressure across one long-running INSERT. Default 32.
CONTENT_DEDUP_BUCKET_COUNT=32
```

- [ ] **Step 6: Run the full test suite and typecheck to confirm nothing else broke**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts .env.example
git commit -m "$(cat <<'EOF'
fix(content-dedup): chunk the populate insert by content-key hash bucket

Six live attempts against the real table each hit MEMORY_LIMIT_EXCEEDED
at roughly the same point regardless of per-block settings tuned
(disk-spill sort and thread limiting each roughly doubled progress;
a capped block size had no measurable effect). Root cause: a single
continuously-growing INSERT accumulates background-merge memory
pressure over its whole duration -- per-block settings don't address
that. Chunks the populate step by content-key hash bucket (default
32, reusing the exact correctness guarantee from the earlier
bucketed-DELETE design), giving background merges a real gap to
settle between sequential buckets. max_block_size is dropped --
bucketing itself now bounds scale, and a small block size risks a
"too many parts" problem at bucket scale that it didn't at full-table
scale.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Disposable-clone verification at meaningfully larger scale

**Files:** None (no repository changes — live verification against a temporary, disposable ClickHouse table). No commit at the end of this task.

**Interfaces:**
- Consumes: the exact SQL shape from Task 1's `buildPopulateDedupedTableSqlForBucket` (hand-mirrored below in bash against a clone table, since `runContentDedupTick` hardcodes `ulp.credentials`/`AUTO_DEDUP_TABLE`/`AUTO_PREDUP_TABLE` and cannot be pointed at a different table name).

The original rewrite+swap disposable-clone test used a 3M-row clone — too small to have caught any of the six real scale issues found in Tasks 1-3 of the previous plan. This task uses a **100M-row** clone, large enough to meaningfully exercise bucket-to-bucket part accumulation and merge behavior across all 32 sequential buckets, not just prove one bucket's SQL shape is correct.

> This task runs all 32 buckets sequentially against a 100M-row clone. Each bucket scans the full 100M-row source (hash filters can't be part-pruned), so expect this to take real wall-clock time — plan for it, don't rush it, and don't skip buckets partway through.

- [ ] **Step 1: Create a projection-including disposable clone**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw \
  | sed -e 's/ulp\.credentials/ulp.credentials_buckettest/g' \
        -e "s|/clickhouse/tables/{shard}/ulp/credentials'|/clickhouse/tables/{shard}/ulp/credentials_buckettest'|" \
  | docker exec -i ulpsuite_clickhouse clickhouse-client --multiquery
```

Expected: no output, no error.

- [ ] **Step 2: Verify the clone has the projection**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials_buckettest" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

- [ ] **Step 3: Populate with 100M rows plus deliberate duplicates**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_buckettest
SELECT * FROM ulp.credentials LIMIT 100000000
SETTINGS max_execution_time = 1800
"
```

Expected: completes without a client timeout (allow several minutes).

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_buckettest (url, email, password, domain, source_file, breach_name, imported_at)
VALUES
  ('https://buckettest-verify.test/', 'buckettest-verify@test.local', 'samepassword123', 'buckettest-verify.test', '__bucket_test_dupe__', 'test_breach', '2026-01-01 00:00:00'),
  ('https://buckettest-verify.test/', 'buckettest-verify@test.local', 'samepassword123', 'buckettest-verify.test', '__bucket_test_dupe__', 'test_breach', '2026-01-02 00:00:00'),
  ('https://buckettest-verify.test/', 'buckettest-verify@test.local', 'samepassword123', 'buckettest-verify.test', '__bucket_test_dupe__', 'test_breach', '2026-01-03 00:00:00')
"
```

Expected: no error. These three rows share a content key and differ only in `imported_at` — the earliest (`2026-01-01`) must survive, and because they share a content key, all three must land in the same bucket regardless of which bucket that is (the key correctness property this task needs to prove holds at real scale).

Confirm the population landed:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials_buckettest"
```

Expected: `100000003`.

- [ ] **Step 4: Capture the baseline duplicate-key hash for the deliberate duplicates**

Before running any buckets, confirm which bucket (of 32) the three deliberate duplicates fall into — this proves they land together, not split across buckets:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT DISTINCT cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) % 32 AS bucket
FROM ulp.credentials_buckettest
WHERE source_file = '__bucket_test_dupe__'
"
```

Expected: exactly one row (a single bucket number) — if this returns more than one row, the three duplicate rows landed in different buckets, which would mean the bucketing predicate is wrong and must be fixed before proceeding to Step 5.

- [ ] **Step 5: Create the build-target clone**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw \
  | sed -e 's/ulp\.credentials/ulp.credentials_buckettest_cdedup/g' \
        -e "s|/clickhouse/tables/{shard}/ulp/credentials'|/clickhouse/tables/{shard}/ulp/credentials_buckettest_cdedup'|" \
  | docker exec -i ulpsuite_clickhouse clickhouse-client --multiquery
```

- [ ] **Step 6: Run all 32 buckets sequentially**

```bash
for BUCKET in $(seq 0 31); do
  echo "-- Bucket $BUCKET / 31 --"
  START=$(date +%s)
  if ! docker exec ulpsuite_clickhouse clickhouse-client --query "
    INSERT INTO ulp.credentials_buckettest_cdedup
    SELECT * FROM ulp.credentials_buckettest
    WHERE cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) % 32 = $BUCKET
    ORDER BY url, email, password, imported_at
    LIMIT 1 BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password
    SETTINGS max_bytes_before_external_sort = 4294967296, max_threads = 2, max_insert_threads = 2, max_execution_time = 1800, timeout_overflow_mode = 'throw'
  "; then
    echo "Bucket $BUCKET FAILED -- stopping here rather than continuing to later buckets. Investigate and report before retrying." >&2
    break
  fi
  END=$(date +%s)
  echo "Bucket $BUCKET done in $((END - START))s."
  PARTS=$(docker exec ulpsuite_clickhouse clickhouse-client --query "
    SELECT count() FROM system.parts WHERE database='ulp' AND table='credentials_buckettest_cdedup' AND active
  ")
  echo "Active parts in target table after bucket $BUCKET: $PARTS"
done
```

Expected: all 32 buckets complete without `MEMORY_LIMIT_EXCEEDED` or any other error. Watch the printed active-part counts against ClickHouse's documented "too many parts" throttling threshold of ~300 active parts per partition (this table lives in a single partition) — counts should stay comfortably under that at any point. If they approach or exceed ~300 and keep climbing across buckets rather than coming back down, that's a sign background merges aren't keeping up between buckets — stop and report this rather than pushing through the remaining buckets.

- [ ] **Step 7: Verify the bucketed result matches an unchunked reference computation**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT
  count() AS bucketed_rows,
  count() - uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS excess_after
FROM ulp.credentials_buckettest_cdedup
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS expected_rows
FROM ulp.credentials_buckettest
SETTINGS max_execution_time = 300
"
```

Expected: `excess_after` is `0` (no internal duplicates — bucketing didn't let any survive). `bucketed_rows` equals `expected_rows` exactly (no rows lost or gained across the 32-bucket run — since no catch-up scenario is being tested in this task, an exact match is expected here, not just `>=`).

- [ ] **Step 8: Verify the deliberate duplicates collapsed correctly**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count(), min(imported_at) FROM ulp.credentials_buckettest_cdedup WHERE source_file = '__bucket_test_dupe__'
"
```

Expected: count `1`, `imported_at` = `2026-01-01 00:00:00` (the earliest of the three).

- [ ] **Step 9: Verify the projection survived**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials_buckettest_cdedup" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

- [ ] **Step 10: Clean up all test tables**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.credentials_buckettest SYNC"
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.credentials_buckettest_cdedup SYNC"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
```

Expected: the last query returns the real table's unchanged row count, confirming this entire task never touched real data (only tables with the `_buckettest` prefix). Use `SYNC` on both drops (per this branch's established SYNC convention) to avoid leaving orphaned ZooKeeper replica metadata behind.

- [ ] **Step 11: Report results**

No commit for this task. Report: the per-bucket timing and active-part counts from Step 6, the exact numbers from Steps 7-9, and confirmation that Step 10's cleanup completed and the real table is unaffected.

---

### Task 3: Live rollout retry against real data

**Files:**
- Create (uncommitted, scratchpad only — do not `git add` this file): a one-off verification script, matching the one used for the previous rewrite+swap live verification.

**Interfaces:**
- Consumes: `runContentDedupTick` from Task 1's `lib/content-dedup.ts`, invoked directly against real `ulp.credentials`.

> **This is the seventh live attempt against the real, live `ulp.credentials` table tonight — the first with bucketing in place.** Treat it with the same care as every attempt before it: confirm pre-state, watch progress, confirm post-state independently. The mechanism for running this is unchanged from the previous plan's Task 3 — repeated here for a self-contained brief.

- [ ] **Step 1: Confirm pre-state**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_cdedup_auto"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_predup_auto"
```

Expected: the real row count, and both `EXISTS` checks return `0` (if either returns `1`, a prior attempt left a table behind — investigate before proceeding rather than assuming it's safe to ignore).

- [ ] **Step 2: Write and run the one-off verification script**

Create a file under this session's scratchpad directory with this exact content:

```ts
// One-off verification script for the bucketed-populate redesign of
// content-dedup. NOT committed to the repository. All configuration
// (CONTENT_DEDUP_APPLY, DEDUP_MIN_EXCESS, and the ClickHouse connection)
// comes from the shell invocation's environment -- see the command below.
import { runContentDedupTick } from '@/lib/content-dedup'

async function main() {
  const result = await runContentDedupTick({ trigger: 'manual-verification' })
  console.log('runContentDedupTick result:', JSON.stringify(result))
}

main()
```

Run it from this repository checkout's root (so `npx` finds the locally-installed `tsx`, which is what makes the `@/` import resolve correctly — a non-locally-installed `tsx` fetched on the fly does not reliably resolve this project's path aliases), with the ClickHouse IP resolved fresh (container IPs can change across restarts) and the real credentials pulled from the primary worktree's `.env` (`.env` is gitignored and does not exist in a fresh session worktree):

```bash
CH_IP=$(docker inspect ulpsuite_clickhouse --format '{{range $k,$v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}')
CH_USER=$(grep '^CLICKHOUSE_USER=' /home/cole/ulp-suite/.env | cut -d= -f2-)
CH_PASSWORD=$(grep '^CLICKHOUSE_PASSWORD=' /home/cole/ulp-suite/.env | cut -d= -f2-)
CH_DATABASE=$(grep -E '^CLICKHOUSE_DATABASE=|^CLICKHOUSE_DB=' /home/cole/ulp-suite/.env | head -1 | cut -d= -f2-)
echo "resolved: CH_IP=$CH_IP CH_USER=$CH_USER CH_DATABASE=$CH_DATABASE"

CLICKHOUSE_HOST="http://$CH_IP:8123" \
CLICKHOUSE_USER="$CH_USER" \
CLICKHOUSE_PASSWORD="$CH_PASSWORD" \
CLICKHOUSE_DATABASE="$CH_DATABASE" \
CONTENT_DEDUP_APPLY=true \
DEDUP_MIN_EXCESS=0 \
npx tsx /path/to/this/scratchpad/file.ts
```

Expected: the script's own `[content-dedup]` log lines print the bucket count and progress, and the final `runContentDedupTick result:` line shows `applied: true`. Given this runs 32 sequential buckets against the real ~467M-row table, expect this to take substantially longer than any single prior attempt — do not interrupt it prematurely on the assumption it has hung; if genuinely no output changes for an extended period, check `system.merges`/`system.parts` directly (as established earlier this session) before concluding it's stuck.

- [ ] **Step 3: Confirm post-state independently**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT
  count() AS total,
  uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS distinct_creds,
  total - distinct_creds AS excess
FROM ulp.credentials
FORMAT Vertical
"
```

Expected: `excess` is `0`.

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_predup_auto"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials_predup_auto"
```

Expected: `1` (exists), and its row count matches Step 1's pre-run total exactly.

- [ ] **Step 4: Confirm `CONTENT_DEDUP_APPLY` is still `false` in the real `.env`**

```bash
grep "^CONTENT_DEDUP_APPLY" /home/cole/ulp-suite/.env || echo "not set (defaults to false)"
```

Expected: not set, or `false`.

- [ ] **Step 5: Report and stop**

Report: the pre-state and post-state numbers from Steps 1 and 3, confirmation the projection survived, confirmation `AUTO_PREDUP_TABLE` is intact with the correct row count, and confirmation `CONTENT_DEDUP_APPLY` remains unset in `.env`. There is no committed file to clean up (the verification script was never added to the repository). Do not drop `ulp.credentials_predup_auto` — leave it as the rollback safety net. Do not enable `CONTENT_DEDUP_APPLY=true` for ongoing scheduled use regardless of this attempt's outcome — that remains a separate, later decision.
