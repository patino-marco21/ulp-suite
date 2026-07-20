# Content-Dedup Cutoff/Stats Bucketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `lib/content-dedup.ts`'s `buildStatsSql()`, `buildCutoffSql()`, and `buildVerifyDedupedTableSql()` — all confirmed to run the same ungrouped `uniqExact(cityHash64(CONTENT_KEY))` shape that hit `MEMORY_LIMIT_EXCEEDED` live (2026-07-19) at real scale (562M rows / ~470M distinct content keys) — by bucketing the computation the same way the populate step already buckets its `INSERT`, since neither `max_threads` bounding nor `max_bytes_before_external_group_by` spilling has any effect on this query shape (both confirmed live to make no difference). `buildVerifyDedupedTableSql()` was found in a second pass (Task 2) after Task 1 fixed the first two -- same bug class, same file, missed in the first pass's scope.

**Architecture:** Replace `buildStatsSql()`/`buildCutoffSql()`/`buildVerifyDedupedTableSql()` with pure SQL builders per bucket (`buildCutoffTimestampSql`, `buildContentKeyStatsSqlForBucket`, `buildVerifyDedupedTableSqlForBucket`) plus a generalized `sumBucketedTotalAndDistinct()` loop -- parameterized by which per-bucket builder to call -- shared by the stats step, the cutoff step, and the verify step in `runContentDedupTick()`. Bucketed sums are exact (not approximate) because a content-duplicate group always hashes to one bucket. Task 1's own implementation was additionally amended after review to fold `count()` into the same per-bucket query as `uniqExact()` (see Task 1's note at the end); Task 2 adopts that same combined shape from the start.

**Tech Stack:** TypeScript (Next.js `lib` module), Vitest, ClickHouse (`SELECT ... WHERE cityHash64(...) % N = i`).

**Full design:** `docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md`

## Global Constraints

- Bucket count reuses the existing `contentDedupBucketCount()` (`CONTENT_DEDUP_BUCKET_COUNT`, default 32) — no new env var.
- Do **not** add `max_threads` or `max_bytes_before_external_group_by` to the new bucketed query — both confirmed live tonight to have zero effect on this query shape (see design doc's Investigation table). `max_execution_time = 300` is kept, unchanged from today's value.
- `cutoff` must still be captured via its own query *before* any bucket scan starts — this is what keeps the CATCH-UP mechanism's correctness unchanged even though `expectedRows` is no longer captured atomically with it (see design doc's Architecture section for the full safety-direction argument).
- `buildStatsSql()` and `buildCutoffSql()` are removed entirely — no backwards-compat re-exports.
- Scope is limited to `lib/content-dedup.ts` and `__tests__/content-dedup.test.ts`. `lib/dedup-cron.ts`, `.env.example`, and all `app/api` routes are unchanged.
- `CONTENT_DEDUP_APPLY` stays `false` in the real `.env` throughout this plan except Task 5's single supervised invocation, which overrides it only within that invocation's own process.
- `DedupTickResult`'s shape (`{ total, excess, applied }`) is unchanged.

## File Structure

- **Modify `lib/content-dedup.ts`**: Task 1 removes `buildStatsSql()`/`buildCutoffSql()`, adds `buildCutoffTimestampSql()` and `buildContentKeyStatsSqlForBucket()` (the latter returning both `count()` and `uniqExact()` from one per-bucket query), and an internal bucketed-sum helper; Task 2 removes `buildVerifyDedupedTableSql()`, adds `buildVerifyDedupedTableSqlForBucket()`, and generalizes the helper into `sumBucketedTotalAndDistinct()` (parameterized by which per-bucket builder to call) shared across all three call sites. Both tasks update the file's header doc comment and stale cross-reference comments.
- **Modify `__tests__/content-dedup.test.ts`**: swap the removed functions' test blocks for their bucketed replacements, in each of Tasks 1 and 2.
- **Create (scratchpad only, never committed)**: two one-off verification scripts, Tasks 4 and 5.

---

### Task 1: Bucket the stats/cutoff distinct-count query

**Files:**
- Modify: `lib/content-dedup.ts`
- Modify: `__tests__/content-dedup.test.ts`

**Interfaces:**
- Produces (used by Task 2 and Tasks 4-5): `buildCutoffTimestampSql(): string`, `buildContentKeyStatsSqlForBucket(bucketIndex: number, bucketCount: number): string` (returns both `bucket_total` and `bucket_distinct` from one query -- see this task's note at the end for why, added after review).
- Removed: `buildStatsSql()`, `buildCutoffSql()` — confirmed via repo-wide grep that nothing outside `lib/content-dedup.ts` and its test file references either.

- [ ] **Step 1: Update the test file (will fail to import — expected RED)**

In `__tests__/content-dedup.test.ts`, replace the import block:

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
  buildEnsureSearchIndexesSql,
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
  buildTotalRowCountSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffTimestampSql,
  buildDistinctContentKeyCountSqlForBucket,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildEnsureSearchIndexesSql,
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
  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without a duplicate subquery', () => {
      expect(sql).toContain(`uniqExact(cityHash64(${URL_CONTENT_KEY}, email, password))`)
      expect(sql).toContain('AS excess')
      expect(sql).not.toContain('AS deletable')
      expect(sql).not.toContain('countIf(')
    })
  })
```

with:

```ts
  describe('buildTotalRowCountSql', () => {
    test('is a cheap unbucketed row count', () => {
      const sql = buildTotalRowCountSql()
      expect(sql).toBe('SELECT count() AS total FROM ulp.credentials SETTINGS max_execution_time = 300')
    })
  })
