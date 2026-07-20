# Content-Dedup: Bucket the Cutoff/Stats Distinct-Count Query Against Real Scale

## Problem

`lib/content-dedup.ts`'s `buildCutoffSql()` and `buildStatsSql()` both run

```sql
SELECT ..., uniqExact(cityHash64(CONTENT_KEY)) AS ... FROM ulp.credentials
SETTINGS max_execution_time = 300
```

— a single, *ungrouped* aggregate over the whole table. Confirmed live tonight
(2026-07-19), a manually-triggered tick (`CONTENT_DEDUP_APPLY` forced `true`
in-process only, real `.env` never touched) against real `ulp.credentials`
(562,400,008 rows, 91,686,324 excess per `buildStatsSql()`, which succeeded
moments earlier) hit `buildCutoffSql()` failing with:

```
Code: 241. MEMORY_LIMIT_EXCEEDED: would use 15.00 GiB
(ConvertingAggregatedToChunksTransform), maximum: 16.00 GiB
```

The existing outer `try`/`catch` in `runContentDedupTick()` handled this
safely — logged, `{ applied: false }`, original table untouched, no data at
risk — but it means the automated rewrite+swap cannot currently complete a
real run at all: it fails before ever reaching table creation.

**This is not only a future problem for whenever `CONTENT_DEDUP_APPLY` gets
enabled.** `buildStatsSql()` runs unconditionally on *every* tick, including
today's report-only default — so a scheduled cron tick (`DEDUP_CRON_HOURS`,
168h/weekly per `.env.example`) can already intermittently fail its stats
logging for a cycle, purely from table growth, independent of whether apply
is ever turned on.

Table growth trajectory from this session's prior specs: ~20M (original
assumption) → 91M (2026-07-04, stats query succeeded in 5.16s, untuned) →
~356-467M (2026-07-07/08, populate redesign) → 562.4M (tonight). Confirmed
via `git log --follow -- lib/content-dedup.ts` that neither `buildCutoffSql`
nor `buildStatsSql` has ever been touched by any of the six prior live
memory fixes in this file (`315501b`, `633fee5`, `01ce37e`, `36a3a8a`, plus
the earlier bucketed-DELETE work) — those all targeted `ORDER BY`/sort-buffer
and `MATERIALIZED`-column costs in the populate/catch-up `INSERT`s, a
genuinely different mechanism with no `ORDER BY` involved here at all. This
is new, previously-unhit territory, not a recurrence of an already-fixed bug.

## Root Cause

`uniqExact(cityHash64(CONTENT_KEY))` with no `GROUP BY` forces ClickHouse to
hold one exact-cardinality hash set for all ~470M distinct content keys in
memory for the query's whole duration, with no way to shrink it mid-query.
Confirmed live tonight via direct inspection of the real server:

| Setting | Live value | Implication |
|---|---|---|
| `max_threads` | `'auto(16)'` | Both queries run fully unbounded — up to 16-way parallelism, no override today |
| `max_server_memory_usage` | `17179869184` (16 GiB) | Exact match to tonight's reported ceiling |
| `max_bytes_before_external_group_by` | `21474836480` (20 GiB, from `docker/clickhouse/users/ulp-profiles.xml`) | **Above** the real 16 GiB ceiling — this spill threshold can never trigger before the hard OOM does, for *any* query relying on the profile default (the same footgun `docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md` flagged for `exportGroupBySettings()`, just repo-wide here) |
| `background_pool_size` / `background_merges_mutations_concurrency_ratio` | `20` / `3` | Matches `lib/clickhouse-query-limits.ts`'s documented "effective ceiling is ~14 GiB, not 16-18" note — real headroom is thinner than the nominal cap |
| `system.parts` for `ulp.credentials` | 11 active parts, 562,400,008 rows, 63.05 GiB, biggest part 189.7M rows/21.73 GiB | Matches tonight's reported row count exactly; 0 in-flight merges/mutations at the moment checked |

At ~470M distinct values, this aggregation sits right at that 16 GiB ceiling
— `15.00 / 16.00 GiB` is a ~94% margin. `buildStatsSql()` (structurally
near-identical: same `uniqExact(cityHash64(CONTENT_KEY))` over the same
table) succeeding moments before `buildCutoffSql()` failed is consistent with
ordinary run-to-run variance at that razor-thin edge, not a real difference
between the two queries' SQL.

## Investigation

All tests below are read-only and touched **only** ClickHouse's synthetic
`numbers()` generator or read-only `system.*` tables — `ulp.credentials`
itself was never re-queried with the expensive aggregate tonight, to avoid
adding more memory pressure to a live table already confirmed to sit at the
edge.

