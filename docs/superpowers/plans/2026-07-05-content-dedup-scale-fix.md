# Content-Dedup Scale Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lib/content-dedup.ts`'s DELETE mutation safe to run against the current ~91M-row `ulp.credentials` table, so `CONTENT_DEDUP_APPLY` can eventually be enabled without crashing the ClickHouse server.

**Architecture:** Switch `buildDeleteSql()` from a heavyweight `ALTER TABLE ... DELETE` to a lightweight `DELETE FROM`, and consolidate three settings at the single call site that submits it: `max_threads = 2` (bounds concurrent subquery re-evaluation across the background merge pool), `max_bytes_before_external_group_by` set to a value the query will actually reach before any higher memory cap (lets the expensive `GROUP BY` spill to disk instead of hitting `MEMORY_LIMIT_EXCEEDED`), and the existing `mutations_sync = 0`. This mirrors `scripts/purge-existing-t3.sh`'s already-proven fix for the same class of problem on this exact table.

**Tech Stack:** TypeScript, Vitest, ClickHouse 26.3.17 (via `@clickhouse/client` through `lib/clickhouse.ts`'s `getClient()`).

## Global Constraints

- `CONTENT_DEDUP_APPLY` must remain `false` throughout this plan. Flipping it to `true` in production is an explicit, separate, manual step **outside this plan's scope** — it requires direct authorization at that time, not automatic execution as a plan step.
- `ulp.credentials` itself must never be modified by this plan. All live verification happens against a disposable table created from a read-only copy of a slice of real data, dropped at the end.
- `buildDeleteSql()` must never return its own `SETTINGS` clause. `runContentDedupTick()` already appends `SETTINGS mutations_sync = 0` by string concatenation after calling it — a second embedded `SETTINGS` clause would produce invalid SQL (two `SETTINGS` keywords in one statement).
- Named constants only for memory/thread thresholds, matching this codebase's existing `EXPORT_GROUP_BY_MAX_MEMORY_BYTES` convention — no inline magic numbers in the shipped code.
- Reference spec: `docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md`.

---

### Task 1: Switch `buildDeleteSql()` to lightweight `DELETE FROM` with consolidated settings

**Files:**
- Modify: `lib/content-dedup.ts`
- Modify: `__tests__/content-dedup.test.ts`

**Interfaces:**
- Produces: `buildDeleteSql(): string` (changed return shape — `DELETE FROM ulp.credentials WHERE ...` instead of `ALTER TABLE ulp.credentials DELETE WHERE ...`, still never includes a `SETTINGS` clause), `buildDeleteExecSql(): string` (new — the exact statement `runContentDedupTick()` submits, with all three settings consolidated), `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES: number` (new constant, `4_294_967_296`).
- Consumes: existing `CONTENT_DUPLICATE_PREDICATE` (unchanged).

- [ ] **Step 1: Write the failing tests**

Open `__tests__/content-dedup.test.ts`. Replace the `buildDeleteSql` describe block (currently lines 23-32) with the updated assertion plus new coverage, and add the import for the two new exports.

Change the import block at the top of the file from:

```ts
import {
  CONTENT_KEY,
  buildStatsSql,
  buildDeleteSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
```

to:

```ts
import {
  CONTENT_KEY,
  buildStatsSql,
  buildDeleteSql,
  buildDeleteExecSql,
  CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
```

Replace the existing `buildDeleteSql` describe block:

```ts
  describe('buildDeleteSql', () => {
    const sql = buildDeleteSql()
    test('is an ALTER TABLE … DELETE on ulp.credentials', () => {
      expect(sql.startsWith('ALTER TABLE ulp.credentials DELETE WHERE')).toBe(true)
    })
    test('keeps one survivor per content group (min full-hash, grouped by content)', () => {
      expect(sql).toContain('NOT IN (SELECT min(')
      expect(sql).toContain(`GROUP BY ${URL_CONTENT_KEY}, email, password`)
    })
  })
```

with:

```ts
  describe('buildDeleteSql', () => {
    const sql = buildDeleteSql()
    test('is a lightweight DELETE FROM on ulp.credentials, not a heavyweight ALTER TABLE', () => {
      expect(sql.startsWith('DELETE FROM ulp.credentials WHERE')).toBe(true)
      expect(sql).not.toContain('ALTER TABLE')
    })
    test('keeps one survivor per content group (min full-hash, grouped by content)', () => {
      expect(sql).toContain('NOT IN (SELECT min(')
      expect(sql).toContain(`GROUP BY ${URL_CONTENT_KEY}, email, password`)
    })
    test('never includes its own SETTINGS clause', () => {
      // runContentDedupTick() appends the real SETTINGS clause via
      // buildDeleteExecSql() — a second one here would make the combined
      // statement invalid SQL (two SETTINGS keywords).
      expect(sql).not.toContain('SETTINGS')
    })
  })

  describe('CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES', () => {
    test('is 4 GiB', () => {
      expect(CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES).toBe(4_294_967_296)
    })
  })

  describe('buildDeleteExecSql', () => {
    test('combines the delete statement with mutations_sync, bounded threads, and external group-by spill in exactly one SETTINGS clause', () => {
      const sql = buildDeleteExecSql()
      expect(sql).toContain('DELETE FROM ulp.credentials WHERE')
      expect(sql).toContain(
        'SETTINGS mutations_sync = 0, max_threads = 2, max_bytes_before_external_group_by = 4294967296',
      )
      expect(sql.match(/SETTINGS/g)?.length).toBe(1)
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/content-dedup.test.ts`
Expected: FAIL — `buildDeleteExecSql` and `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES` are not exported yet (import error or `undefined`), and the `startsWith('DELETE FROM ...')` assertion fails against the current `ALTER TABLE ...` output.

- [ ] **Step 3: Implement the change in `lib/content-dedup.ts`**

Replace the file's header comment's `SCALE` paragraph — currently:

```ts
 * SCALE: the stats query (uniqExact) is fine through the current ~91M rows
 * (confirmed live 2026-07-04, 5s). The DELETE mutation is NOT verified at this
 * scale and should not be enabled (CONTENT_DEDUP_APPLY=true) until redesigned —
 * confirmed live: the exact CONTENT_DUPLICATE_PREDICATE subquery (`SELECT
 * min(FULL_HASH) ... GROUP BY CONTENT_KEY`, ~67M distinct groups) exceeds 4 GiB
 * in ~1.6s for a single evaluation. ClickHouse re-evaluates big-table mutation
 * subqueries per merge per part, not once (each merge keeps its own HashSet in
 * memory), so under this instance's ~20-thread background pool the real cost
 * when the mutation actually runs could be a low multiple of that — plausibly
 * past the server's effective memory ceiling. system.mutations confirms this
 * DELETE has never actually run against this table. Fix direction: a
 * precomputed content-key dedup table maintained incrementally, same pattern as
 * mv_domain_counts / mv_password_counts in lib/clickhouse-migrations.ts, so the
 * mutation reads a small lookup instead of re-deriving ~67M group memberships
 * inline. The min-excess threshold avoids needless mutations but does not
 * address this risk once excess exceeds it.
 */
```

with:

```ts
 * SCALE: the stats query (uniqExact) is fine through the current ~91M rows
 * (confirmed live 2026-07-04, 5s). The DELETE mutation used to be a heavyweight
 * `ALTER TABLE ... DELETE`, whose CONTENT_DUPLICATE_PREDICATE subquery (~67M
 * distinct groups) exceeded 4 GiB in ~1.6s for a single evaluation — and
 * ClickHouse re-evaluates big-table mutation subqueries per merge per part, not
 * once, so under this instance's ~20-thread background pool the real cost could
 * multiply well past the server's memory ceiling. Fixed 2026-07-05: switched to
 * a lightweight `DELETE FROM` (matching scripts/purge-existing-t3.sh's proven
 * fix for the same class of problem on this table) with max_threads=2 (bounds
 * concurrent subquery re-evaluation) and max_bytes_before_external_group_by
 * (CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES below) deliberately NOT paired with
 * an explicit max_memory_usage override — unlike lib/clickhouse-query-limits.ts's
 * exportGroupBySettings(), where setting max_memory_usage below the profile's
 * 20 GiB spill threshold made spilling unreachable. Full investigation:
 * docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md.
 * Do not set CONTENT_DEDUP_APPLY=true until that spec's "Verification plan"
 * has actually been completed against disposable data — this fix is confirmed
 * against an equivalent read-only SELECT, not yet against a real mutation.
 */
```

Replace:

```ts
export function buildDeleteSql(): string {
  return `ALTER TABLE ulp.credentials DELETE WHERE ${CONTENT_DUPLICATE_PREDICATE}`
}
```

with:

```ts
export function buildDeleteSql(): string {
  return `DELETE FROM ulp.credentials WHERE ${CONTENT_DUPLICATE_PREDICATE}`
}

/**
 * Memory ceiling for the DELETE mutation's inline CONTENT_DUPLICATE_PREDICATE
 * subquery. Confirmed live 2026-07-04: without this, the subquery exceeds
 * 4 GiB in ~1.6s; with it, it succeeds in ~17.8s (disk spill). No
 * max_memory_usage override is set alongside this anywhere this is used — see
 * the SCALE comment above for why that pairing matters.
 */
export const CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

/** Full statement runContentDedupTick() submits — exported so its exact shape is testable. */
export function buildDeleteExecSql(): string {
  return `${buildDeleteSql()} SETTINGS mutations_sync = 0, max_threads = 2, max_bytes_before_external_group_by = ${CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES}`
}
```

In `runContentDedupTick()`, replace:

```ts
    await client.exec({ query: `${buildDeleteSql()} SETTINGS mutations_sync = 0` })
    console.log(`[content-dedup] submitted ALTER DELETE (~${excess} duplicate rows, async mutation)`)
```

with:

```ts
    await client.exec({ query: buildDeleteExecSql() })
    console.log(`[content-dedup] submitted DELETE FROM (~${excess} duplicate rows, async mutation)`)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/content-dedup.test.ts`
Expected: PASS — all tests in the file green, including the three new/updated ones.

- [ ] **Step 5: Run the full suite and typecheck to confirm no regressions**

Run: `npx vitest run`
Expected: same pass count as before this change, plus the new tests (no new failures; this repo has a pre-existing intermittent SQLite `users.email` ownership failure in `upload-processor.test.ts`/`upload-skip-imported.test.ts` unrelated to this change — do not treat that as a regression).

Run: `npx tsc --noEmit`
Expected: exit code 0, no output.

- [ ] **Step 6: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts
git commit -m "fix(content-dedup): switch DELETE mutation to lightweight DELETE FROM with bounded settings

Heavyweight ALTER TABLE DELETE's inline GROUP BY subquery (~67M distinct
content-key groups) exceeds 4 GiB for a single evaluation, and ClickHouse
re-evaluates big-table mutation subqueries per merge per part — under this
instance's ~20-thread background pool that could multiply well past the
server's memory ceiling. Switches to lightweight DELETE FROM with
max_threads=2 and max_bytes_before_external_group_by, mirroring
scripts/purge-existing-t3.sh's proven fix for the same class of problem on
this table. CONTENT_DEDUP_APPLY stays false — no behavior change yet; see
docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md."
```

---

### Task 2: Verify the fix against disposable data (not production)

**Files:**
- Create (ClickHouse, temporary): table `ulp.content_dedup_verify_test`, dropped at the end of this task
- Modify: `docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md`

**Interfaces:**
- Consumes: `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES`, `buildDeleteExecSql()` conceptually (this task hand-writes the equivalent SQL against a differently-named table, since `CONTENT_DUPLICATE_PREDICATE` hardcodes `ulp.credentials` in its `GROUP BY` subquery and isn't parameterizable by table name).

This task never modifies `ulp.credentials`. All commands run via `docker exec -i ulpsuite_clickhouse clickhouse-client`.

- [ ] **Step 1: Create a disposable copy table from real data (read-only against the source)**

```sql
CREATE TABLE ulp.content_dedup_verify_test
ENGINE = MergeTree()
ORDER BY (domain, email, imported_at)
AS SELECT url, email, password, domain, source_file, breach_name, imported_at
FROM ulp.credentials
LIMIT 2000000
```

Run: `echo "<above SQL>" | docker exec -i ulpsuite_clickhouse clickhouse-client`
Expected: command completes with no output (DDL success). This only reads from `ulp.credentials`; nothing in it is modified.

- [ ] **Step 2: Record baseline stats for the test table**

```sql
SELECT
  count() AS total,
  uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password)) AS distinct_creds,
  count() - uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password)) AS excess
