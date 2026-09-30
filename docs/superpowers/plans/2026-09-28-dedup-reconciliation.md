# Credential Dedup Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate credential deduplication on `ulp.credentials` to one mechanism (`lib/content-dedup.ts`), cut it over from report-only to actually reclaiming disk space, and retire everything it supersedes.

**Architecture:** Add a `was_duplicated` boolean column and teach content-dedup's existing populate/catch-up SQL to set it. Add a thin manual-trigger script that calls the same guarded, bucketed function the cron already uses. Run one supervised apply cycle, verify it, then arm the cron and delete the three now-redundant mechanisms plus four dead materialized-view tables left over from an incomplete prior migration.

**Tech Stack:** TypeScript, Next.js, ClickHouse (26.3.17), Vitest, tsx for standalone scripts.

## Global Constraints

- Content-key definition, survivor selection (earliest `imported_at`), and the disk-headroom guard are unchanged by this plan — see `docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md`'s Out of Scope.
- `was_duplicated` is a plain `UInt8 DEFAULT 0` column, never `MATERIALIZED` — its real values are written by content-dedup's own rewrite+swap, not by a backfill mutation.
- Every new operator script follows `scripts/benchmark-import.ts`'s pattern: `@/*` path alias imports, a `main()` guarded by `pathToFileURL(process.argv[1] ?? '').href === import.meta.url`, `.catch(err => { console.error(err); process.exit(1) })`, and `CLICKHOUSE_*` env vars must be present in the shell (no dotenv auto-load).
- Task 4 (legacy cleanup) may only run after Task 3 (supervised cutover) is verified successful — it deletes the fallback mechanisms this design's own correctness currently depends on being superseded.
- Task 5 (dead MV cleanup) has no functional dependency on Tasks 1-4's dedup work, but it edits the same file as Task 1 (`lib/clickhouse-migrations.ts`'s version-comment block and `DDL_VERSION` constant). Run Task 5 immediately after Task 1 completes and is committed — not concurrently with it, and not before it — so the two new migration versions (21, 22) land in a single, unambiguous sequence with no merge conflict. Tasks 2-4 may still happen in any order relative to Task 5 otherwise.

## Amendments from the live cutover (2026-09-29 / 2026-09-30)

Task 3's attempts against the real 2.78B-row table surfaced problems that were invisible from the code alone. Every item below was confirmed against the live container, and each changes what Tasks 3-4 expect. The plan text below is otherwise unchanged; where an amendment overrides a step, the step carries a pointer back here.