| Test | Result |
|---|---|
| `uniqExact(number)` over `numbers(50000000)`, capped at 900 MiB, `max_threads=16` | **Fails** — `would use 902.71 MiB`, in `AggregatingTransform` |
| Same, `max_threads=2` | **Fails identically** — same `902.71 MiB`, same transform. Thread count has no measurable effect on peak memory for this query shape |
| Same, `max_threads=16` + `max_bytes_before_external_group_by=900MiB` | **Fails identically** — the spill setting never engages for a zero-key (ungrouped) aggregate; nothing to spill in favor of |
| `SELECT sum(c) FROM (SELECT uniqExact(number) AS c FROM numbers(50000000) GROUP BY number % 32)`, same cap, spill bounded to same threshold | **Fails identically** (`900.78 MiB`) — with 32 *real* groups but an unordered single pass, every group's partial state must stay open for the whole scan; nothing completes early enough to spill |
| Same GROUP BY query, spill setting omitted (relies on 20 GiB profile default) | **Fails identically** — confirms the profile default is a no-op here too, consistent with the Root Cause table above |
| `uniqExact(number) FROM numbers(50000000) WHERE number % 8 = 0` (one bucket of 8), same 900 MiB cap | **Succeeds** — returns `6250000` (exact) |
| `sum()` of all 8 buckets' `uniqExact`, run sequentially | **Succeeds** — returns `50000000`, exactly matching the true total |

Key finding: neither thread-limiting nor `external_group_by` spill — the two
settings-only levers this file already uses elsewhere — has any effect on a
single ungrouped `uniqExact`'s peak memory, including when reshaped into a
real multi-group `GROUP BY`. Only reducing the actual per-query cardinality
(via `WHERE`-filtered modulo bucketing, scanned separately per bucket)
measurably bounds memory, and does so exactly — not approximately.

## Approaches Considered

**A — Bound `max_threads`** (mirrors this file's existing populate-step
fix). Rejected: tested live tonight, zero effect on the failure.

**B — Bound `max_bytes_before_external_group_by`** (mirrors this file's
existing catch-up/populate settings and the earlier GROUP BY-predicate fix
from `2026-07-04-content-dedup-scale-fix-design.md`). Rejected: tested live
tonight, zero effect — that predicate's fix worked because it was a genuine
multi-group `GROUP BY` (~67M groups, each a small `min()` state); a zero-key
`uniqExact` has no groups for the spill mechanism to act on.

**C — Reshape into a single-scan `GROUP BY hash % N`, relying on spill.**
Rejected: tested live tonight, zero effect — with an unordered scan, all N
groups' partial states must stay resident for the query's entire duration,
so peak memory doesn't drop, and nothing spills early. Would have been
strictly better than D if it had worked (one scan instead of N), so worth
having ruled out explicitly rather than assumed.

**D — Approximate cardinality (`uniq()`/`uniqCombined()`)**. Rejected on
correctness grounds, not performance — not live-tested, because the
reasoning rules it out regardless of numbers. `buildCutoffSql()`'s
`expected_rows` is a safety floor: `runContentDedupTick()` fails verification
(aborts, original untouched) when `cdedupRows < expectedRows`, specifically
to catch a build that silently lost pre-existing content keys. An
approximate estimator's error isn't guaranteed one-directional — a run that
happens to *underestimate* the true cutoff-time count could let a build that
actually lost real content keys pass verification anyway, silently. That's
exactly the failure mode this check exists to catch. Not an acceptable
trade for a memory fix.

**E — `WHERE`-filtered modulo bucketing, N separate full-table scans, summed
client-side (chosen).** Reuses the exact correctness guarantee this file
already relies on for the populate step: `cityHash64(CONTENT_KEY) % N`
guarantees every row of a content-duplicate group hashes to the same bucket,
so `sum(uniqExact per disjoint bucket)` equals the true whole-table distinct
count exactly — confirmed live tonight (`50000000`, exact, no drift). This
is the only approach of the five that actually bounds memory, live-confirmed
tonight rather than assumed.

## Decision

Ship E, mirroring `buildPopulateDedupedTableSqlForBucket`'s existing,
real-scale-proven pattern as closely as possible.

## Architecture

Both `buildStatsSql()` and `buildCutoffSql()` are replaced by three smaller
pure SQL builders plus a shared bucketed-sum loop in `runContentDedupTick()`:

```ts
/** Cheap — no aggregation, just a row count. Unbucketed: count() carries no cardinality-driven memory cost. */
export function buildTotalRowCountSql(): string {
  return `SELECT count() AS total FROM ulp.credentials SETTINGS max_execution_time = 300`
}

/** Cheap — trivial single value, captured before any bucket scan starts (see ordering note below). */
export function buildCutoffTimestampSql(): string {
  return `SELECT now() AS cutoff`
}

/** Shared by both the stats path and the cutoff path -- identical query, different caller. */
export function buildDistinctContentKeyCountSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `SELECT uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct
  FROM ulp.credentials
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  SETTINGS max_execution_time = 300`
}
```

An internal (not exported — this file doesn't unit-test client-dependent
orchestration, only pure SQL builders, matching existing convention) helper
in `runContentDedupTick()`'s module runs the loop once per caller:

```ts
async function sumDistinctContentKeysBucketed(client: ClickHouseClient, bucketCount: number): Promise<number> {
  let sum = 0
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const res = await client.query({ query: buildDistinctContentKeyCountSqlForBucket(bucket, bucketCount), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ bucket_distinct: string }>
    sum += Number(row?.bucket_distinct ?? 0)
  }
  return sum
}
```

**Stats step** (`runContentDedupTick`, always runs): `total` from
`buildTotalRowCountSql()`, `distinctCreds` from
`sumDistinctContentKeysBucketed()`, `excess = total - distinctCreds` —
computed in TS now, not SQL.

**Cutoff step** (only when `willApply`): `cutoff` from
`buildCutoffTimestampSql()` **first**, then `expectedRows` from
`sumDistinctContentKeysBucketed()`.

**Ordering matters, and is deliberately preserved:** `cutoff` must still be
captured before the populate step begins reading, for `CATCH-UP`'s own
correctness (unchanged from today — anything landing after `cutoff` is
guaranteed `imported_at > cutoff` and picked up post-swap). Capturing it via
its own trivial query *before* the (now multi-second-to-multi-minute)
bucketed sum preserves that unchanged. What changes: `expectedRows` is no
longer captured atomically with `cutoff` — the bucketed sum runs afterward,
so it can pick up some rows imported during its own scan window, on top of
what already existed at `cutoff`. Since `ulp.credentials` only ever gains
rows during this window (no concurrent deletes), the bucketed sum can only
equal-or-exceed the true cutoff-instant count, never fall under it — so the
existing `cdedupRows >= expectedRows` safety check stays exactly as
conservative as it is today, just with a (still safe-direction-only) wider
window in which extra rows could make `expectedRows` a slightly higher bar.
This is the same kind of slack the `>=` check (rather than `==`) already
tolerates for the populate step itself.