```

Replace this block:

```ts
  describe('buildCutoffSql', () => {
    test('captures the clock time and the distinct content-key count together, in one query', () => {
      const sql = buildCutoffSql()
      expect(sql).toContain('now() AS cutoff')
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS expected_rows`)
      expect(sql).toContain('FROM ulp.credentials')
    })
  })
```

with:

```ts
  describe('buildCutoffTimestampSql', () => {
    test('captures ClickHouse\'s own clock, nothing else', () => {
      const sql = buildCutoffTimestampSql()
      expect(sql).toBe('SELECT now() AS cutoff')
    })
  })

  describe('buildDistinctContentKeyCountSqlForBucket', () => {
    test('counts one bucket\'s distinct content keys, bounded by max_execution_time only', () => {
      const sql = buildDistinctContentKeyCountSqlForBucket(5, 32)
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct`)
      expect(sql).toContain('FROM ulp.credentials')
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 5`)
      expect(sql).toContain('max_execution_time = 300')
      expect(sql).not.toContain('max_threads')
      expect(sql).not.toContain('max_bytes_before_external_group_by')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildDistinctContentKeyCountSqlForBucket(0, 32)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 0`)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- content-dedup`
Expected: FAIL — `content-dedup.ts` has no exported member `buildTotalRowCountSql` (or similar import error).

- [ ] **Step 3: Update `lib/content-dedup.ts`**

Add a type-only import at the top of the file. Replace:

```ts
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'
```

with:

```ts
import type { ClickHouseClient } from '@clickhouse/client'
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'
```

Insert a new paragraph into the file's top-of-file doc comment, immediately after the `PRIOR DESIGNS` paragraph and before `POPULATE SCALE`. Find:

```ts
 * version (insert-select-rename) replaces (3) entirely rather than patching
 * it further — the part-touching problem is structural, not scale-specific,
 * and recurs for any future incremental use of a mutation-based approach.
 *
 * POPULATE SCALE: six live attempts against the real table each hit
```

Replace with:

```ts
 * version (insert-select-rename) replaces (3) entirely rather than patching
 * it further — the part-touching problem is structural, not scale-specific,
 * and recurs for any future incremental use of a mutation-based approach.
 *
 * CUTOFF/STATS SCALE: buildStatsSql() and buildCutoffSql() (both removed)
 * ran uniqExact(cityHash64(CONTENT_KEY)) as a single ungrouped aggregate
 * over the whole table -- confirmed live 2026-07-19 to hit
 * MEMORY_LIMIT_EXCEEDED at 562M rows / ~470M distinct content keys, right
 * at this server's 16 GiB ceiling. Unlike the populate step's own memory
 * fix below, neither max_threads bounding nor
 * max_bytes_before_external_group_by spilling has any effect here (both
 * confirmed live to make no difference, including reshaped into a real
 * multi-group GROUP BY) -- a zero-key uniqExact holds one hash set for the
 * query's whole duration with nothing for either lever to act on.
 * buildTotalRowCountSql()/buildCutoffTimestampSql()/
 * buildDistinctContentKeyCountSqlForBucket() replace them, bucketing the
 * distinct-count the same way the populate step below buckets its INSERT --
 * summing per-bucket uniqExact counts is exact, not approximate, via the
 * same content-duplicate-group-hashes-to-one-bucket guarantee. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
 *
 * POPULATE SCALE: six live attempts against the real table each hit
```

Replace `buildStatsSql()`:

```ts
export function buildStatsSql(): string {
  return `SELECT
    count() AS total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS distinct_creds,
    total - distinct_creds AS excess
  FROM ulp.credentials
  SETTINGS max_execution_time = 300`
}
```

with:

```ts
/**
 * Cheap -- no aggregation, just a row count. Unbucketed: count() carries no
 * cardinality-driven memory cost, unlike the distinct-key count below.
 */
export function buildTotalRowCountSql(): string {
  return `SELECT count() AS total FROM ulp.credentials SETTINGS max_execution_time = 300`
}
```

Replace `buildCutoffSql()` and its preceding doc comment:

```ts
/**
 * Captures the cutoff timestamp and the distinct content-key count together,
 * in one query, against ClickHouse's own clock, before the build starts.
 * Both values MUST come from here, not be re-queried later: ulp.credentials
 * keeps receiving live inserts throughout the build, so a fresh count taken
 * at verify time would compare against a moving target and spuriously fail
 * verification on a perfectly correct run.
 */
export function buildCutoffSql(): string {
  return `SELECT
    now() AS cutoff,
    uniqExact(cityHash64(${CONTENT_KEY})) AS expected_rows
  FROM ulp.credentials
  SETTINGS max_execution_time = 300`
}
```

with:

```ts
/**
 * Trivial single value, captured before any bucket scan starts. See
 * runContentDedupTick's step 1 comment for why this ordering still keeps
 * the CATCH-UP guarantee intact even though expectedRows (from
 * buildDistinctContentKeyCountSqlForBucket below) is no longer captured
 * atomically with this value, unlike the old single-query buildCutoffSql().
 */
export function buildCutoffTimestampSql(): string {
  return `SELECT now() AS cutoff`
}

/**
 * Bounds the distinct content-key count the same way
 * buildPopulateDedupedTableSqlForBucket bounds the populate INSERT --
 * `uniqExact(cityHash64(CONTENT_KEY))` with no GROUP BY forces ClickHouse to
 * hold one exact-cardinality hash set for the whole table's distinct content
 * keys in memory at once (~470M at 562M rows), which sits right at this
 * server's 16 GiB ceiling. Confirmed live 2026-07-19: neither max_threads
 * nor max_bytes_before_external_group_by bounding has ANY effect on this
 * query shape (both tested, identical failure either way -- the spill
 * mechanism only helps multi-group GROUP BY, and a zero-key uniqExact has no
 * groups for it to act on). Only reducing the actual per-query cardinality
 * via bucketing works, and does so exactly: a content-duplicate group always
 * hashes to the same bucket, so sum(uniqExact per disjoint bucket) equals
 * the true whole-table distinct count with zero approximation. Shared by
 * both the stats path and the cutoff path in runContentDedupTick --
 * identical query, two call sites. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
 */
export function buildDistinctContentKeyCountSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `SELECT uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct
  FROM ulp.credentials
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  SETTINGS max_execution_time = 300`
}
```

Update `buildVerifyDedupedTableSql()`'s doc comment (two stale `buildCutoffSql` references). Replace:

```ts
/**
 * AUTO_DEDUP_TABLE's own row count and internal excess -- does not query the
 * original table (that comparison uses buildCutoffSql()'s expectedRows,
 * captured before the build started, via runContentDedupTick's `>=` check --
 * see buildCutoffSql's comment for why a fresh query here would be wrong).
 */
export function buildVerifyDedupedTableSql(): string {
```

with:

```ts
/**
 * AUTO_DEDUP_TABLE's own row count and internal excess -- does not query the
 * original table (that comparison uses the cutoff step's expectedRows,
 * captured before the build started, via runContentDedupTick's `>=` check --
 * see buildDistinctContentKeyCountSqlForBucket's comment for why a fresh
 * query here would be wrong).
 */
export function buildVerifyDedupedTableSql(): string {
```

Add the `sumDistinctContentKeysBucketed` helper. Replace:

```ts
// ── tick (report, and optionally apply) ─────────────────────────────────────────

let tickInFlight = false

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
}

/**
 * Read duplicate stats, log them, and — only when CONTENT_DEDUP_APPLY is on and
 * excess clears the threshold — run the rewrite+swap cycle. Never throws.
 */
export async function runContentDedupTick(opts: { trigger?: string } = {}): Promise<DedupTickResult> {
```

with:

```ts
// ── tick (report, and optionally apply) ─────────────────────────────────────────

let tickInFlight = false

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
}

/**
 * Sums buckets' distinct-content-key counts sequentially -- shared by both
 * the stats step and the cutoff step below. Not exported/unit-tested
 * separately: this file only unit-tests pure SQL builders, matching the
 * existing convention that the populate step's own bucket loop (inside
 * runContentDedupTick) isn't unit-tested either, only its SQL-builder
 * function is. Exercised by Tasks 2-4 of this plan instead.
 */
async function sumDistinctContentKeysBucketed(client: ClickHouseClient, bucketCount: number): Promise<number> {
  let sum = 0
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const res = await client.query({ query: buildDistinctContentKeyCountSqlForBucket(bucket, bucketCount), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ bucket_distinct: string }>
    sum += Number(row?.bucket_distinct ?? 0)
  }
  return sum
}

/**
 * Read duplicate stats, log them, and — only when CONTENT_DEDUP_APPLY is on and
 * excess clears the threshold — run the rewrite+swap cycle. Never throws.
 */
export async function runContentDedupTick(opts: { trigger?: string } = {}): Promise<DedupTickResult> {
```

Update the stats step. Replace:

```ts
  try {
    const client = getClient()
    const statsRes = await client.query({ query: buildStatsSql(), format: 'JSONEachRow' })
    const [stats] = (await statsRes.json()) as Array<{ total: string; excess: string }>
    const total = Number(stats?.total ?? 0)
    const excess = Number(stats?.excess ?? 0)
    const applyOn = contentDedupApplyEnabled()
    const willApply = applyOn && excess >= minExcessToApply()
```

with:

```ts
  try {
    const client = getClient()
    const bucketCount = contentDedupBucketCount()
    const totalRes = await client.query({ query: buildTotalRowCountSql(), format: 'JSONEachRow' })
    const [totalRow] = (await totalRes.json()) as Array<{ total: string }>
    const total = Number(totalRow?.total ?? 0)
    const distinctCreds = await sumDistinctContentKeysBucketed(client, bucketCount)
    const excess = total - distinctCreds
    const applyOn = contentDedupApplyEnabled()
    const willApply = applyOn && excess >= minExcessToApply()
```

Update the cutoff step. Replace:

```ts
    // 1. Capture cutoff AND expectedRows together, against ClickHouse's own
    // clock, before anything else runs (see the file's CATCH-UP comment and
    // buildCutoffSql's comment for why both must come from here, not be
    // re-queried at verify time).
    const cutoffRes = await client.query({ query: buildCutoffSql(), format: 'JSONEachRow' })
    const [cutoffRow] = (await cutoffRes.json()) as Array<{ cutoff: string; expected_rows: string }>
    const cutoff = cutoffRow?.cutoff
    const expectedRows = Number(cutoffRow?.expected_rows ?? -1)
    if (!cutoff) throw new Error('[content-dedup] failed to capture cutoff timestamp')
```

with:

```ts
    // 1. Capture cutoff BEFORE any bucket scan starts, for CATCH-UP's own
    // correctness (unchanged -- see the file's CATCH-UP comment). expectedRows
    // is no longer captured atomically with cutoff (see
    // buildDistinctContentKeyCountSqlForBucket's comment and
    // docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md)
    // -- the bucketed sum below can pick up rows imported during its own scan
    // window on top of what existed at cutoff, but since ulp.credentials only
    // ever gains rows here (no concurrent deletes), that only ever makes
    // expectedRows equal-or-higher than the true cutoff-instant count, never
    // lower -- so the `cdedupRows >= expectedRows` check in step 6 below
    // stays exactly as conservative as it was when this was one atomic query.
    const cutoffRes = await client.query({ query: buildCutoffTimestampSql(), format: 'JSONEachRow' })
    const [cutoffRow] = (await cutoffRes.json()) as Array<{ cutoff: string }>
    const cutoff = cutoffRow?.cutoff
    if (!cutoff) throw new Error('[content-dedup] failed to capture cutoff timestamp')
    const expectedRows = await sumDistinctContentKeysBucketed(client, bucketCount)
```

Update the populate step to reuse the already-captured `bucketCount` instead of redeclaring it. Replace:

```ts
    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
    // comment for why this runs as a sequential loop instead of one INSERT.
    const bucketCount = contentDedupBucketCount()
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
```

with:

```ts
    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
    // comment for why this runs as a sequential loop instead of one INSERT.
    // bucketCount was already captured in step 0 above (shared with the
    // stats/cutoff distinct-count buckets -- see CUTOFF/STATS SCALE).
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
```

Update the verify step's inline comment (stale `buildCutoffSql` reference). Replace:

```ts
    // 6. Verify before swapping. cdedupRows >= expectedRows (not ==): the
    // build may have picked up a few rows imported just after cutoff in
    // addition to everything that existed at that moment -- a good outcome,
    // not a mismatch (see buildCutoffSql's comment). A count BELOW
    // expectedRows means the build genuinely lost pre-existing content keys,
    // which is the real failure this check exists to catch. excessAfter
    // stays a strict == 0 check regardless of timing -- a LIMIT 1 BY-built
    // table must never have internal duplicates.
```

with:

```ts
    // 6. Verify before swapping. cdedupRows >= expectedRows (not ==): the
    // build may have picked up a few rows imported just after cutoff in
    // addition to everything that existed at that moment -- a good outcome,
    // not a mismatch (see buildDistinctContentKeyCountSqlForBucket's
    // comment). A count BELOW expectedRows means the build genuinely lost
    // pre-existing content keys, which is the real failure this check
    // exists to catch. excessAfter stays a strict == 0 check regardless of
    // timing -- a LIMIT 1 BY-built table must never have internal
    // duplicates.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- content-dedup`
Expected: PASS — all tests in `__tests__/content-dedup.test.ts` green.

- [ ] **Step 5: Run the full test suite and typecheck to confirm nothing else broke**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts
git commit -m "$(cat <<'EOF'
fix(content-dedup): bucket the cutoff/stats distinct-count query

buildStatsSql() and buildCutoffSql() both ran uniqExact(cityHash64(
CONTENT_KEY)) as a single ungrouped aggregate over the whole table --
confirmed live to hit MEMORY_LIMIT_EXCEEDED at 562M rows / ~470M
distinct content keys, right at this server's 16 GiB ceiling. Neither
max_threads bounding nor max_bytes_before_external_group_by spilling
has any effect on this query shape (both confirmed live, including
reshaped into a real multi-group GROUP BY) -- a zero-key uniqExact
holds one hash set for the query's whole duration with nothing for
either lever to act on. Buckets the distinct-count the same way the
populate step buckets its INSERT: sum(uniqExact per disjoint bucket)
is exact, not approximate, since a content-duplicate group always
hashes to one bucket.

Full design: docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

> **Note (added after this task's review):** the stats step's original design above (a separate `buildTotalRowCountSql()` query, then a bucketed distinct-count sum) was found during task review to have a timing-consistency gap -- `total` was captured by one fast query while `distinctCreds` was assembled from a slower, multi-bucket scan that could observe more live inserts landing in between, understating (or even negating) `excess`. The shipped implementation instead folds `count()` into the same per-bucket query as `uniqExact()`: `buildDistinctContentKeyCountSqlForBucket` was renamed to `buildContentKeyStatsSqlForBucket` and now returns both `bucket_total` and `bucket_distinct`; `buildTotalRowCountSql()` was removed and never shipped; `sumDistinctContentKeysBucketed` was renamed to `sumBucketedContentKeyStats` and returns `{ total, distinctCreds }`. See `lib/content-dedup.ts`'s `CUTOFF/STATS SCALE` comment (renamed to `DISTINCT-COUNT SCALE` by Task 2 below) and commit `b31870b` for the exact final shape. Task 2 below uses this same combined-query pattern from the start, and further generalizes the summing helper so it isn't duplicated a third time.

---

### Task 2: Bucket the verify-step distinct-count query

**Files:**
- Modify: `lib/content-dedup.ts`
- Modify: `__tests__/content-dedup.test.ts`

**Interfaces:**
- Consumes from Task 1's shipped implementation (not this plan document's original Task 1 text -- see the note above): `buildContentKeyStatsSqlForBucket(bucketIndex, bucketCount): string` (returns `bucket_total`/`bucket_distinct`), `sumBucketedContentKeyStats(client, bucketCount): Promise<{ total, distinctCreds }>` (to be generalized by this task), `CONTENT_KEY`, `AUTO_DEDUP_TABLE`.
- Produces (used by Task 5): `buildVerifyDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string`; generalized `sumBucketedTotalAndDistinct(client, bucketCount, buildBucketSql): Promise<{ total, distinctCreds }>` (internal, not exported -- replaces `sumBucketedContentKeyStats`).
- Removed: `buildVerifyDedupedTableSql()`.

**Why this task exists:** `buildVerifyDedupedTableSql()` runs `count() - uniqExact(cityHash64(CONTENT_KEY)) AS excess_after` over `AUTO_DEDUP_TABLE` -- the exact same ungrouped-`uniqExact`-over-a-large-table shape Task 1 fixed for `ulp.credentials`, but against the freshly-built dedup table instead. Once populated, `AUTO_DEDUP_TABLE` has ~470M rows with (by construction, via `LIMIT 1 BY CONTENT_KEY`) almost no internal duplicates -- meaning its distinct-to-row ratio is if anything *higher* than `ulp.credentials`' was, so this query is at least as memory-risky as the one already fixed. This was missed in Task 1's original scope (which only fixed the two functions confirmed to have failed live) and found via a codebase-wide search for the same bug pattern. If left unfixed, Task 5 (the live full-tick verification) would get past the now-fixed cutoff step, complete the full 32-bucket populate, and then crash at this verify step instead.

- [ ] **Step 1: Update the test file (will fail to import — expected RED)**

In `__tests__/content-dedup.test.ts`, replace the import block:

```ts
import {
  CONTENT_KEY,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffTimestampSql,
  buildContentKeyStatsSqlForBucket,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildEnsureSearchIndexesSql,
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
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffTimestampSql,
  buildContentKeyStatsSqlForBucket,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildEnsureSearchIndexesSql,
  buildVerifyDedupedTableSqlForBucket,
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
  describe('buildVerifyDedupedTableSql', () => {
    test('reports the deduped table\'s own row count and internal excess only -- does not separately query the original table', () => {
      const sql = buildVerifyDedupedTableSql()
      expect(sql).toContain(`FROM ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY}))`)
      expect(sql).toContain('AS cdedup_rows')
      expect(sql).toContain('AS excess_after')
      // Exactly one data source (AUTO_DEDUP_TABLE) -- the old design queried
      // the original ulp.credentials too, which is what caused the
      // moving-target verification bug this shape fixes.
      expect(sql.match(/FROM/g)?.length).toBe(1)
      expect(sql).not.toContain('expected_rows')
    })
  })
```

with:

```ts
  describe('buildVerifyDedupedTableSqlForBucket', () => {
    test('counts one bucket\'s row total and distinct content keys together, against AUTO_DEDUP_TABLE only', () => {
      const sql = buildVerifyDedupedTableSqlForBucket(5, 32)
      expect(sql).toContain('count() AS bucket_total')
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct`)
      expect(sql).toContain(`FROM ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 5`)
      expect(sql).toContain('max_execution_time = 300')
      // Exactly one data source (AUTO_DEDUP_TABLE) -- the old design queried
      // the original ulp.credentials too, which is what caused the
      // moving-target verification bug this shape fixes.
      expect(sql.match(/FROM/g)?.length).toBe(1)
      expect(sql).not.toContain('expected_rows')
    })

    test('a different bucket index changes only the bucket filter', () => {
      const sql = buildVerifyDedupedTableSqlForBucket(0, 32)
      expect(sql).toContain(`WHERE cityHash64(${CONTENT_KEY}) % 32 = 0`)
    })
  })

  describe('bucket_total/bucket_distinct alias consistency', () => {
    test('buildContentKeyStatsSqlForBucket and buildVerifyDedupedTableSqlForBucket use the same field aliases -- sumBucketedTotalAndDistinct depends on this to stay generic across both', () => {
      const statsSql = buildContentKeyStatsSqlForBucket(0, 8)
      const verifySql = buildVerifyDedupedTableSqlForBucket(0, 8)
      expect(statsSql).toContain('AS bucket_total')
      expect(statsSql).toContain('AS bucket_distinct')
      expect(verifySql).toContain('AS bucket_total')
      expect(verifySql).toContain('AS bucket_distinct')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- content-dedup`
Expected: FAIL — `content-dedup.ts` has no exported member `buildVerifyDedupedTableSqlForBucket` (or similar import error).

- [ ] **Step 3: Update `lib/content-dedup.ts`**

Rename the file's `CUTOFF/STATS SCALE` header-comment paragraph to `DISTINCT-COUNT SCALE` and extend it to cover the verify step. Replace:

```ts
 * CUTOFF/STATS SCALE: buildStatsSql() and buildCutoffSql() (both removed)
 * ran uniqExact(cityHash64(CONTENT_KEY)) as a single ungrouped aggregate
 * over the whole table -- confirmed live 2026-07-19 to hit
 * MEMORY_LIMIT_EXCEEDED at 562M rows / ~470M distinct content keys, right
 * at this server's 16 GiB ceiling. Unlike the populate step's own memory
 * fix below, neither max_threads bounding nor
 * max_bytes_before_external_group_by spilling has any effect here (both
 * confirmed live to make no difference, including reshaped into a real
 * multi-group GROUP BY) -- a zero-key uniqExact holds one hash set for the
 * query's whole duration with nothing for either lever to act on.
 * buildCutoffTimestampSql()/buildContentKeyStatsSqlForBucket() replace
 * them, bucketing the distinct-count the same way the populate step below
 * buckets its INSERT -- summing per-bucket uniqExact counts is exact, not
 * approximate, via the same content-duplicate-group-hashes-to-one-bucket
 * guarantee. buildContentKeyStatsSqlForBucket() returns count() alongside
 * uniqExact() from the SAME per-bucket query rather than a separate,
 * earlier, unbucketed total query -- an earlier design computed total from
 * one fast query before the (slower, multi-bucket) distinct-count scan,
 * which let ongoing live inserts land between the two, understating (or
 * negating) the reported excess. Since count() >= uniqExact() always holds
 * within one query's single-pass read, summing both from the same buckets
 * keeps excess exact and never negative, by construction. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
```

with:

```ts
 * DISTINCT-COUNT SCALE: buildStatsSql(), buildCutoffSql(), and
 * buildVerifyDedupedTableSql() (all removed) each ran
 * uniqExact(cityHash64(CONTENT_KEY)) as a single ungrouped aggregate over a
 * large table (ulp.credentials for the first two, AUTO_DEDUP_TABLE for the
 * third -- itself the same order of magnitude once populated, since a
 * successfully-built dedup table has ~one row per distinct content key) --
 * confirmed live 2026-07-19 to hit MEMORY_LIMIT_EXCEEDED at 562M rows /
 * ~470M distinct content keys, right at this server's 16 GiB ceiling.
 * Unlike the populate step's own memory fix below, neither max_threads
 * bounding nor max_bytes_before_external_group_by spilling has any effect
 * here (both confirmed live to make no difference, including reshaped into
 * a real multi-group GROUP BY) -- a zero-key uniqExact holds one hash set
 * for the query's whole duration with nothing for either lever to act on.
 * buildCutoffTimestampSql()/buildContentKeyStatsSqlForBucket()/
 * buildVerifyDedupedTableSqlForBucket() replace them, bucketing the
 * distinct-count the same way the populate step below buckets its INSERT --
 * summing per-bucket uniqExact counts is exact, not approximate, via the
 * same content-duplicate-group-hashes-to-one-bucket guarantee.
 * buildContentKeyStatsSqlForBucket() and buildVerifyDedupedTableSqlForBucket()
 * both return count() alongside uniqExact() from the SAME per-bucket query
 * rather than a separate, earlier, unbucketed total query -- an earlier
 * design computed total from one fast query before the (slower,
 * multi-bucket) distinct-count scan, which let ongoing live inserts land
 * between the two, understating (or negating) the reported excess. Since
 * count() >= uniqExact() always holds within one query's single-pass read,
 * summing both from the same buckets keeps excess exact and never negative,
 * by construction. buildVerifyDedupedTableSqlForBucket() was found and
 * fixed in a second pass after the first two -- AUTO_DEDUP_TABLE isn't
 * concurrently written during verify (nothing else writes to it mid-tick),
 * so the timing-skew risk that motivated the combined-query shape for
 * ulp.credentials doesn't strictly apply here, but the same shape is used
 * anyway for consistency and because it costs nothing extra. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
```

Replace `buildVerifyDedupedTableSql()` and its doc comment:

```ts
/**
 * AUTO_DEDUP_TABLE's own row count and internal excess -- does not query the
 * original table (that comparison uses the cutoff step's expectedRows,
 * captured before the build started, via runContentDedupTick's `>=` check --
 * see buildContentKeyStatsSqlForBucket's comment for why a fresh
 * query here would be wrong).
 */
export function buildVerifyDedupedTableSql(): string {
  return `SELECT
    count() AS cdedup_rows,
    count() - uniqExact(cityHash64(${CONTENT_KEY})) AS excess_after
  FROM ${AUTO_DEDUP_TABLE}
  SETTINGS max_execution_time = 300`
}
```

with:

```ts
/**
 * AUTO_DEDUP_TABLE's own row count and internal excess, one bucket at a
 * time -- does not query the original table (that comparison uses the
 * cutoff step's expectedRows, captured before the build started, via
 * runContentDedupTick's `>=` check -- see buildContentKeyStatsSqlForBucket's
 * comment for why a fresh query here would be wrong). Bucketed for the same
 * reason buildContentKeyStatsSqlForBucket is: an ungrouped
 * uniqExact(cityHash64(CONTENT_KEY)) over AUTO_DEDUP_TABLE is the identical
 * memory risk once the table is populated (~470M rows, nearly all distinct
 * by construction -- a successful dedup leaves ~one row per content key, so
 * this table's distinct-to-row ratio is if anything higher than
 * ulp.credentials' was). See the file's DISTINCT-COUNT SCALE comment.
 */
export function buildVerifyDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `SELECT
    count() AS bucket_total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct
  FROM ${AUTO_DEDUP_TABLE}
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  SETTINGS max_execution_time = 300`
}
```

Generalize the bucketed-sum helper so the verify step can share it too. Replace:

```ts
/**
 * Sums buckets' row totals and distinct-content-key counts sequentially --
 * shared by both the stats step (uses both fields) and the cutoff step
 * below (uses distinctCreds only, as expectedRows). Not exported/unit-tested
 * separately: this file only unit-tests pure SQL builders, matching the
 * existing convention that the populate step's own bucket loop (inside
 * runContentDedupTick) isn't unit-tested either, only its SQL-builder
 * function is. Exercised by Tasks 2-4 of this plan instead.
 */
async function sumBucketedContentKeyStats(client: ClickHouseClient, bucketCount: number): Promise<{ total: number; distinctCreds: number }> {
  let total = 0
  let distinctCreds = 0
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const res = await client.query({ query: buildContentKeyStatsSqlForBucket(bucket, bucketCount), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ bucket_total: string; bucket_distinct: string }>
    total += Number(row?.bucket_total ?? 0)
    distinctCreds += Number(row?.bucket_distinct ?? 0)
  }
  return { total, distinctCreds }
}
```

with:

```ts
/**
 * Sums a bucketed query's row totals and distinct-content-key counts
 * sequentially -- shared by the stats step, the cutoff step, and the verify
 * step below, each passing its own per-bucket SQL builder
 * (buildContentKeyStatsSqlForBucket or buildVerifyDedupedTableSqlForBucket).
 * Both builders alias their two aggregates identically (`bucket_total`,
 * `bucket_distinct`) specifically so this loop can stay generic across
 * tables. Not exported/unit-tested separately: this file only unit-tests
 * pure SQL builders, matching the existing convention that the populate
 * step's own bucket loop (inside runContentDedupTick) isn't unit-tested
 * either, only its SQL-builder function is. Exercised by Tasks 3-5 of this
 * plan instead.
 */
async function sumBucketedTotalAndDistinct(
  client: ClickHouseClient,
  bucketCount: number,
  buildBucketSql: (bucketIndex: number, bucketCount: number) => string,
): Promise<{ total: number; distinctCreds: number }> {
  let total = 0
  let distinctCreds = 0
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const res = await client.query({ query: buildBucketSql(bucket, bucketCount), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ bucket_total: string; bucket_distinct: string }>
    total += Number(row?.bucket_total ?? 0)
    distinctCreds += Number(row?.bucket_distinct ?? 0)
  }
  return { total, distinctCreds }
}
```

Update the stats step call site. Replace:

```ts
    const { total, distinctCreds } = await sumBucketedContentKeyStats(client, bucketCount)
```

with:

```ts
    const { total, distinctCreds } = await sumBucketedTotalAndDistinct(client, bucketCount, buildContentKeyStatsSqlForBucket)
```

Update the cutoff step call site. Replace:

```ts
    const { distinctCreds: expectedRows } = await sumBucketedContentKeyStats(client, bucketCount)
```

with:

```ts
    const { distinctCreds: expectedRows } = await sumBucketedTotalAndDistinct(client, bucketCount, buildContentKeyStatsSqlForBucket)
```

Update the verify step. Replace:

```ts
    // 6. Verify before swapping. cdedupRows >= expectedRows (not ==): the
    // build may have picked up a few rows imported just after cutoff in
    // addition to everything that existed at that moment -- a good outcome,
    // not a mismatch (see buildContentKeyStatsSqlForBucket's
    // comment). A count BELOW expectedRows means the build genuinely lost
    // pre-existing content keys, which is the real failure this check
    // exists to catch. excessAfter stays a strict == 0 check regardless of
    // timing -- a LIMIT 1 BY-built table must never have internal
    // duplicates.
    const verifyRes = await client.query({ query: buildVerifyDedupedTableSql(), format: 'JSONEachRow' })
    const [verify] = (await verifyRes.json()) as Array<{ cdedup_rows: string; excess_after: string }>
    const cdedupRows = Number(verify?.cdedup_rows ?? -1)
    const excessAfter = Number(verify?.excess_after ?? -1)
    if (cdedupRows < expectedRows || excessAfter !== 0) {
```

with:

```ts
    // 6. Verify before swapping, one bucket at a time -- see the file's
    // DISTINCT-COUNT SCALE comment for why AUTO_DEDUP_TABLE needs the same
    // bucketing treatment as ulp.credentials' own stats/cutoff queries.
    // cdedupRows >= expectedRows (not ==): the build may have picked up a
    // few rows imported just after cutoff in addition to everything that
    // existed at that moment -- a good outcome, not a mismatch (see
    // buildContentKeyStatsSqlForBucket's comment). A count BELOW
    // expectedRows means the build genuinely lost pre-existing content
    // keys, which is the real failure this check exists to catch.
    // excessAfter stays a strict == 0 check regardless of timing -- a
    // LIMIT 1 BY-built table must never have internal duplicates.
    const { total: cdedupRows, distinctCreds: cdedupDistinct } = await sumBucketedTotalAndDistinct(client, bucketCount, buildVerifyDedupedTableSqlForBucket)
    const excessAfter = cdedupRows - cdedupDistinct
    if (cdedupRows < expectedRows || excessAfter !== 0) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- content-dedup`
Expected: PASS — all tests in `__tests__/content-dedup.test.ts` green.

- [ ] **Step 5: Run the full test suite and typecheck to confirm nothing else broke**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts
git commit -m "$(cat <<'EOF'
fix(content-dedup): bucket the verify-step distinct-count query

buildVerifyDedupedTableSql() ran the same ungrouped
uniqExact(cityHash64(CONTENT_KEY)) shape that MEMORY_LIMIT_EXCEEDED
was already fixed for in ulp.credentials' stats/cutoff queries, but
against AUTO_DEDUP_TABLE instead -- missed in that first pass since
only the two functions confirmed to have failed live were in scope.
Once populated, AUTO_DEDUP_TABLE has ~470M rows nearly all distinct by
construction (LIMIT 1 BY leaves ~one row per content key), so this
query is at least as memory-risky as the one already fixed -- left
unfixed, a live rewrite+swap would get past the fixed cutoff step,
complete the full populate, and crash here instead.

Buckets the same way, and generalizes the bucketed-sum helper
(sumBucketedContentKeyStats -> sumBucketedTotalAndDistinct) so it's
shared across the stats, cutoff, and verify steps rather than
duplicated a third time.

Full design: docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Synthetic mechanism re-confirmation

**Files:** None (no repository changes; touches only ClickHouse's synthetic `numbers()` generator, no real or disposable tables). No commit.

**Interfaces:** None (formalizes the ad hoc investigation from the design doc into a repeatable check; does not call any TypeScript code).

- [ ] **Step 1: Run the unchunked-fails / bucketed-succeeds comparison**

```bash
echo "=== unchunked uniqExact over 50M distinct values, tight cap (expect MEMORY_LIMIT_EXCEEDED) ==="
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT uniqExact(number) FROM numbers(50000000)
SETTINGS max_memory_usage = 943718400
" 2>&1

echo ""
echo "=== same data, 8-way bucketed sum, same cap per bucket (expect 50000000, no error) ==="
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT sum(c) AS total_distinct FROM (
  SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 0 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 1 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 2 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 3 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 4 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 5 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 6 SETTINGS max_memory_usage = 943718400
  UNION ALL SELECT uniqExact(number) AS c FROM numbers(50000000) WHERE number % 8 = 7 SETTINGS max_memory_usage = 943718400
)
" 2>&1
```

Expected: the first query fails with `Code: 241` / `DB::Exception: ... MEMORY_LIMIT_EXCEEDED`. The second query succeeds and prints `50000000` — the exact true count, with zero drift from bucketing. (Note: the real production failure occurred in ClickHouse's `ConvertingAggregatedToChunksTransform` stage, a later point in the pipeline than this synthetic repro's `AggregatingTransform` failure — the 900 MiB cap here is tight enough relative to 50M rows that it fails before even finishing the build phase, whereas the real 16 GiB cap is generous enough relative to 470M rows to get further before failing. Both are the same underlying problem — one hash set too large to fit — observed at different points along the same curve; the fix (bucketing) addresses the root size problem regardless of which downstream stage would eventually OOM.)

- [ ] **Step 2: Report results**

Report the exact output of both queries above (error text for the first, the returned number for the second) — no commit for this task.

---

### Task 4: Live read-only verification — stats path against real `ulp.credentials`

**Files:** Create (scratchpad only, never committed): a one-off verification script.

**Interfaces:**
- Consumes: `buildContentKeyStatsSqlForBucket`, `contentDedupBucketCount` from Task 1's `lib/content-dedup.ts`.

This exercises the actual shipped code (not hand-rolled SQL) against real, live-scale data. Unlike Task 5, this is entirely read-only — no tables are created, dropped, or renamed — so it carries none of the risk a rewrite+swap attempt does, and can be run directly without the checkpoint ceremony Task 5 needs.

- [ ] **Step 1: Write the verification script**

Create a file under this session's scratchpad directory with this exact content:

```ts
// One-off verification script for the cutoff/stats bucketing fix. NOT
// committed to the repository. Only exercises the read-only stats path
// (the bucketed total+distinct sum) against real ulp.credentials -- no
// tables created, dropped, or renamed. Configuration comes from the shell
// invocation's environment -- see the command below.
import { getClient } from '@/lib/clickhouse'
import { buildContentKeyStatsSqlForBucket, contentDedupBucketCount } from '@/lib/content-dedup'

async function main() {
  const client = getClient()
  const bucketCount = contentDedupBucketCount()
  const start = Date.now()

  let total = 0
  let distinctCreds = 0
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const bucketStart = Date.now()
    const res = await client.query({ query: buildContentKeyStatsSqlForBucket(bucket, bucketCount), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ bucket_total: string; bucket_distinct: string }>
    const bucketTotal = Number(row?.bucket_total ?? 0)
    const bucketDistinct = Number(row?.bucket_distinct ?? 0)
    total += bucketTotal
    distinctCreds += bucketDistinct
    console.log(`bucket ${bucket}/${bucketCount - 1}: +${bucketTotal} total, +${bucketDistinct} distinct (${Date.now() - bucketStart}ms)`)
  }

  const excess = total - distinctCreds
  console.log(`RESULT total=${total} distinctCreds=${distinctCreds} excess=${excess} elapsed=${Date.now() - start}ms`)
}

main()
```

- [ ] **Step 2: Run it against real data**

Run from this repository checkout's root (so `npx` finds the locally-installed `tsx`, matching this session's established precedent for resolving `@/` path aliases correctly):

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
npx tsx /path/to/this/scratchpad/file.ts
```

Expected: 32 `bucket N/31: +...` lines print with no error, followed by one `RESULT ...` line. No `MEMORY_LIMIT_EXCEEDED`. `total` should be at or slightly above `562400008` (ongoing ingest since tonight's report), `distinctCreds` at or slightly above `470713684`, `excess` at or slightly above `91686324` — all consistent with tonight's last successful `buildStatsSql()` reading, not a wildly different number (which would indicate a bug in the bucketing logic, e.g. double-counting or a missed bucket).

- [ ] **Step 3: Report results and clean up**

Report the full output (all 32 per-bucket lines and the final `RESULT` line). No commit — the verification script was never added to the repository; delete it from the scratchpad directory once results are recorded.

---

### Task 5: Live full-tick verification — cutoff path + rewrite+swap against real data

**Files:** Create (scratchpad only, never committed): a one-off verification script.

**Interfaces:**
- Consumes: `runContentDedupTick` from Task 1's `lib/content-dedup.ts`, invoked directly against real `ulp.credentials`.

> **This re-enters the full destructive rewrite+swap flow** — the same one that failed at the cutoff step tonight before this plan's fix. Treat it with the same care as every prior live attempt this session: confirm pre-state, watch progress, confirm post-state independently. Do not skip Steps 1 or 3.

- [ ] **Step 1: Confirm pre-state**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_cdedup_auto"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_predup_auto"
```

Expected: the real row count, and both `EXISTS` checks return `0`. If either returns `1`, a prior attempt left a table behind — investigate before proceeding rather than assuming it's safe to ignore.

- [ ] **Step 2: Write and run the one-off verification script**

Create a file under this session's scratchpad directory with this exact content:

```ts
// One-off verification script for the cutoff/stats bucketing fix's cutoff
// path. NOT committed to the repository. All configuration
// (CONTENT_DEDUP_APPLY, DEDUP_MIN_EXCESS, and the ClickHouse connection)
// comes from the shell invocation's environment -- see the command below.
import { runContentDedupTick } from '@/lib/content-dedup'

async function main() {
  const result = await runContentDedupTick({ trigger: 'manual-verification-cutoff-bucketing' })
  console.log('runContentDedupTick result:', JSON.stringify(result))
}

main()
```

Run it from this repository checkout's root, with the ClickHouse IP resolved fresh and the real credentials pulled from the primary worktree's `.env` (same pattern as Task 3, `.env` is gitignored and does not exist in a fresh session worktree):

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

Expected: the script's `[content-dedup]` log lines show the cutoff captured without `MEMORY_LIMIT_EXCEEDED` (this is the specific failure this plan exists to fix — if it recurs here, stop and re-open the investigation rather than retrying), followed by the 32-bucket populate progress, then the verify step's own 32-bucket scan against `AUTO_DEDUP_TABLE`, and a final `runContentDedupTick result:` line showing `applied: true`. Given this runs 32+32+32 sequential bucket queries (stats + cutoff + verify) plus the 32-bucket populate against the real ~562M-row table, expect this to take substantially longer than tonight's single failed attempt — do not interrupt it prematurely on the assumption it has hung; check `system.merges`/`system.parts` directly before concluding that.

- [ ] **Step 3: Confirm post-state independently**

**Do not run this as one unbucketed query** — `ulp.credentials` post-swap is the just-built, deduplicated table (~470M rows, nearly all distinct), the same memory-risk shape Tasks 1-2 exist to fix; an unbucketed confirmation here would hit the identical `MEMORY_LIMIT_EXCEEDED` this whole plan is about. Bucket it the same way, summing in bash:

```bash
TOTAL=0
DISTINCT=0
for BUCKET in $(seq 0 31); do
  ROW=$(docker exec ulpsuite_clickhouse clickhouse-client --query "
    SELECT count() AS bucket_total, uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS bucket_distinct
    FROM ulp.credentials
    WHERE cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) % 32 = $BUCKET
    SETTINGS max_execution_time = 300
  " --format TabSeparated)
  BT=$(echo "$ROW" | cut -f1)
  BD=$(echo "$ROW" | cut -f2)
  TOTAL=$((TOTAL + BT))
  DISTINCT=$((DISTINCT + BD))
done
EXCESS=$((TOTAL - DISTINCT))
echo "total=$TOTAL distinct=$DISTINCT excess=$EXCESS"
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

Report: the pre-state and post-state numbers from Steps 1 and 3, confirmation the projection survived, confirmation `ulp.credentials_predup_auto` is intact with the correct row count, and confirmation `CONTENT_DEDUP_APPLY` remains unset in `.env`. Delete the scratchpad verification script (never committed). Do not drop `ulp.credentials_predup_auto` — leave it as the rollback safety net for the remainder of the retention window described in the file's `ROLLBACK` comment. Do not enable `CONTENT_DEDUP_APPLY=true` for ongoing scheduled use regardless of this attempt's outcome — that remains a separate, later decision.