1. **Stats / verify queries** (`830c7b3`, `44fe3c7`). The 200-bucket loops cost ~107 s per bucket because `cityHash64(...) % N = i` is unprunable, so every bucket was a full scan: ~6 h per pass, twice per tick. Replaced by one `GROUP BY content_key_hash` pass (101 s, 11.4 GiB peak, identical result: total 2,778,102,283, distinct 1,393,449,551); timeout raised to 900 s.
2. **Populate** (`7748ef9`). The `ORDER BY … LIMIT 1 BY` sort hit MEMORY_LIMIT_EXCEEDED even unbucketed, and 200 buckets projected to ~28 h. Replaced by `argMin` + `GROUP BY` over 16 buckets at `max_threads = 6`.
3. **Disk guard projection** (`c005ba0`). It extrapolated free-space delta, which mixes real growth with ~30 GiB/bucket of non-compounding transient overhead, so it over-projected regardless of headroom. It now projects from the target table's own `bytes_on_disk`.
4. **Cleanup pulled forward.** Task 5's dead-table drops and `credential_dedup_meta` (124 GiB) were applied by hand on 2026-09-29 to free cutover headroom, and codified in migration v22 (`28f58e4`). Task 4's "drop the legacy table" step (Step 7) is therefore already done.
5. **Deferred projections.** Projections are 64% of `ulp.credentials`' 381 GiB (`proj_imported_desc` 157.55 GiB, `proj_domain_reversed` 85.21 GiB, column data 82.33 GiB, skip indexes 56.10 GiB). Building the deduped copy with them cost ~18 GiB per populate bucket (~288 GiB) against ~252 GiB of usable headroom, so the guard tripped on every attempt. The clone is now created **without** projections (measured on a real bucket: 7.10 GiB, ~114 GiB total) and `proj_imported_desc` is restored on the live table after the swap and catch-up, newest partition first, within `lib/projection-scope.ts`'s recency window, behind the disk guard (`lib/credentials-projections.ts`). Measured on a 1/16 sample: ADD PROJECTION 0.2 s, MATERIALIZE ~5 min, planner selects it (`force_optimize_projection = 1`). A failed restore never drops the live table and never flips the result to `applied: false`; `scripts/run-content-dedup-once.ts --restore-projections` retries it.
6. **`proj_domain_reversed` is retired, not restored.** No migration defines it (v19 replaced the `reverse(domain)` projection with `idx_ngram_domain`, so a fresh install never has it — only this instance does, from an abandoned 2026-08-25 experiment), and it is counterproductive: the domain monitor's `SELECT DISTINCT email_domain … LIMIT 1001` (`max_execution_time = 90`) makes the planner pick it as a thin covering copy and scan all 2.78B rows — 41 s / 21.12 GiB (75 s in the app's own runs) — where the base table's ngram skip index prunes to 404M rows: 7 s / 3.39 GiB with an identical result set (same count and value hash). **Task 3 Step 5's projection check therefore expects 1, not 2.** To bring it back: `ADD PROJECTION proj_domain_reversed (SELECT url, email, password, domain, email_domain, imported_at ORDER BY reverse(domain))`, then `MATERIALIZE PROJECTION`.
7. **Catch-up rewrite.** `buildCatchupInsertSql`'s `NOT IN (SELECT cityHash64(…) FROM ulp.credentials)` builds an in-memory hash set of every distinct key. At 1.39B keys it failed live with MEMORY_LIMIT_EXCEEDED ("would use 28.73 GiB", limit 18 GiB) — and it runs *after* the swap, so it would have failed at the end of a ~2 h cutover. It now probes the live table with the (tiny) set of candidate keys: 77 s / 628 MiB on the same probe, inserting identical rows to the old form on tables built from the real schema.
8. **The deployed app image predates all of the above** (built 2026-09-28): its report-only cron still ran the 200-bucket stats loop and hit the old 300 s timeout. Step 6's rebuild is what ships the fixes.

---

### Task 1: `was_duplicated` column + populate/catch-up SQL

**Files:**
- Modify: `lib/clickhouse-migrations.ts:171` (header comment + `DDL_VERSION`), and add a new `if (lastDdl < 21)` block before the final `if (lastDdl < DDL_VERSION)` check (currently ends around line 863)
- Modify: `lib/content-dedup.ts:316-323` (`buildPopulateDedupedTableSqlForBucket`)
- Modify: `lib/content-dedup.ts:384-392` (`buildCatchupInsertSql`)
- Test: `__tests__/content-dedup.test.ts:171-191` and `:281-297`

**Interfaces:**
- Consumes: `CONTENT_KEY` (`lib/content-dedup.ts:146`, unchanged), `AUTO_DEDUP_TABLE`, `AUTO_PREDUP_TABLE`, `CONTENT_DEDUP_SURVIVOR_ORDER`, `CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES`, `CONTENT_DEDUP_MAX_THREADS` — all unchanged, already exported.
- Produces: `buildPopulateDedupedTableSqlForBucket(bucketIndex, bucketCount): string` and `buildCatchupInsertSql(cutoff): string` — same signatures, new SQL shape. Task 2 and Task 3 depend on these emitting correct `was_duplicated` handling once `runContentDedupTick` (unchanged, calls these internally) runs.

- [ ] **Step 1: Write the failing tests**

Edit `__tests__/content-dedup.test.ts`. Replace the existing `buildPopulateDedupedTableSqlForBucket` describe block (lines 171-191) with:

```ts
  describe('buildPopulateDedupedTableSqlForBucket', () => {
    test('inserts a deduped copy of one bucket, keeping the earliest imported_at per content key, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(5, 32)
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain(`SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0)) AS was_duplicated) FROM ulp.credentials`)
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

    test('was_duplicated is cumulative: greatest() preserves an already-true flag from a prior cycle even when this cycle sees no new duplicate for that group', () => {
      const sql = buildPopulateDedupedTableSqlForBucket(5, 32)
      expect(sql).toContain('greatest(was_duplicated,')
    })
  })
```