**Bucket count:** reuse `contentDedupBucketCount()` (`CONTENT_DEDUP_BUCKET_COUNT`,
default 32) rather than introduce a second knob. Tonight's synthetic test
showed 1 bucket of 8 (1/8th cardinality) comfortably clearing a cap the
unchunked query only barely exceeded; 32 buckets gives roughly 4x more
subdivision than that tested margin at real scale (~14.7M distinct/bucket
vs. today's ~470M unchunked). Not empirically confirmed at real scale yet —
see Rollout Plan.

**Cost tradeoff, stated plainly:** like the populate step's own bucketing,
each bucket's hash filter is unprunable — **N buckets means N full-table
scans**, not N scans of 1/N the data. This was tested and ruled out as a
single-scan alternative in Approach C above; there is no cheaper option that
still bounds memory. `buildStatsSql()`'s replacement now costs ~33 scans
(1 count + 32 buckets) instead of 1, on *every* tick, not just apply-ticks.
Actual wall-clock cost at real scale is unmeasured — the Rollout Plan below
measures it before treating 32 as final for this use case specifically (the
populate step's bucket count was tuned for a different memory mechanism —
background-merge pressure accumulation in a long `INSERT` — and there's no
a priori reason the same number is optimal here too, only that it's a safe
starting point).

**Not applying `max_threads`/`max_bytes_before_external_group_by` to the new
bucketed query:** both were tested tonight and shown to have no effect on
this query shape (Investigation table above) — adding them would only slow
each bucket down for no measured benefit. `max_execution_time = 300` is
kept unchanged (same per-query cap this file already uses here today).

## Interfaces Changed

`lib/content-dedup.ts` removes `buildStatsSql()` and `buildCutoffSql()`.

`lib/content-dedup.ts` adds:

- `buildTotalRowCountSql(): string`
- `buildCutoffTimestampSql(): string`
- `buildDistinctContentKeyCountSqlForBucket(bucketIndex: number, bucketCount: number): string`
- `sumDistinctContentKeysBucketed(client, bucketCount): Promise<number>` (internal, not exported)

`runContentDedupTick()`'s stats step and cutoff step both change from one
`client.query()` call to a total/timestamp query plus a bucketed-sum loop,
per Architecture above. `DedupTickResult`'s shape is unchanged.

A new paragraph (mirroring the existing `POPULATE SCALE` paragraph) should
be added to the file's top-of-file doc comment, referencing this design doc,
so a future reader hitting this same class of question again finds the
answer immediately rather than re-deriving it.

Unchanged: `CONTENT_KEY`, `contentDedupBucketCount()`,
`buildPopulateDedupedTableSqlForBucket()`, `buildEnsureSearchIndexesSql()`,
`buildVerifyDedupedTableSql()`, `buildRenameSwapSql()`,
`buildCatchupInsertSql()`, `CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES`,
`CONTENT_DEDUP_MAX_THREADS`, the verification `>=`/`==` comparison logic,
the rollback-retention behavior, `lib/dedup-cron.ts`, all `app/api` routes.

## Rollout Plan

1. Implement the three new SQL builders and the bucketed-sum helper, with
   unit tests for the pure builders (SQL shape only, matching this file's
   existing `toContain`-based style) and updated/replaced tests for the
   removed `buildStatsSql`/`buildCutoffSql` cases in
   `__tests__/content-dedup.test.ts`.
2. **Disposable-clone verification at meaningfully large scale**, matching
   the lesson from `2026-07-08-content-dedup-bucketed-populate-design.md`
   (a 3M-row clone was too small to catch any of that round's real issues).
   Build a clone large enough to approach the real cardinality where the
   unchunked query fails (hundreds of millions of rows) — or, cheaper and
   sufficient for this specific mechanism, reuse tonight's `numbers()`-based
   synthetic technique at a scale and memory cap deliberately chosen to
   reproduce the same `ConvertingAggregatedToChunksTransform` failure point
   the real table hits, then confirm bucketing resolves it there too. Verify:
   the bucketed sum exactly matches an unchunked reference count, and record
   actual per-bucket timing to validate (or revise) the bucket-count choice
   above.
3. **Live verification against real `ulp.credentials` — read-only, low
   risk.** Unlike prior rounds, the stats path (`buildTotalRowCountSql` +
   bucketed sum) is non-destructive by construction regardless of
   `CONTENT_DEDUP_APPLY` — it creates nothing, drops nothing, and can be
   verified directly against production data with no swap/rollback concerns.
   Confirm: the bucketed sum matches `buildStatsSql()`'s old reported
   `distinct_creds` from earlier tonight (91,686,324 excess against
   562,400,008 total, i.e. distinct ≈ 470,713,684) within the expected
   small margin from ongoing live ingest, no `MEMORY_LIMIT_EXCEEDED`, and
   record real elapsed time for the full 32-bucket pass.
4. The cutoff path (`buildCutoffTimestampSql` + bucketed sum), by contrast,
   only ever runs as step 1 of the full rewrite+swap sequence — verifying it
   in isolation means invoking `runContentDedupTick` with
   `CONTENT_DEDUP_APPLY` forced `true` in-process only (same pattern as
   tonight's manual trigger), which re-enters the same destructive flow
   already covered by `2026-07-07-content-dedup-rewrite-swap-design.md`'s
   and `2026-07-08-...`'s own live-rollout steps. Treat this the same way:
   confirm pre-state, watch progress, confirm post-state independently,
   report back before enabling `CONTENT_DEDUP_APPLY=true` for ongoing
   scheduled use — which remains a separate, later decision regardless of
   how this rollout goes.

## Testing

1. **Unit tests**: `buildTotalRowCountSql()`, `buildCutoffTimestampSql()`,
   and `buildDistinctContentKeyCountSqlForBucket()`'s exact SQL shape
   (matching `buildPopulateDedupedTableSqlForBucket`'s existing test style —
   bucket filter present and correctly parameterized, no stray settings).
   Removal of `buildStatsSql`/`buildCutoffSql` tests from
   `__tests__/content-dedup.test.ts`, replaced with tests for the three new
   builders.
2. **Disposable-clone verification**: as Rollout Plan step 2.
3. **Live verification**: as Rollout Plan steps 3-4.

## Error Handling

No new error paths. A bucket failing partway through either sum loop
propagates up through the existing outer `try`/`catch` in
`runContentDedupTick()` exactly as a `buildPopulateDedupedTableSqlForBucket`
failure does today — logged, `{ applied: false }`, original table untouched.
The stats path failing (all buckets or the total-count query) means that
tick simply has no stats to log for that cycle, same as today's single-query
failure mode, just now failing per-bucket instead of all-at-once.
