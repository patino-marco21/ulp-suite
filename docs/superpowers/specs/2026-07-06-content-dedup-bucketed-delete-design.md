# Content-Dedup: Bucketed Delete + Tie-Break Fix — Design

## Problem

`lib/content-dedup.ts`'s scheduled duplicate cleanup (`CONTENT_DEDUP_APPLY`) has
never actually been enabled in production. Investigating why it was still off
surfaced two real, independent bugs in the DELETE mechanism itself — both
predating this design, not introduced by it.

**Bug A — the DELETE is rejected outright.** `buildDeleteSql()` currently
issues a lightweight `DELETE FROM ulp.credentials WHERE ...`. Confirmed live:
this fails immediately against the real table with
`Code: 344 SUPPORT_IS_DISABLED — DELETE query is not allowed for table
ulp.credentials because it has projections and lightweight_mutation_
projection_mode is set to THROW`. The table's `proj_imported_desc` projection
blocks lightweight deletes by default. This was never caught because the
fix's own verification used a `CREATE TABLE ... AS SELECT` disposable clone,
which does not carry over projections — the exact gap the code's own comment
already flagged ("Do not set CONTENT_DEDUP_APPLY=true until ... confirmed
against ... a real mutation").

**Bug B — tie-breaking is incomplete.** `CONTENT_DUPLICATE_PREDICATE` keeps
the row whose `FULL_HASH` equals the group minimum. If two or more rows in a
content group are byte-for-byte identical across every `FULL_HASH` column,
they share one hash value, all equal the minimum, and all survive — instead
of exactly one. Confirmed live with 3 deliberately-inserted identical rows:
all 3 shared one `cityHash64`, so none were deletable under the current
predicate. Quantified against a 13.2M-row real-data sample: ~3.2% of
duplicate rows survive a "successful" run this way.

## Root Cause

**Bug A's naive fix doesn't work either.** Switching back to heavyweight
`ALTER TABLE ... DELETE` (which handles projections natively — no special
mode needed) does fix the projection rejection, and is fast and clean at
small scale (3M rows: ~3s). But confirmed live, twice, from a clean/idle
memory baseline: at 13.2M rows (2.8% of the real table) it fails with
`MEMORY_LIMIT_EXCEEDED` roughly 25 times in a row — server memory repeatedly
spiking to 13–16 GiB — before eventually succeeding via ClickHouse's
automatic mutation retry. `max_bytes_before_external_group_by` (this table's
existing memory-bounding setting) only bounds the GROUP BY aggregation; it
does nothing for the separate memory cost of rewriting parts containing this
table's ~9 complex `MATERIALIZED` columns, which is what was actually
spiking. At the real scale (467M rows, 110M excess — 35× larger than the
failing test), relying on retry-until-lucky is not an acceptable production
behavior, and repeated near-ceiling memory pressure risks starving
concurrent real imports.

Partition-scoping the mutation (ClickHouse tables are commonly chunked this
way) does not help here: the entire 467M-row table currently lives in one
partition (`202607`), since nearly all data was imported within the same
calendar month.

## Architecture

**Bucketed heavyweight DELETE.** Chunk the mutation by
`cityHash64(url_content_key, email, password) % N` — the same expression
already used to GROUP duplicates, so every row in a content-duplicate group
hashes to the same bucket by construction. No group can ever be split across
two buckets, so chunking cannot affect correctness. Run one heavyweight
`ALTER TABLE ... DELETE ... WHERE bucket_predicate AND tie_broken_predicate`
per bucket, sequentially, each with the existing disk-spill settings.

Confirmed live: chunking the same 13.2M-row sample that failed ~25 times as
one mutation into 16 buckets (~826K rows/bucket) completed **all 16 buckets
with zero memory errors**, and produced byte-identical results to what an
unchunked run would have (same tie-survivor count, projection intact
throughout).

**Tie-break fix.** Extend the hash used for `min()`/`NOT IN` tie-breaking to
include ClickHouse's virtual `_part` and `_part_offset` columns — every
physical row has a unique `(_part, _part_offset)` pair, so two rows can never
hash equal even when every real column is byte-for-byte identical. Confirmed
live: the same 3 deliberately-identical test rows, which previously all
shared one hash, each got a distinct hash after this change, and the fixed
predicate correctly reduced them to exactly 1 survivor.

**Bucket count: 1024** (`CONTENT_DEDUP_BUCKET_COUNT`, env-overridable —
matches this file's existing `DEDUP_*` env-configurability convention). At
the real table's scale this averages ~456K rows/bucket, comfortably under
the ~826K/bucket size already proven reliable, leaving margin since the real
table's total duplicate-group cardinality is larger than the tested sample's.

**Sequential execution, no concurrency.** Buckets run one at a time, matching
the existing `CONTENT_DEDUP_MAX_THREADS=2` philosophy of predictable memory
over throughput. A full 1024-bucket sweep of the current backlog is
expected to take on the order of hours; subsequent daily runs process far
less (only rows imported or newly duplicated since the last run), and should
complete quickly.

## Rollout Plan

This is a first-of-its-kind mutation against 467M rows of real production
data; the implementation gets normal unit + disposable-clone testing like
any other change, but the *first real run* gets an extra, deliberately small
checkpoint before committing to the full sweep:

1. Implement the bucketed SQL builders and the tie-break fix (unit tests +
   disposable-clone verification, matching this session's established
   pattern for ClickHouse-touching changes).
2. Deploy.
3. Manually run only buckets **0–31 of 1024** (~1.8% of the real backlog,
   ~14M of ~467M rows) directly against `ulp.credentials`, sequentially,
   with the exact settings the full run will use. Trigger this via a new
   one-off script, `scripts/content-dedup-bucket-run.sh` — following this
   codebase's existing dry-run/`APPLY=1` convention for direct production
   DB operations (matching `scripts/dedup-credentials-content.sh` and
   `scripts/purge-existing-t3.sh`), accepting a bucket range so it can
   re-run this same checkpoint style for any future manual bucket-range
   need. This keeps `runContentDedupTick()` itself simple: it always
   targets the full configured bucket count once
   `CONTENT_DEDUP_APPLY=true`, with no partial-sweep mode of its own (see
   Error Handling). Verify: no memory errors, reasonable per-bucket
   timing, projection intact, and that the resulting duplicate count
   decreased by the expected amount for those specific buckets.
4. **Stop and report back.** Do not proceed to the remaining 992 buckets
   automatically. Enabling `CONTENT_DEDUP_APPLY=true` (which drives the full,
   all-1024-bucket sweep on every cron tick from then on) is a separate,
   explicit decision after reviewing step 3's results.

## Interfaces Changed

`lib/content-dedup.ts` currently exports `CONTENT_DUPLICATE_PREDICATE` (a
plain string constant), `buildDeleteSql()`, and `buildDeleteExecSql()` (both
bucket-unaware, lightweight-DELETE-based). These become bucket-parameterized
functions:

- `contentDuplicatePredicateForBucket(bucketIndex: number, bucketCount: number): string`
- `buildDeleteSqlForBucket(bucketIndex: number, bucketCount: number): string` — heavyweight `ALTER TABLE ... DELETE`, not lightweight `DELETE FROM`.
- `buildDeleteExecSqlForBucket(bucketIndex: number, bucketCount: number): string` — adds `mutations_sync = 1` (block until this one bucket's mutation completes — simpler sequential control flow than polling `system.mutations`, and each bucket is small enough that this won't hit a client timeout) plus `allow_nondeterministic_mutations = 1` (required for heavyweight mutations whose WHERE references the same table) alongside the existing `max_threads`/`max_bytes_before_external_group_by` settings.
- `FULL_HASH` gains `_part, _part_offset` as trailing hash inputs.
- `contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number` — new env knob, matching the file's existing `dedupCronHours`/`minExcessToApply`/`dedupCronHourUtc` convention exactly (optional `env` param for test injection, `parseInt` with a validated fallback). Reads `CONTENT_DEDUP_BUCKET_COUNT`, defaults to `1024`.
- `runContentDedupTick()`'s apply path changes from "submit one DELETE" to "loop buckets `0..contentDedupBucketCount()-1`, awaiting each in turn."
- `buildStatsSql()` (the report-only stats query) is unaffected — it doesn't delete anything, so it isn't subject to the projection restriction and needs no bucketing.

No changes to `dedup-cron.ts`'s scheduling logic, `app/api` routes, or any
other file — this is contained to `lib/content-dedup.ts`, its test file, and
the new one-off rollout script (`scripts/content-dedup-bucket-run.sh`, see
Rollout Plan step 3).

## Testing

1. **Unit tests**: the new bucket-parameterized SQL builders produce the
   expected `WHERE` clause shape (bucket predicate present, tie-break hash
   includes `_part`/`_part_offset`, correct settings string) — matching this
   file's existing test style (`buildDeleteSql`'s shape is already tested
   this way).
2. **Disposable-clone verification** (required before deploying, matching
   this session's established practice for ClickHouse-touching changes):
   recreate the projection-including clone technique used during this
   design's investigation, confirm the bucketed delete completes without
   memory errors at a representative sample size, and confirm the tie-break
   fix reduces deliberately-inserted identical rows to exactly one survivor.
3. **Live rollout verification**: the Rollout Plan above (buckets 0–31
   against real data) IS the live verification step for this change — there
   is no separate synthetic-data live test beyond it, since the disposable
   clone testing already covers mechanism correctness and the real rollout
   specifically needs to observe real-scale timing and memory behavior.

## Error Handling

No new error paths beyond what heavyweight mutations already have. Each
bucket's `mutations_sync = 1` call surfaces a failure synchronously (the
existing `runContentDedupTick` catch-and-log pattern in `dedup-cron.ts`
applies unchanged). If a bucket fails partway through the full sweep, the
buckets before it are already durably applied (each is its own committed
mutation) and the loop stops — a future tick naturally re-attempts every
bucket, including already-clean ones, which is idempotent (an
already-deduplicated bucket's DELETE simply matches zero rows) though not
free (it still evaluates the bucket's GROUP BY). This mirrors the existing
`tickInFlight` guard's already-accepted idempotent-retry model; no new
resume/checkpoint state is introduced.

The existing cross-process overlap guard (the `system.mutations` check
against `MUTATION_MARKER = GROUP BY ${CONTENT_KEY}`) must keep working
unchanged for bucketed mutations: the bucket predicate is additional `WHERE`
filtering layered around the existing `CONTENT_KEY` grouping, not a rewrite
of it, so every bucket's mutation command text still contains the literal
`GROUP BY ${CONTENT_KEY}` substring and remains detectable by the existing
`LIKE` check. The implementation must preserve this substring verbatim in
each bucket's SQL — if it doesn't, the overlap guard silently stops
detecting in-flight bucket mutations.