Replace the existing `buildCatchupInsertSql` describe block (lines 281-297) with:

```ts
  describe('buildCatchupInsertSql', () => {
    test('copies rows imported after cutoff, excluding content keys already present, deduplicated against itself, with disk-spill, bounded threads, and a raised timeout', () => {
      const sql = buildCatchupInsertSql('2026-07-07 15:07:51')
      expect(sql).toContain('INSERT INTO ulp.credentials')
      expect(sql).toContain(`SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0)) AS was_duplicated) FROM ${AUTO_PREDUP_TABLE}`)
      expect(sql).toContain("WHERE imported_at > '2026-07-07 15:07:51'")
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) NOT IN (SELECT cityHash64(${CONTENT_KEY}) FROM ulp.credentials)`)
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
      expect(sql).toContain(`max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}`)
      expect(sql).toContain(`max_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain(`max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}`)
      expect(sql).toContain('max_execution_time = 1800')
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
      expect(sql).not.toContain('max_block_size')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/content-dedup.test.ts`
Expected: FAIL — the two new/changed assertions expecting the `SELECT * REPLACE (...)` fragment don't match the current `SELECT * FROM ulp.credentials` / `... FROM ${AUTO_PREDUP_TABLE}` output.

- [ ] **Step 3: Write the implementation**

In `lib/content-dedup.ts`, replace `buildPopulateDedupedTableSqlForBucket` (lines 316-323):

```ts
export function buildPopulateDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `INSERT INTO ${AUTO_DEDUP_TABLE}
  SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0)) AS was_duplicated) FROM ulp.credentials
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}
```

Add a comment above it explaining the flag (insert immediately before the existing `/** Builds AUTO_DEDUP_TABLE's share...` doc comment's closing `*/`, as a new paragraph):

```
 *
 * was_duplicated (UInt8 DEFAULT 0, added in migration v21): true if this
 * content key ever had more than one row, this cycle or any prior one.
 * greatest(was_duplicated, ...) makes it cumulative and cycle-agnostic --
 * once true, always true, even on a later cycle where this group sees no
 * new duplicate. Deliberately a boolean, not a count: file-level
 * repackaging in this dataset means a precise "seen N times" number would
 * mostly measure redistribution churn, not genuine independent sightings --
 * see docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
 */