FROM ulp.content_dedup_verify_test
```

Run and record the three numbers printed (tab-separated: total, distinct_creds, excess). `total` should be `2000000`. Note the `excess` value — it's checked against the post-delete row count in Step 5.

- [ ] **Step 3 (red): Confirm this test table's scale is large enough to actually stress the GROUP BY without the fix**

```sql
SELECT min(cityHash64(url, email, password, domain, source_file, breach_name, imported_at))
FROM ulp.content_dedup_verify_test
GROUP BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password
SETTINGS max_memory_usage = 67108864, max_execution_time = 60
FORMAT Null
```

(`max_memory_usage = 67108864` is 64 MiB, deliberately tiny, with no spill setting — this is the "before the fix" case.)

Expected: `Code: 241. DB::Exception: ... MEMORY_LIMIT_EXCEEDED`.

If this unexpectedly **succeeds** instead of failing, the 2,000,000-row sample doesn't have enough distinct content-key groups to be a meaningful test at this threshold. In that case: drop the test table (`DROP TABLE ulp.content_dedup_verify_test`), redo Step 1 with `LIMIT 10000000` instead of `LIMIT 2000000`, and retry from Step 2. Do not proceed to Step 4 until Step 3 reproduces a real `MEMORY_LIMIT_EXCEEDED` failure — a "fix" that was never shown to fix anything doesn't verify the design.

- [ ] **Step 4 (green): Run the actual lightweight DELETE with the fix's settings, at the same tiny threshold**

```sql
DELETE FROM ulp.content_dedup_verify_test
WHERE cityHash64(url, email, password, domain, source_file, breach_name, imported_at) NOT IN (
  SELECT min(cityHash64(url, email, password, domain, source_file, breach_name, imported_at))
  FROM ulp.content_dedup_verify_test
  GROUP BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password
)
SETTINGS mutations_sync = 2,
         max_threads = 2,
         max_bytes_before_external_group_by = 67108864
