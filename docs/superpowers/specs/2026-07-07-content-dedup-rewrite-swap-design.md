# Content-Dedup: Rewrite+Swap Replaces Bucketed Mutations — Design

## Problem

`lib/content-dedup.ts`'s bucketed heavyweight-DELETE mechanism (this session's
prior design, `docs/superpowers/specs/2026-07-06-content-dedup-bucketed-delete-design.md`)
correctly solved the memory problem it was built for — confirmed live against
real production data, buckets 0 and 1 of a planned 0-31 rollout checkpoint
both completed with zero memory errors and removed exactly the expected
number of duplicate rows (108,051 and 108,715 respectively).

But both took ~34 minutes each. `system.parts` explains why: `ulp.credentials`
currently has only **13 active parts**, one of which holds **315.6M rows
(26 GiB) — 68% of the whole table**. Content-hash values are essentially
uniform across all rows, so every bucket's `cityHash64(...) % bucketCount =
bucketIndex` predicate matches at least one row in virtually every part —
meaning **every one of the 1024 buckets rewrites all 13 parts, including the
26 GiB one, regardless of bucket count.** A full sweep would take on the
order of weeks, not the "hours" the prior design estimated.

This is not specific to today's backlog. It recurs for any future incremental
tick too, once a table has settled into a small number of large parts (which
is exactly what ClickHouse's background merges are for) — bucketing bounds
memory (few rows per bucket to GROUP), never the number of parts a mutation
must touch. Confirmed via ClickHouse's own official guidance: ["prefer the
insert-select-rename pattern... over
mutations"](https://clickhouse.com/docs/best-practices/avoid-mutations) for
exactly this class of large transformation.

## Prior Art

This codebase already has a **proven** implementation of insert-select-rename
for this exact table: `scripts/dedup-credentials-content.sh` (create a new
table via `SHOW CREATE TABLE` + rewritten DDL → `INSERT ... SELECT ... ORDER
BY ... LIMIT 1 BY key` → verify → `RENAME` swap). That script is unchanged by
this design — it remains a separate, manually-invoked one-time tool. This
design is an independent, automated re-implementation of the same pattern in
`lib/content-dedup.ts`, driven by the existing scheduled cron
(`lib/dedup-cron.ts`, unchanged) instead of a human running a script.

Also ruled out: ClickHouse's [Refreshable Materialized
Views](https://clickhouse.com/docs/materialized-view/refreshable-materialized-view)
(production-ready since 24.10) — a native "periodic full-query rebuild +
atomic swap" feature that looks superficially perfect for this. It isn't: an
RMV's target table is meant to be written only by the RMV's own refresh
cycle, but `ulp.credentials` must keep receiving direct inserts from the
ingest pipeline continuously. Using an RMV here means fighting the ingest
pipeline, not simplifying anything.

## Architecture

**New table names** (distinct from the manual script's `_cdedup`/`_predup`,
so the two can never collide if an operator runs the manual script while the
automated job is active): `ulp.credentials_cdedup_auto` (build target,
transient), `ulp.credentials_predup_auto` (archived original, retained one
cycle as a rollback safety net).

**Per-tick sequence** (replaces the current bucket loop in
`runContentDedupTick`'s apply path):

1. Capture `cutoff` — `SELECT now()` **against ClickHouse's own clock**, not
   the Node process's, since `imported_at` is a ClickHouse-side `DEFAULT
   now()` value computed at insert time; comparing it against a
   Node-clock timestamp risks skew-related bugs.
2. If `ulp.credentials_predup_auto` exists (the previous successful run's
   retained safety net), drop it. This is the ONE place the safety net gets
   cleared — an operator gets the entire interval between two ticks (e.g. a
   full week, if `DEDUP_CRON_HOURS=168`) to notice a problem and manually roll
   back before it's cleared for the next cycle.
3. If `ulp.credentials_cdedup_auto` exists (a partial build left over from a
   crashed run), drop it. Unlike the manual script (built for a human who can
   inspect and resume partial state), an unattended tick always starts fresh
   rather than trying to resume — simpler and safer for something running
   unsupervised.
4. Create `ulp.credentials_cdedup_auto`: `SHOW CREATE TABLE ulp.credentials`,
   rewrite the table name and the `ReplicatedMergeTree` ZooKeeper path (same
   technique as the manual script — a clone with the same ZK path collides
   with `REPLICA_ALREADY_EXISTS`), execute the rewritten DDL.
5. Populate: `INSERT INTO ulp.credentials_cdedup_auto SELECT * FROM
   ulp.credentials ORDER BY url, email, password, imported_at LIMIT 1 BY
   CONTENT_KEY` (`CONTENT_KEY` unchanged: `` `${URL_CONTENT_KEY}, email,
   password` ``). `LIMIT 1 BY` keeps the earliest `imported_at` per content
   key and, unlike a `min(hash)` predicate, has no "exact ties all share one
   value" failure mode — it always keeps exactly one physical row per key,
   including among byte-identical duplicates. This makes the `_part`/
   `_part_offset` tie-break hash extension from the bucketed design
   unnecessary.
6. Verify: `count()` on `ulp.credentials_cdedup_auto` must equal
   `uniqExact(cityHash64(CONTENT_KEY))` computed on the original
   `ulp.credentials`, AND `ulp.credentials_cdedup_auto` must itself have zero
   internal excess (`count() - uniqExact(cityHash64(CONTENT_KEY)) = 0`). If
   either check fails: log the failure, drop `ulp.credentials_cdedup_auto`,
   return `{ applied: false }`. The original table is never touched.
7. Swap: `RENAME TABLE ulp.credentials TO ulp.credentials_predup_auto,
   ulp.credentials_cdedup_auto TO ulp.credentials` (metadata-only, instant).
8. Catch-up: rows imported between step 1's cutoff and step 7's swap exist
   only in the now-archived `ulp.credentials_predup_auto` and would otherwise
   be silently lost. `INSERT INTO ulp.credentials SELECT * FROM
   ulp.credentials_predup_auto WHERE imported_at > {cutoff} AND
   cityHash64(CONTENT_KEY) NOT IN (SELECT cityHash64(CONTENT_KEY) FROM
   ulp.credentials) ORDER BY url, email, password, imported_at LIMIT 1 BY
   CONTENT_KEY`. The `NOT IN` guards against double-inserting a row that
   landed exactly at the cutoff boundary and was already captured by step 5's
   read (ClickHouse's `INSERT ... SELECT` has no strict snapshot isolation, so
   step 5 may have already picked up some rows imported after `cutoff` was
   captured); the trailing `LIMIT 1 BY` deduplicates the catch-up set against
   itself, in case two catch-up rows share a content key. Net effect: every
   successful cycle leaves the table with zero content-duplicates, not "close
   to zero until next time."
9. Log completion. `ulp.credentials_predup_auto` is deliberately left in
   place until step 2 of the *next* run (the rollback safety net described
   above) — this tick does not drop it.

`DedupTickResult { total, excess, applied }`'s shape is unchanged — `total`/
`excess` still come from the unchanged `buildStatsSql()`; `applied: true`
now means "a rewrite+swap cycle completed," not "N buckets were mutated."

**Cross-process in-flight guard simplification.** The bucketed design's
`system.mutations`-based overlap guard existed because heavyweight mutations
are asynchronous background work that outlives the submitting connection —
if the app process crashed mid-mutation, the mutation kept running
server-side, and a later tick needed to detect that. `INSERT ... SELECT` is
different: it is a regular, foreground-blocking query, and if the submitting
connection is cancelled (e.g. the app process crashes), the server-side query
is cancelled too — there is no orphaned background work to guard against.
The existing in-process `tickInFlight` boolean (unchanged) is therefore
sufficient on its own; no new cross-process check is needed, and the removed
mutation-based one (`MUTATION_MARKER`, `dedupMutationInFlight`,
`waitForBucketMutation`) has no replacement because it has no remaining
purpose.

## Interfaces Changed

`lib/content-dedup.ts` removes: `FULL_HASH`, `contentDuplicatePredicateForBucket`,
`buildDeleteSqlForBucket`, `buildDeleteExecSqlForBucket`,
`contentDedupBucketCount`, `CONTENT_DEDUP_BUCKET_COUNT` (env var),
`CONTENT_DEDUP_MAX_THREADS`, `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES`,
`MUTATION_MARKER`, `dedupMutationInFlight`, `waitForBucketMutation`,
`CONTENT_DEDUP_POLL_INTERVAL_MS`, `CONTENT_DEDUP_BUCKET_MAX_WAIT_MS`. Also
removes `scripts/content-dedup-bucket-run.sh` (the bucket-range rollout
script — nothing left to roll out by bucket range).

`lib/content-dedup.ts` adds:

- `AUTO_DEDUP_TABLE = 'ulp.credentials_cdedup_auto'` (exported const)
- `AUTO_PREDUP_TABLE = 'ulp.credentials_predup_auto'` (exported const)
- `CONTENT_DEDUP_SURVIVOR_ORDER = 'url, email, password, imported_at'`
  (exported const — mirrors `scripts/dedup-credentials-content.sh`'s `ORDER`
  exactly; deliberately the raw `url` column, not the normalized
  `URL_CONTENT_KEY` expression, matching the proven script — `imported_at
  ASC` is what actually decides the survivor among same-content-key rows)
- `rewriteCreateTableDdl(showCreateSql: string, targetTable: string): string`
  — pure function; rewrites the table name and ZooKeeper path in a `SHOW
  CREATE TABLE` result. Pure and unit-testable, unlike the DB call that
  fetches `showCreateSql` in the first place.
- `buildPopulateDedupedTableSql(): string` — the `INSERT INTO
  {AUTO_DEDUP_TABLE} SELECT * FROM ulp.credentials ORDER BY
  {CONTENT_DEDUP_SURVIVOR_ORDER} LIMIT 1 BY {CONTENT_KEY}` statement.
- `buildVerifyDedupedTableSql(): string` — the row-count and excess
  verification query (against `AUTO_DEDUP_TABLE` and the original).
- `buildRenameSwapSql(): string` — the `RENAME TABLE ulp.credentials TO
  {AUTO_PREDUP_TABLE}, {AUTO_DEDUP_TABLE} TO ulp.credentials` statement.
- `buildCatchupInsertSql(cutoff: string): string` — the post-swap catch-up
  `INSERT` described in step 8.

Unchanged: `CONTENT_KEY`, `buildStatsSql()`, `contentDedupApplyEnabled()`,
`minExcessToApply()`, `dedupCronHours()`, `dedupCronHourUtc()`,
`DedupTickResult`, the `tickInFlight` guard, `lib/dedup-cron.ts` (no changes
at all), all `app/api` routes (no changes at all).

**Config:** `CONTENT_DEDUP_APPLY` and `DEDUP_MIN_EXCESS` are unchanged in
meaning and code. `DEDUP_CRON_HOURS`'s code is unchanged (it already
generalizes to any interval), but its recommended default in `.env.example`
moves from 24 (daily) to 168 (weekly), given the cost profile is now a
full-table pass rather than a bounded incremental mutation. `CONTENT_DEDUP_BUCKET_COUNT`
is removed entirely (see above).

## Testing

1. **Unit tests** for each new SQL-builder function's exact shape, matching
   this file's existing test style (as `buildDeleteSqlForBucket`'s shape was
   tested before removal). `rewriteCreateTableDdl` gets a fixed sample `SHOW
   CREATE TABLE` string as input and an exact-match assertion on the
   rewritten output — this is the one piece of real logic worth testing in
   isolation from a live database.
2. **Disposable-clone verification** (required before deploying, matching
   this session's established practice): build a small projection-including
   clone, populate it with a representative sample plus deliberately
   duplicated rows, run the full tick sequence (steps 1-9) against it, and
   specifically exercise the catch-up path — insert a "late-arriving" row
   with `imported_at` after the captured cutoff but before the swap step
   runs, and confirm it survives in the final table exactly once (not zero,
   not duplicated).
3. **Live rollout verification**: one manually-supervised run of this
   mechanism's own code path against real `ulp.credentials`, with
   `CONTENT_DEDUP_APPLY` left `false` in the real `.env` throughout. This
   design removes the bucketed design's rollout script (there is no bucket
   range left to roll out), so this is a one-off, uncommitted verification
   script (matching this session's established precedent for ad hoc
   real-data checks — not a new permanent API route or CLI command, since
   there is no ongoing need for a manual trigger beyond this one
   verification): a small `tsx`-run script that imports `runContentDedupTick`
   directly and calls it once, overriding `process.env.CONTENT_DEDUP_APPLY`
   to `'true'` only within that script's own process (never touching the
   real `.env` file). Verify: row count drops to
   `uniqExact(cityHash64(CONTENT_KEY))`, zero excess remains, the projection
   (`proj_imported_desc`) is intact on the new table, and — if any real
   imports land during the run — the catch-up step correctly preserves them.
   Only after this succeeds does enabling `CONTENT_DEDUP_APPLY=true` in the
   real `.env` for ongoing scheduled use become a separate, later decision.

## Error Handling

Every failure path described in the Architecture section (verification
failure, a stale `_cdedup_auto`/`_predup_auto` found at tick start) is
handled by dropping the offending table and either aborting the tick
(`applied: false`, original untouched) or proceeding with a fresh build — no
new state needs to be introduced beyond the two table names themselves,
whose existence *is* the state. The existing `runContentDedupTick` outer
try/catch (unchanged) remains the backstop for anything unexpected; a caught
error still logs and returns `{ total: 0, excess: 0, applied: false }`,
matching current behavior.