```

Replace `buildCatchupInsertSql` (lines 384-392):

```ts
export function buildCatchupInsertSql(cutoff: string): string {
  return `INSERT INTO ulp.credentials
  SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0)) AS was_duplicated) FROM ${AUTO_PREDUP_TABLE}
  WHERE imported_at > '${cutoff}'
    AND cityHash64(${CONTENT_KEY}) NOT IN (SELECT cityHash64(${CONTENT_KEY}) FROM ulp.credentials)
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}
```

In `lib/clickhouse-migrations.ts`, insert this new comment paragraph immediately after the existing `// v20: credential_dedup_meta...` comment block and immediately before `const DDL_VERSION = 20` (line 171), so version order in the comments matches version order in code:

```
// v21: was_duplicated flag on ulp.credentials. Boolean, not a count:
//      file-level repackaging in this dataset (the same underlying
//      collection gets rechunked and re-released under new filenames)
//      means any precise "seen N times" number would mostly measure
//      redistribution churn, not genuine independent sightings --
//      confirmed empirically, see
//      docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
//      Plain DEFAULT column, not MATERIALIZED -- no MATERIALIZE backfill
//      needed: this column's real values get written by content-dedup's
//      own rewrite+swap populate step, not by a mutation over existing
//      parts.
```

Change line 171 from `const DDL_VERSION = 20` to `const DDL_VERSION = 21`.

Insert a new block immediately after the existing `if (lastDdl < 20) { ... }` block (which ends with `console.warn('[ClickHouse migration] DDL v20 applied ...')` followed by its closing `}`), and before the `if (lastDdl < DDL_VERSION) { setSetting(...) }` tail:

```ts
  // v21 — was_duplicated flag (see DDL_VERSION comment above).
  if (lastDdl < 21) {
    await runMigration(`ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS was_duplicated UInt8 DEFAULT 0`)
    console.warn('[ClickHouse migration] DDL v21 applied (added was_duplicated column)')
  }
```

- [ ] **Step 4: Run tests to verify they pass, and typecheck**

Run: `npx vitest run __tests__/content-dedup.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Live spot-check against the real container**

Confirm the window-function query shape doesn't regress the hard-won memory/time budget on a realistic slice of the real table (read-only — no INSERT, nothing is written):

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM (
  SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) > 1, 1, 0)) AS was_duplicated)
  FROM ulp.credentials
  WHERE cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) % 32 = 0
  ORDER BY url, email, password, imported_at
  LIMIT 1 BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password
)
SETTINGS max_bytes_before_external_sort = 4294967296, max_threads = 2, max_execution_time = 1800, timeout_overflow_mode = 'throw'
" 2>&1
```

Expected: a single count (roughly 1/32 of the table's distinct content-key count), completing well under the 1800s timeout with no `MEMORY_LIMIT_EXCEEDED`. This has already been verified correct on a small disposable table during design (`ulp.test_wd_src`, cleaned up) — this step is specifically about scale, not correctness. If it fails on memory, the existing `CONTENT_DEDUP_MAX_THREADS`/bucket-count knobs are the first things to revisit (this is expected to work: a window function over the same `PARTITION BY` keys `LIMIT 1 BY` already sorts by is not new grouping cost, just a second read of the same sorted state).

- [ ] **Step 6: Deploy the migration**

```bash
cd ~/ulp-suite
git pull && docker compose up -d --build app
docker compose logs app | grep "ClickHouse migration"
```

Expected: `DDL v21 applied (added was_duplicated column)` appears in the logs.

- [ ] **Step 7: Commit**

```bash
git add lib/content-dedup.ts lib/clickhouse-migrations.ts __tests__/content-dedup.test.ts
git commit -m "$(cat <<'EOF'
feat(dedup): add was_duplicated flag to content-dedup's populate/catch-up

Boolean, not a count -- file-level repackaging in this dataset means any
precise duplicate count would mostly measure redistribution churn, not
genuine independent sightings.
EOF
)"
```

---

### Task 2: Manual one-off trigger script

**Files:**
- Create: `scripts/run-content-dedup-once.ts`

**Interfaces:**
- Consumes: `runContentDedupTick(opts: { trigger?: string }): Promise<DedupTickResult>` from `lib/content-dedup.ts:497` (unchanged signature), `getClient()` from `lib/clickhouse.ts`.
- Produces: a CLI entry point Task 3 invokes. **Discovered during Task 2 execution:** ClickHouse's port isn't exposed to the host and this script isn't in the production app image, so it must run from a throwaway container on the `ulpsuite_network` Docker network (see the script's own header comment for the exact command), not as a bare `npx tsx` from the host.

- [ ] **Step 1: Write the script**

```ts
/**
 * One-time supervised invocation of content-dedup's guarded, bucketed
 * rewrite+swap -- the same runContentDedupTick() the daily cron
 * (lib/dedup-cron.ts) calls on a schedule, just triggered once by hand.
 * Use this for the first-ever apply run so a human is watching, before
 * arming CONTENT_DEDUP_APPLY for the unattended cron. See
 * docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
 *
 * ClickHouse's port is deliberately NOT exposed to the host (see
 * docker-compose.yml's clickhouse service comment), and this script isn't
 * copied into the production app image (Next.js standalone output only) --
 * so this can't run as a bare `npx tsx` from the host or via `docker exec`
 * into ulpsuite_app the way scripts/benchmark-import.ts can. Run it from a
 * throwaway container attached to the same Docker network instead, with
 * the real project directory mounted in and CLICKHOUSE_HOST overridden to
 * the internal URL (matches docker-compose.yml's app service exactly --
 * .env's own CLICKHOUSE_HOST is just the bare hostname, no scheme/port):
 *
 *   docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
 *     --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" \
 *     node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts
 *
 *   # add -e CONTENT_DEDUP_APPLY=true to the same command to apply for real
 */
import { pathToFileURL } from 'node:url'
import { getClient } from '@/lib/clickhouse'
import { runContentDedupTick } from '@/lib/content-dedup'

async function main(): Promise<void> {
  const result = await runContentDedupTick({ trigger: 'manual' })
  console.log('[run-content-dedup-once] result:', result)
  await getClient().close()
  if (!result.applied && process.env.CONTENT_DEDUP_APPLY) {
    console.error(
      '[run-content-dedup-once] CONTENT_DEDUP_APPLY was set but applied=false -- ' +
      'check the [content-dedup] log lines above for why (excess below DEDUP_MIN_EXCESS, or verification failed).',
    )
    process.exit(1)
  }
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1) })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Dry-run against the real container**

```bash
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
  --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" \
  node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts
```

Expected: exits 0, logs `[content-dedup] manual: total=<N> excess=<M> willApply=false (report-only — set CONTENT_DEDUP_APPLY=true to enable cleanup)` followed by `[run-content-dedup-once] result: { total: <N>, excess: <M>, applied: false }`. This is a sequential 200-bucket stats scan against a 2.4B-row table (`CONTENT_DEDUP_BUCKET_COUNT=200` in `.env`) — expect several minutes to complete, not seconds. Run in the background rather than blocking on it.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-content-dedup-once.ts
git commit -m "feat(dedup): add scripts/run-content-dedup-once.ts manual trigger"
```

---

### Task 3: Supervised cutover

This task is a live, watched operational procedure against the real 2.4B-row table, not a code change. **Do not proceed past Step 3 without explicit user confirmation of the numbers shown in Step 2** — this is the first time this mechanism will ever actually delete rows from production data.

**Files:** none (operational only).

**Interfaces:**
- Consumes: `scripts/run-content-dedup-once.ts` (Task 2), `CONTENT_DEDUP_APPLY` env var (`lib/content-dedup.ts:431`).
- Produces: a live table state that Task 4 depends on (verified deduped `ulp.credentials`, with `ulp.credentials_predup_auto` as rollback archive).

- [ ] **Step 1: Dry-run and capture the numbers**

```bash
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
  --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" \
  node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts 2>&1 | tee /tmp/dedup-dryrun.log
```

A sequential 200-bucket scan against 2.4B rows — run in the background, not blocking, and expect several minutes. Extract `total` and `excess` from the result line once it completes.

- [ ] **Step 2: Sanity gates**

Hard gate: `excess / total` must be **≥ 49.84%** (the `credential_dedup_meta` figure confirmed 2026-09-26 — content-dedup's key is a superset, so its number should be equal or higher). If below, STOP — do not proceed to Step 3. Investigate why content-dedup finds fewer duplicates than the narrower legacy mechanism did; something is wrong.

Judgment check (not a bright-line threshold): re-run the domain-variance query from the design spec's Current State section against the live table and compare to the 0.0022% baseline measured there:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT
  count() AS dup_groups,
  countIf(distinct_domain > 1) AS groups_multi_domain,
  round(100.0 * countIf(distinct_domain > 1) / count(), 4) AS pct_groups_multi_domain
FROM (
  SELECT content_key_hash, count() AS cnt, uniqExact(domain) AS distinct_domain
  FROM ulp.credentials
  WHERE content_key_hash % 100 = 0
  GROUP BY content_key_hash
  HAVING cnt > 1
)
SETTINGS max_execution_time = 250
FORMAT PrettyCompact
"
```

Expected: `pct_groups_multi_domain` near 0.0022%. A materially higher number is worth investigating before proceeding, but use judgment — this isn't an automated abort condition.

- [ ] **Step 3: STOP — present both numbers to the user and get explicit confirmation before proceeding**

Show: total row count, excess count, excess percentage, and the domain-variance check result. Do not run Step 4 until the user explicitly confirms.

- [ ] **Step 4: Apply for real**

```bash
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
  --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" -e CONTENT_DEDUP_APPLY=true \
  node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts 2>&1 | tee /tmp/dedup-apply.log
```

Expected: `applied: true` in the result line. This is the real, watched, first-ever destructive run.

- [ ] **Step 5: Verify**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT
  (SELECT count() FROM ulp.credentials) AS new_row_count,
  (SELECT count() FROM ulp.credentials_predup_auto) AS archived_original_count,
  (SELECT count() FROM ulp.credentials WHERE was_duplicated = 1) AS flagged_as_duplicated
FORMAT PrettyCompact
"
```

Expected: `new_row_count` roughly matches `total - excess` from Step 1/4's result; `archived_original_count` roughly matches the pre-apply `total`; `flagged_as_duplicated` is nonzero and plausible relative to `excess`.

Confirm the query-speed projection was restored after the swap (amended — see "Amendments" #5/#6 at the top: the clone is built without projections and `proj_imported_desc` is re-created afterwards; `proj_domain_reversed` is intentionally retired):

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials FORMAT TabSeparatedRaw" | grep -c "PROJECTION proj_"
```

Expected: `1` (`proj_imported_desc`). Also confirm it is materialized for every partition inside the recency window (`system.projection_parts`), and that the result line reported `projectionsRestored: true`. If it reported `false`, `ulp.credentials` is still live and correct — re-run `scripts/run-content-dedup-once.ts --restore-projections`.

Spot-check the app itself: open the Credentials Browser, confirm results look sane and row counts in the UI match the new total.

- [ ] **Step 6: Arm the cron**

Add or update `CONTENT_DEDUP_APPLY=true` in `.env`, then:

```bash
docker compose up -d --build app
docker compose logs app | grep "content-dedup] cron started"
```

Expected: log line confirming the cron is armed with the next tick time. (This rebuild is also what ships the stats/populate/guard/catch-up fixes to the running app — see "Amendments" #8.)

---

### Task 4: Legacy cleanup

**Only run after Task 3's Step 5 verification passes.**

**Files:**
- Delete: `app/api/admin/dedup/route.ts`
- Delete: `scripts/dedup-credentials-content.sh`
- Delete: `scripts/backfill-credential-dedup.sh`
- Modify: `README.md` (lines ~146-150, ~221-222, ~276-280 — exact current text below)
- Modify: `lib/ulp-parser.ts:776`, `:786`, `:921`, `:940`
- Modify: `__tests__/pagination-import-docs.test.ts:17`
- Modify: `__tests__/ulp-parser-stream.test.ts:20-24`
- Modify: `docs/superpowers/specs/2026-09-28-clickhouse-disk-headroom-guard-design.md:4`
- Modify: `docs/superpowers/plans/2026-09-28-clickhouse-disk-headroom-guard.md` (17 checkboxes)
- SQL: `DROP TABLE ulp.credential_dedup_meta`

**Interfaces:** none — this task only removes code and repoints strings; nothing downstream depends on its outputs.

- [ ] **Step 1: Delete the orphaned admin route**

```bash
git rm app/api/admin/dedup/route.ts
```

- [ ] **Step 2: Delete the two superseded scripts**

```bash
git rm scripts/dedup-credentials-content.sh scripts/backfill-credential-dedup.sh
```

- [ ] **Step 3: Update README.md**

In the "Large files" paragraph, replace:

```
**Large files:** Files with >2M unique credentials disable in-file dedup once the cap is hit. The old post-file full-table dedup step is removed; scheduled or manual dedup remains available.
For manual content dedup, use the verified script:
```bash
bash scripts/dedup-credentials-content.sh
APPLY=1 bash scripts/dedup-credentials-content.sh
```
```

with:

```
**Large files:** Files with >2M unique credentials disable in-file dedup once the cap is hit. The old post-file full-table dedup step is removed; scheduled or manual dedup remains available.
For manual content dedup, use the one-off trigger script (report-only by default):
```bash
npx tsx scripts/run-content-dedup-once.ts
CONTENT_DEDUP_APPLY=true npx tsx scripts/run-content-dedup-once.ts
```
```

In the "Useful Commands" section, replace:

```
# Run manual content dedup (dry-run by default)
bash scripts/dedup-credentials-content.sh
```

with:

```
# Run manual content dedup (dry-run by default)
npx tsx scripts/run-content-dedup-once.ts
```

In the "Content deduplication (storage)" section, replace:

```
The old post-file full-table dedup pass is removed; scheduled or manual dedup remains available.

```bash
# one-time (dry-run, then apply)
bash scripts/dedup-credentials-content.sh
APPLY=1 bash scripts/dedup-credentials-content.sh
```
```

with:

```
The old post-file full-table dedup pass is removed; scheduled or manual dedup remains available.

```bash
# one-time (dry-run, then apply)
npx tsx scripts/run-content-dedup-once.ts
CONTENT_DEDUP_APPLY=true npx tsx scripts/run-content-dedup-once.ts
```
```

- [ ] **Step 4: Update lib/ulp-parser.ts's guidance strings**

At line 776, change:
```
  // with: bash scripts/dedup-credentials-content.sh
```
to:
```
  // with: npx tsx scripts/run-content-dedup-once.ts
```

At line 786, change:
```
          'Remaining rows skip in-file dedup — run bash scripts/dedup-credentials-content.sh after import.')
```
to:
```
          'Remaining rows skip in-file dedup — run npx tsx scripts/run-content-dedup-once.ts after import.')
```

At line 921, change:
```
  // bash scripts/dedup-credentials-content.sh afterwards to remove duplicates.
```
to:
```
  // npx tsx scripts/run-content-dedup-once.ts afterwards to remove duplicates.
```

At line 940, change:
```
          'Remaining rows skip in-file dedup — run bash scripts/dedup-credentials-content.sh after import.')
