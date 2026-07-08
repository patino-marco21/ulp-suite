# Content-Dedup: Bucket the Populate Insert Against Real Scale

## Problem

The rewrite+swap mechanism (`docs/superpowers/specs/2026-07-07-content-dedup-rewrite-swap-design.md`)
was proven correct — via code review and a disposable-clone test that
specifically exercised its catch-up logic — but its first live attempts
against the real `ulp.credentials` table (467M rows) surfaced a scale
problem the 3M-row disposable clone was too small to catch.

Across six live attempts, three settings-based fixes were applied to the
populate `INSERT ... SELECT ... ORDER BY ... LIMIT 1 BY` query, each
confirmed live: disk-spill sort (`max_bytes_before_external_sort`), thread
limiting (`max_threads`/`max_insert_threads = 2`), and a capped
`max_block_size`. The first two each roughly doubled how many output rows
got written before the query hit `MEMORY_LIMIT_EXCEEDED` (10.6M → 32M → 64M
of ~356M expected). The third had **no measurable effect** — both the
pre- and post-fix attempts failed at nearly identical row counts (64.28M vs
64.41M) and elapsed wall-clock time (~5-6 minutes), despite operating on a
genuinely different lever (block size, not thread count or sort memory).

That non-result is the actual signal. Research confirmed the mechanism:
smaller insert blocks create more physical parts, and those parts compete
with the still-running insert for the same memory via background merges —
a documented ClickHouse tradeoff, not a bug. The failure point tracks
elapsed time and accumulated background-merge pressure within one
continuously-growing `INSERT`, not the total row count processed — which is
why block size (a per-block lever) didn't move the needle, and why a further
memory-settings tweak is unlikely to either. `ulp.credentials` itself was
independently confirmed untouched (466,889,579 rows) after every one of the
six attempts — only the temporary build-side table was ever affected.

## Root Cause

A single `INSERT ... SELECT` against a 467M-row source, producing an
estimated ~356M output rows, runs for a genuinely long time (tens of minutes
at minimum, based on the ~5-6 minutes needed just to reach ~64M rows).
Throughout that entire window, the destination table accumulates new parts
continuously, and ClickHouse's background merge process works to consolidate
them — competing for the same bounded memory the whole time. There is no
natural break in a single unbroken statement for that pressure to release;
it only accumulates until something gives. Reducing per-block memory (block
size) doesn't change this, because it doesn't reduce the *total* amount of
part-creation and merge activity that piles up over the statement's full
duration — it just trades a different tradeoff (more, smaller parts instead
of fewer, larger ones), landing at roughly the same net pressure.

`SYSTEM STOP MERGES` (pausing background merges for the duration) was
considered and rejected: with an estimated ~356M output rows and this
table's single-partition layout, even a generously large block size would
accumulate thousands of unmerged parts before the insert finishes — likely
trading `MEMORY_LIMIT_EXCEEDED` for ClickHouse's separate "too many parts"
throttling (documented to activate around ~300 active parts per partition),
not actually resolving anything.

## Architecture

**Bucket the populate step by content-key hash**, reusing the exact
correctness guarantee from the original (now-removed) bucketed-DELETE
design: `cityHash64(CONTENT_KEY) % bucketCount = bucketIndex` guarantees
every row of a given content-duplicate group hashes to the same bucket, so
`ORDER BY ... LIMIT 1 BY` run independently within each bucket produces
exactly the same survivor as running it unchunked over the whole table — the
union of all buckets' outputs is identical to one unchunked pass. This is
not a resurrection of the bucketed-*DELETE* design (which failed for an
unrelated, structural reason: mutations rewrite every physical part
regardless of bucket count) — it buckets the *insert* side of rewrite+swap,
where the constraint is different: bounding how much part-creation and
merge pressure accumulates within any single statement, not working around
mutation part-rewrite cost.

Running 32 buckets sequentially, each producing roughly 1/32 of the total
output (~11M rows), gives background merges a real gap to settle between
each bucket's `INSERT` rather than accumulating pressure across one
multi-hour operation. Each bucket's own `INSERT` is short enough that its
own part accumulation should resolve well before the "too many parts"
threshold, and by the time the next bucket starts, merges have had real
wall-clock time to consolidate the previous bucket's parts.