```

(Same 64 MiB threshold as Step 3's failure case, now with `max_bytes_before_external_group_by` set — this isolates the spill setting as the variable that changes red to green. `mutations_sync = 2` makes this synchronous for a deterministic test; production uses `mutations_sync = 0` (async) intentionally and that is not being changed.)

Expected: command completes with no error.

- [ ] **Step 5: Verify correctness — the right number of rows were actually removed**

```sql
SELECT count() FROM ulp.content_dedup_verify_test
```

Expected: `2000000 - excess`, where `excess` is the value recorded in Step 2.

- [ ] **Step 6: Verify the in-flight-mutation check still matches**

```sql
SELECT command, is_done
FROM system.mutations
WHERE database = 'ulp' AND table = 'content_dedup_verify_test'
ORDER BY create_time DESC
LIMIT 1
```

Expected: one row, `is_done = 1`, and `command` contains the substring `GROUP BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password` (this is `MUTATION_MARKER`'s value in `lib/content-dedup.ts` — the existing `system.mutations` in-flight check in `runContentDedupTick()` does a `LIKE '%<that text>%'` match against this same `command` column). If no row appears here, or `command` doesn't contain that substring, the in-flight-mutation guard will not detect a running content-dedup delete under the new lightweight-delete mechanism — stop and report this rather than proceeding, since it means `runContentDedupTick()` needs an additional fix beyond this plan's Task 1 before `CONTENT_DEDUP_APPLY` can be safely enabled.

- [ ] **Step 7: Clean up**

```sql
DROP TABLE ulp.content_dedup_verify_test
```

- [ ] **Step 8: Update the spec's Verification plan section and commit**

In `docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md`, find the `### Verification plan (before touching production data)` section and its two numbered items. Replace the section with a version that records what Steps 1-7 above actually found — state plainly whether both items are now confirmed (append the specific numbers observed: the row counts from Steps 1/2/5, and whether Step 6 found a matching, completed mutation row), or which one failed and needs a follow-up fix. Do not mark this section "confirmed" unless Steps 3-6 above actually passed as expected.

```bash
git add docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md
git commit -m "docs(specs): record content-dedup fix verification results

Confirmed live against a disposable 2M-row copy of ulp.credentials (dropped
after testing, ulp.credentials itself untouched): lightweight DELETE FROM
combined with the CONTENT_DUPLICATE_PREDICATE subquery spills correctly under
max_bytes_before_external_group_by, and the resulting mutation is visible to
the existing system.mutations in-flight check."
```

---

## After this plan

`CONTENT_DEDUP_APPLY` is still `false`. Enabling it in production is a deliberate, separate action — not a task in this plan, and not something to do automatically just because both tasks above are complete. When that decision is made, follow the spec's "Rollout plan" section (watch for `MEMORY_LIMIT_EXCEEDED` in server logs, confirm the mutation reaches `is_done=1` in a reasonable window, confirm `excess` drops by roughly the expected count).