```
to:
```
          'Remaining rows skip in-file dedup — run npx tsx scripts/run-content-dedup-once.ts after import.')
```

- [ ] **Step 5: Update the two pinning tests**

In `__tests__/pagination-import-docs.test.ts`, change line 17 from:
```ts
    expect(readme).toContain('bash scripts/dedup-credentials-content.sh')
```
to:
```ts
    expect(readme).toContain('npx tsx scripts/run-content-dedup-once.ts')
    expect(readme).not.toContain('bash scripts/dedup-credentials-content.sh')
```

In `__tests__/ulp-parser-stream.test.ts`, change lines 20-24 from:
```ts
test('dedup-cap guidance names the content-key script, not the removed admin endpoint', () => {
  const source = readFileSync(new URL('../lib/ulp-parser.ts', import.meta.url), 'utf8')
  expect(source).toContain('bash scripts/dedup-credentials-content.sh')
  expect(source).not.toContain('POST /api/admin/dedup')
})
```
to:
```ts
test('dedup-cap guidance names the one-off trigger script, not the removed admin endpoint or the removed manual script', () => {
  const source = readFileSync(new URL('../lib/ulp-parser.ts', import.meta.url), 'utf8')
  expect(source).toContain('npx tsx scripts/run-content-dedup-once.ts')
  expect(source).not.toContain('POST /api/admin/dedup')
  expect(source).not.toContain('bash scripts/dedup-credentials-content.sh')
})
```

- [ ] **Step 6: Run the full test suite and typecheck**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: PASS. (This also confirms no other test file references the deleted route/scripts — if one does, fix it the same way as Step 5 before proceeding.)

- [ ] **Step 7: Drop the legacy table**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.credential_dedup_meta"
```