**Bucket count: 32**, via a new `contentDedupBucketCount(env)` function —
reintroducing the exact name and convention the original bucketed-DELETE
design used (`CONTENT_DEDUP_BUCKET_COUNT` env var, `parseInt` with a
validated fallback, matching this file's other env knobs), since that
function was removed when this session's earlier rewrite+swap redesign
replaced bucketed mutations, and nothing else currently uses the name.
Default 32 was chosen for comfortable safety margin under the empirical
~64M-row failure point (~11M/bucket, ~5.8x margin) while keeping the total
number of full source-table re-scans modest — every bucket's hash filter is
unprunable, so each bucket costs one full 467M-row scan regardless of bucket
count, and more buckets means proportionally more total scan I/O.

**Block size reconsidered, not carried forward as-is.** The capped
`max_block_size` (16,384) was sized to bound a single 356M-row insert; it
provided no benefit there and, at bucket scale (~11M rows/bucket), risks a
different problem — 11M rows ÷ 16,384 ≈ 671 parts from a single bucket
alone, already close to the ~300-parts-per-partition throttling point.
`CONTENT_DEDUP_MAX_BLOCK_SIZE` is removed; the bucketed populate query
omits a `max_block_size` override entirely (reverting to ClickHouse's
default), since bucketing itself now provides the scale-bounding that block
size was unsuccessfully trying to provide. The exact right value (if any
override turns out to still be needed) should be determined empirically
against a disposable clone sized close to real bucket scale, as part of
implementation — not guessed again.

**Disk-spill sort and thread limiting are retained.** Both
(`max_bytes_before_external_sort`, `max_threads`/`max_insert_threads = 2`)
were confirmed live to provide real, measurable improvement before this
design existed, and nothing about bucketing invalidates their reasoning —
each bucket's own sort still needs disk-spill protection, and thread
limiting still bounds per-bucket MATERIALIZED-column computation
concurrency.

**Catch-up is not bucketed.** Its row count is bounded by how much new data
lands during the (now longer, multi-bucket) populate window, not by the
size of the table being deduplicated — this should stay modest regardless of
how long the full populate takes, since it only reflects the ingest rate
during that window, not the table's total size. It keeps its existing
settings (disk-spill sort, thread limiting) unchanged.

## Interfaces Changed

`lib/content-dedup.ts` removes `buildPopulateDedupedTableSql()` (unchunked)
and `CONTENT_DEDUP_MAX_BLOCK_SIZE` (the block-size override, per the
reasoning above — confirmed via repo-wide grep that nothing outside this
file and its test file references either).

`lib/content-dedup.ts` adds:

- `contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number` —
  reads `CONTENT_DEDUP_BUCKET_COUNT`, default `32`, matching this file's
  existing `dedupCronHours`/`minExcessToApply`/`dedupCronHourUtc` convention
  exactly (optional `env` param, `parseInt`, validated fallback).
- `buildPopulateDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string`
  — the same `INSERT INTO AUTO_DEDUP_TABLE SELECT * FROM ulp.credentials
  ORDER BY CONTENT_DEDUP_SURVIVOR_ORDER LIMIT 1 BY CONTENT_KEY` shape, with
  an added `WHERE cityHash64(CONTENT_KEY) % bucketCount = bucketIndex`
  filter, keeping the existing `max_bytes_before_external_sort`,
  `max_threads`, `max_insert_threads`, `max_execution_time`,
  `timeout_overflow_mode` settings and omitting `max_block_size`.

`runContentDedupTick()`'s populate step (currently one `client.exec()` call)
becomes a loop: `for (let bucket = 0; bucket < contentDedupBucketCount();
bucket++) { await client.exec({ query:
buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) }) }`, logging
progress per bucket (matching the visibility precedent established for the
earlier bucketed-DELETE rollout script, though no separate rollout script is
needed here — see Rollout Plan below).

Unchanged: `buildCutoffSql()`, `buildVerifyDedupedTableSql()`,
`buildRenameSwapSql()`, `buildCatchupInsertSql()`, `CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES`,
`CONTENT_DEDUP_MAX_THREADS`, the verification `>=`/`==` comparison logic,
the rollback-retention behavior, `lib/dedup-cron.ts`, all `app/api` routes.

## Rollout Plan

1. Implement the bucketed populate builder and the bucket-loop in
   `runContentDedupTick()`, with unit tests for both.
2. **Disposable-clone verification at a meaningfully larger scale than
   before.** The original rewrite+swap disposable-clone test used 3M
   rows — far too small to have caught any of the six real issues found
   tonight. This round's clone should be large enough to meaningfully
   exercise bucket-to-bucket part accumulation and merge behavior — at
   least 100M source rows, populated the same way prior clones were
   (`INSERT ... SELECT ... LIMIT N FROM ulp.credentials`), with the same
   projection-preserving `SHOW CREATE TABLE` + `sed` clone technique. Verify
   each bucket completes without memory or part-count errors, and that the
   final result matches an unchunked reference computation (bucketing must
   not change the output, only how it's computed).
3. Retry the live rollout against real `ulp.credentials` once disposable-clone
   verification at this larger scale passes cleanly. Continue treating this
   as the same class of live production verification as tonight's attempts:
   confirm pre-state, watch progress, confirm post-state independently.
4. Whether this succeeds, partially succeeds, or surfaces another
   unanticipated issue, report back before taking any further action —
   including before ever enabling `CONTENT_DEDUP_APPLY=true` for ongoing
   scheduled use, which remains a separate, later decision regardless of how
   this rollout goes.

## Testing

1. **Unit tests**: `contentDedupBucketCount()`'s default/override/validation
   behavior (matching this file's existing env-knob test style exactly).
   `buildPopulateDedupedTableSqlForBucket()`'s exact SQL shape — bucket
   filter present and correctly parameterized, existing settings preserved,
   `max_block_size` absent.
2. **Disposable-clone verification**: as described in Rollout Plan step 2 —
   this is the step that most needs to be larger-scale than prior rounds,
   given the lesson that a too-small clone missed all six real issues found
   tonight.
3. **Live rollout verification**: as described in Rollout Plan step 3 — the
   seventh live attempt overall, but the first against this bucketed design.

## Error Handling

Unchanged from the existing design: an unattended tick that finds a stale
`AUTO_DEDUP_TABLE` always drops (`SYNC`) and rebuilds from scratch rather
than resuming, matching the pattern already established for the whole
mechanism. If one bucket's `INSERT` fails partway through the loop, the
buckets already completed remain in `AUTO_DEDUP_TABLE` (each bucket's insert
is its own committed statement), but the tick's outer `try`/`catch` catches
the error, logs it, and returns `{ applied: false }` without proceeding to
verification or the swap — the next tick's stale-table cleanup handles the
partial build the same way it already does today. No new checkpoint or
resume state is introduced.