- [ ] **Step 8: Fix doc bookkeeping**

In `docs/superpowers/specs/2026-09-28-clickhouse-disk-headroom-guard-design.md`, change line 4 from:
```
**Status:** Approved, not yet implemented (spec → plan → build)
```
to:
```
**Status:** Implemented (merged 2026-09-28, commits 85ad9f7/d41dd49/7ebacae)
```

Check off all 17 boxes in the plan:
```bash
sed -i 's/^- \[ \] \*\*Step/- [x] **Step/' docs/superpowers/plans/2026-09-28-clickhouse-disk-headroom-guard.md
```

Verify:
```bash
grep -c '^- \[x\] \*\*Step' docs/superpowers/plans/2026-09-28-clickhouse-disk-headroom-guard.md
```
Expected: `17`.

- [ ] **Step 9: Commit**

```bash
git add -A
git status --short
```

Review the output — expect deletions of the two scripts and the admin route, modifications to README.md, lib/ulp-parser.ts, the two test files, and the two disk-headroom-guard doc files. No other files should appear.

```bash
git commit -m "$(cat <<'EOF'
refactor(dedup): retire credential_dedup_meta, admin OPTIMIZE route, and
the unguarded manual dedup script

All three are superseded by content-dedup.ts's guarded, bucketed
rewrite-swap, now verified against production. Repoints README and
parser guidance at scripts/run-content-dedup-once.ts.
EOF
)"
```

---

### Task 5: Dead materialized-view cleanup

**No functional relationship to the dedup cutover** — this exists because it shares this effort's disk-reclaim motivation and was folded in by explicit decision. **Run this immediately after Task 1 is complete and committed** (see Global Constraints — both edit the same version-comment block and `DDL_VERSION` constant in `lib/clickhouse-migrations.ts`).

**Files:**
- Modify: `lib/clickhouse-migrations.ts` (header comment + `DDL_VERSION`, new `if (lastDdl < 22)` block)

**Interfaces:** none.

- [ ] **Step 1: Write the implementation**

In `lib/clickhouse-migrations.ts`, insert this comment paragraph immediately before the `const DDL_VERSION = 21` line Task 1 left in place:

```
// v22: retry the v10/v11 drops again. v11 claimed success (ch_ddl_version
//      reached 20 on production) but domain_counts/password_counts/
//      url_host_counts/reuse_pairs and their 4 MVs were still live and
//      healthy as of 2026-09-28 (no broken/detached parts -- ruling out a
//      repeat of the v10 incident). Unlike v10/v11, this does NOT use the
//      shared runMigration() helper, which silently swallows any
//      non-"already exists" error as a truncated warning -- that exact
//      pattern is how v11's failure went unnoticed. See
//      docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
```

Change `const DDL_VERSION = 21` to `const DDL_VERSION = 22`.

Insert a new block immediately after the `if (lastDdl < 21) { ... }` block from Task 1, before the `if (lastDdl < DDL_VERSION) { setSetting(...) }` tail:

```ts
  // v22 — retry the v10/v11 drops again (see DDL_VERSION comment above).
  if (lastDdl < 22) {
    const v22DropStatements = [
      'DROP VIEW IF EXISTS ulp.mv_domain_counts',
      'DROP VIEW IF EXISTS ulp.mv_password_counts',
      'DROP VIEW IF EXISTS ulp.mv_url_host_counts',
      'DROP VIEW IF EXISTS ulp.mv_reuse_pairs',
      'DROP TABLE IF EXISTS ulp.domain_counts',
      'DROP TABLE IF EXISTS ulp.password_counts',
      'DROP TABLE IF EXISTS ulp.url_host_counts',
      'DROP TABLE IF EXISTS ulp.reuse_pairs',
    ]
    for (const sql of v22DropStatements) {
      try {
        await client.exec({ query: sql })
        console.warn(`[ClickHouse migration] v22: ${sql} -- OK`)
      } catch (err) {
        console.error(`[ClickHouse migration] v22: ${sql} -- FAILED:`, err instanceof Error ? err.message : String(err))
      }
    }
    console.warn('[ClickHouse migration] DDL v22 applied (retried dropping dead stats/reuse MV tables + views)')
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Deploy and verify**

```bash
cd ~/ulp-suite
git pull && docker compose up -d --build app
docker compose logs app | grep "ClickHouse migration] v22"
```

Expected: 8 `-- OK` lines (or, if any genuinely fail this time, 8 `-- FAILED:` lines with a real error message — visible now, unlike v11).

Confirm the objects are actually gone:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT name FROM system.tables WHERE database='ulp' AND name IN ('domain_counts','password_counts','url_host_counts','reuse_pairs','mv_domain_counts','mv_password_counts','mv_url_host_counts','mv_reuse_pairs')
"
```

Expected: empty result. If any rows remain, investigate the corresponding `FAILED` log line before considering this task done.

- [ ] **Step 4: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "$(cat <<'EOF'
fix(migrations): finish retiring the dead stats/reuse MV tables

v11 claimed success but domain_counts/password_counts/url_host_counts/
reuse_pairs and their 4 MVs were still live in production. This retry
surfaces any failure loudly instead of silently swallowing it the way
the shared runMigration() helper did.
EOF
)"
```

---

## Self-Review

**Spec coverage:** Objective (consolidation + cutover) → Tasks 1-4. `was_duplicated` requirement → Task 1. Legacy retirement (3 mechanisms) → Task 4. Dead MV cleanup → Task 5. Doc bookkeeping → Task 4 Step 8. Verification gates (excess %, domain variance, projections) → Task 3 Steps 2/5. All spec sections have a corresponding task.

**Placeholder scan:** No TBD/TODO markers; every step has literal code, exact commands, or exact file text to replace.

**Type consistency:** `runContentDedupTick(opts: { trigger?: string }): Promise<DedupTickResult>` used identically in Task 2's script and Task 3's operational steps. `DedupTickResult { total, excess, applied }` referenced consistently. `was_duplicated` column name and the `greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0))` expression are identical, character-for-character, in Task 1's populate SQL, catch-up SQL, and both new tests.
