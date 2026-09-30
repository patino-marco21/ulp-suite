# Query performance wins — design

**Date:** 2026-09-30
**Status:** Approved 2026-09-30 (design presented and approved in chat); implementation in progress on branch `perf/query-perf-wins`

## Why

A whole-project "what's left to improve" sweep on 2026-09-30, run right after the
content-dedup cutover (2.78B → 1.39B rows, [[project_dormant_content_dedup_cron]]),
surfaced three measured optimizations. Everything below was measured against the
live stack (ClickHouse 26.3, `ulp.credentials` = 1,393,449,551 rows, deduped at rest),
not inferred from source. The other findings of that sweep (no backups, `0.0.0.0`
binding with 2FA off, merge fsync, disk alerting, dependency/doc drift) are separate
work and explicitly **not** part of this spec.

Three independent changes, delivered A → B → C (smallest blast radius first), except
that C's feasibility gate (C0, below) runs first — it is the riskiest unknown and is
reversible with one `DROP PROJECTION`, so it should fail fast before any C code exists:

- **A** — the Credentials Browser's "Unique" total stops scanning the whole table.
- **B** — the nightly dedup tick stops running its heavy stats scan when nothing changed.
- **C** — the domain monitor's `email_domain` scan gets an index it can actually use.

## Measurements

| | Measured | Source |
|---|---|---|
| Unique total, default view (`WHERE is_noise = 0`) | `uniq(content_key_hash)`: 5.57 s, 10.99 GiB read, **1,299,598,840**. `count()`: 0.19 s, 670 MiB read, **1,309,971,574** | live, 2026-09-30 |
| Same, old 2.78B table under load | 31 s avg / 102 s p95 (7 runs in 7 days) | `system.query_log` |
| `count()` vs `uniq`, filtered | gmail.com 5.3 s vs 8.7 s; hotmail.com 5.0 vs 7.9; protonmail.com 4.8 vs 7.2; `country_tier='T1' AND is_noise=0` 0.84 vs 4.27. Counts agree within HLL error (−0.79% … +0.32%) | live |
| Nightly stats pass (`buildContentKeyStatsSql`) | 71.0 s, read 10.38 GiB, **peak RAM 9.26 GiB, 10.44 GiB written to temp disk** (415 spill parts); `total = distinctCreds = 1,393,449,551` (excess 0) | live, one supervised run |
| Monitor `email_domain` scan | 22.3 s (reads 1.39B rows) and 9.2 s (545M) variants post-dedup; 41–76 s pre-dedup; cap is 90 s; 533 timeout exceptions (Code 159) in the prior 7 days | `system.query_log` |
| Live rows matching the monitor's 17 domains | about 51 of 1.39B | sandbox populate |

### email_domain sandbox (throwaway `ulp.zz_probe_email_domain`, dropped after)

14,014,935 rows = a 1% hash sample plus every live row matching the monitor's
domains; same columns, skip indexes and covering `proj_imported_desc` as the live
table, plain `MergeTree`. The 2026-09-24 experiment only tested equality; the real
predicate is `email_domain = 'x' OR endsWith(email_domain, '.x')`, and **a suffix
match cannot prune on a plain `ORDER BY email_domain` projection**.

| Variant | marks | rows read | ms |
|---|---|---|---|
| current prod query (original predicate, `optimize_use_projections = 0`) | 225 | 7.11M | 204 |
| `proj_ed_rev` fully materialized + rewritten predicate (default settings) | **38** | **2.35M** | **116** |
| same + `preferred_optimize_projection_name` | 38 | 2.35M | 115 |
| rewritten predicate, projection present on half the partitions | 100 | 6.41M | 174 |
| rewritten predicate, **projection absent / settings off** | 225 | 14.01M | 370 |
| rewritten predicate + decoy `is_noise IN (0,1)` conjunct | 225 | 3.45M | 356 |

All variants returned an identical result set (same `count()` and `groupBitXor(cityHash64)`
of the DISTINCT values), including the half-materialized state. `EXPLAIN indexes = 1`
shows `reverse(email_domain)` ranges such as `['oi.rozert.', 'oi.rozert/')`: each
monitor domain becomes a prefix range, so the work is about (number of domains × one
granule), independent of table size. The original `endsWith` predicate with
projections ON full-scans both with and without the new projection present (the known
covering-projection planner trap), so it keeps `optimize_use_projections = 0`.
Side effect worth keeping: plain `email_domain = 'protonmail.com'` (the UI's exact
filter) read 0.54M rows with the projection present vs 13.5M without, with no query
change. Cost: 4.55 bytes/row (60.83 MiB for the sample) → **about 5.9 GiB live**;
`MATERIALIZE` took 3.1 s for the sample.

## A. Unique total uses `count()` when nothing is filtered

**Today.** `app/api/credentials/route.ts` computes the result tally with
`dedupeCountExpr(dedupe)` = `uniq(content_key_hash)` whenever Unique is on, on every
first page (cursor-less request). On the default Declutter + Unique view that scans
the whole table's hash column.

**Change.** `dedupeCountExpr(dedupe, hasUserFilter = true)`: with `dedupe` on and **no
user filter**, return `count()`; with any filter, keep `uniq(...)`. The route computes
`hasUserFilter = conditionsRaw.length > 1 || tierExtra !== '' || loginTypeExtra !== ''`
(everything that narrows a search; Declutter/Unique/sort/limit/cursor do not).

**Why it is safe.** `ulp.credentials` is deduped at rest (measured: total = distinct
exactly), so `count()` equals the distinct-credential count. After new imports it can
overstate by the not-yet-deduped duplicates, which the nightly tick only rebuilds for
once excess reaches `DEDUP_MIN_EXCESS` (14,000,000, about 1%). That bound is the same
order as `uniq`'s own observed error in the other direction. Filtered views keep
`uniq`, so a targeted search never reports "2 results" for one displayed row.

**Out of scope for A.** Filtered views with very large matches (`country_tier`,
`email_domain = 'gmail.com'`) still pay `uniq`; C makes the `email_domain` ones cheap,
the rest are unchanged (no regression).

**Tests.** Unit tests for `dedupeCountExpr` (all combinations, default argument), and a
route source-contract test in the repo's existing style asserting the route passes
`hasUserFilter`. Live check: default-view total in well under a second.

## B. Idle dedup tick skips the stats scan

**Today.** `runContentDedupTick` (`lib/content-dedup.ts`) always starts with the
single-pass `GROUP BY content_key_hash` stats query — 71 s, 9.3 GiB RAM and 10.4 GiB of
temp-disk writes per night even when no row has been imported for weeks.

**Change.**
- New `buildTableRowCountSql()`: `SELECT sum(rows) AS rows FROM system.parts WHERE
  database = 'ulp' AND table = 'credentials' AND active` (metadata, milliseconds).
- New pure `shouldSkipStatsPass({ rows, last, now, maxAgeMs })`: skip only when a
  previous stats pass exists, `rows` equals the row count captured before that pass,
  and that pass is younger than `STATS_FORCE_INTERVAL_MS` (7 days).
- Module-level `lastStatsPass: { rows, total, excess, at } | null`. The row count is
  captured **before** the stats query (rows inserted during the pass make the next
  tick run again — conservative). Set after a non-applying pass; reset to `null` after
  an applying tick so the next tick re-verifies excess = 0 on the rebuilt table.
- `runContentDedupTick(opts)` gains `skipIfUnchanged?: boolean`. Only `lib/dedup-cron.ts`
  passes `true`; `scripts/run-content-dedup-once.ts` never does, so a manual run is
  always a full pass. A skipped tick returns the last known `total`/`excess` with
  `applied: false, skipped: true` and logs one `console.warn` health line (prod strips
  `console.log`; see [[project_removeconsole_strips_logs]]).
- Fail-open: any error reading the row count falls through to the full pass (today's
  behavior).

**Why it is safe.** Excess (duplicate content keys) can only grow through inserts,
which change `sum(rows)`; deletes cannot create duplicates. A rewrite-in-place mutation
that changed key columns without changing the row count is the one blind spot, covered
by the weekly forced pass. State is in-process, like the project's other single-process
caches: a restart costs one full pass, exactly today's cost.

**Tests.** `shouldSkipStatsPass` (skip, rows changed, expired, no previous pass,
boundary), `buildTableRowCountSql` text, source-contract tests that `dedup-cron.ts`
passes `skipIfUnchanged: true` at both call sites and the one-off script does not.
Live check: run the tick twice in one process, report-only (first full, second skipped).

## C. `proj_email_domain_rev` for the monitor's `email_domain` scan

**Projection.** `PROJECTION proj_email_domain_rev (SELECT _part_offset ORDER BY
reverse(email_domain))` — a partial projection (projection index), about 5.9 GiB live.
`reverse` is byte-wise in ClickHouse, so `startsWith(reverse(v), reverse('.x'))` is
byte-for-byte equivalent to `endsWith(v, '.x')`.

**Schema plumbing** (one source of truth, same pattern as `IMPORTED_DESC_PROJECTION_BODY`):
- `lib/credentials-projections.ts`: `EMAIL_DOMAIN_REV_PROJECTION_NAME`,
  `EMAIL_DOMAIN_REV_PROJECTION_BODY`, ADD / MATERIALIZE SQL builders, an
  all-partitions query, and `restoreEmailDomainRevProjection(client, guard)` (ADD, then
  per-partition `MATERIALIZE ... SETTINGS mutations_sync = 1`, each behind the disk
  guard — same shape as `restoreImportedDescProjection`, but **all** partitions: it is
  tiny, so the recency window does not apply).
- DDL v23 in `lib/clickhouse-migrations.ts`: `ADD PROJECTION IF NOT EXISTS` only
  (metadata-only; new parts carry it). **No `MATERIALIZE` at deploy** — app start is not
  coupled to a mutation. Mirrored in `docker/clickhouse/init/01-ulp-tables.sql` (which
  already carries `proj_imported_desc` the same way, line 296) so fresh installs have it
  from the first insert.
- `runContentDedupTick` step 9 restores both projections (new one first, each in its
  own try/catch, `projectionsRestored` true only if both succeed) — otherwise the next
  rebuild silently drops it. `scripts/run-content-dedup-once.ts --restore-projections`
  covers both. `stripProjectionsFromCreateTableDdl` already strips every projection;
  its test gains a fixture captured from a real `SHOW CREATE TABLE` that includes a
  partial projection (a format mismatch would make the strip throw and block dedup).
- `lib/projection-scope.ts` only clears `proj_imported_desc` by name — unaffected.

**Query path.** In `resolveCandidates`, only for the `email_domain` column:
- `buildEmailDomainRevCandidateWhereClause(domains)` (`lib/domain-match.ts`): per
  domain `reverse(email_domain) = reverse({eq:String}) OR startsWith(reverse(email_domain),
  reverse({suffix:String}))`, same parameter values as today's builder.
- Used only when `isEmailDomainProjectionReady()`: every active part of `ulp.credentials`
  has the projection (`count()` of active `system.parts` equals `count()` of active
  `system.projection_parts` rows named `proj_email_domain_rev`, and is non-zero). Any
  other state, or any error, runs **today's query verbatim** (original predicate,
  `optimize_use_projections = 0`). This covers the window after a dedup swap, a
  partially built projection, and rollback by `DROP PROJECTION`.
- The index query keeps projections ON and adds `preferred_optimize_projection_name =
  'proj_email_domain_rev'` (measured equal to default; insurance against the planner
  trap at full scale). The `domain` scan is untouched.

**Tests.** Clause builder text and parameter names; readiness SQL builder; readiness
decision as a pure function (0 parts, all parts, some parts, error); restore helper
with fake client and guard (ADD first, one MATERIALIZE per partition, guard consulted
before each, failure propagates); migration v23 contents; resolver source-contract for
the two settings sets.

**Prior art, and why this is tested at scale first.** `lib/domain-match.ts` records an
earlier (2026-08-25) attempt to prune `domain` with reversed-string prefix matching
that "never got selected by the planner". That attempt used a normal covering projection
and a minmax index. This design uses a **partial projection index** (`_part_offset`,
applied through projection filtering), which the 26.3 planner does select in the sandbox —
but the sandbox is 14M rows (225 granules), so whether the planner still selects it at
1.39B rows (about 21K granules) is the one thing the sandbox cannot prove. That is
therefore checked **first**, on the live table, before any C code is written (gate C0
below). The stale comment in `lib/domain-match.ts` is updated when the new builder lands.

**Gate C0 — feasibility on the live table (first; reversible).**
1. Create a tiny scratch table with both projections and capture `SHOW CREATE TABLE` as
   the fixture for the strip-function test (before touching the live table).
2. On `ulp.credentials`: `ADD PROJECTION IF NOT EXISTS proj_email_domain_rev`, then
   `MATERIALIZE` one partition at a time (`mutations_sync = 1`, disk guard, watching
   `system.mutations`, container RAM and disk). DDL v23 later re-adds it idempotently.
3. With the real monitor predicate (original vs rewritten, via `--param_*`): identical
   distinct-value `count()` and value hash; `EXPLAIN indexes = 1` shows
   `proj_email_domain_rev` with a small granule count; wall time against the 22 s / 9 s
   baseline.
4. **Stop conditions:** the planner does not use it, the numbers are not clearly better,
   or the mutation strains RAM/disk → `ALTER TABLE ulp.credentials DROP PROJECTION
   proj_email_domain_rev`, stop C, report. A and B are unaffected.

**Gate C-final (after the code is deployed).**
1. The monitor resolves through the new path (readiness true) and through the old path
   when the projection is dropped, with identical candidate values.
2. Spot-check that other top query shapes did not regress: the Unique total, the `domain`
   scan, an `email_domain = 'x'` filter, the default browse page.
3. Run the dedup restore helper against the live table (no-op when already materialized)
   and confirm `stripProjectionsFromCreateTableDdl` accepts the real `SHOW CREATE TABLE`.
4. Rollback at any time: `ALTER TABLE ulp.credentials DROP PROJECTION
   proj_email_domain_rev` (the monitor falls back by itself).

## Risks and fallbacks

- **MATERIALIZE memory/CPU at 1.39B rows is not proven by the sandbox.** Mitigation:
  per-partition, `mutations_sync = 1`, disk guard before each, watched live, `DROP
  PROJECTION` rollback. Precedent: the far heavier `proj_imported_desc` (nine columns,
  157 GiB) materialized fine per partition at 2.78B rows.
- **A domain matching more than 1M rows does not use the index** (ClickHouse's
  `max_projection_rows_to_use_projection_index` default). It degrades to a scan of
  today's order of magnitude; the hardware-wallet monitor's domains are rare. Not raised
  preemptively.
- **Rewritten predicate without the projection is a full scan** (measured, worse than
  baseline). Only reachable in a race with a dedup swap; the readiness check makes the
  normal state impossible, and the scan still finishes inside the 90 s cap.
- **Insert/merge overhead** of one more projection: small (storage +3%); no insert
  imports are pending, and the first real import will be timed.
- **A's overcount** is bounded by `DEDUP_MIN_EXCESS` and documented in the route.
- **B's blind spot** (in-place key mutation) is covered by the weekly forced pass.

## What's out of scope

- Backups, network binding / 2FA, merge-fsync, disk-space alerting, dependency and doc
  drift — separate findings from the same sweep.
- Dropping `idx_ngram_email_domain` / `idx_bf_email_domain`: revisit only with live
  post-rollout numbers (the 545M-row variant suggests they still prune for some shapes).
- Rewriting the UI exact-filter or phase-2 `email_domain IN (...)` predicates: they
  benefit automatically (measured), no change needed.
- Persisting B's state in SQLite, and an "approximate total" flag in the API response.

## Gate C0 results (2026-09-30, live `ulp.credentials`, 1,393,449,551 rows)

C0 ran **after** the C code was committed rather than before it: the UI was in active use
when the gate was due (16–27 interactive queries per 10 minutes), so the mutation was started
in a quiet gap instead of under interactive load. The merge and deploy were still gated on it.

| Check | Result |
|---|---|
| Projection on every active part | 8 / 8 parts; **5.68 GiB** (3.68 GiB in 202607, 2.00 GiB in 202608) against the 5.9 GiB extrapolation |
| `MATERIALIZE` duration | 202608 (1 part, 495.8M rows): 350 s; 202607 (7 parts, 897.6M rows): 95 s; 7.4 min in total |
| `MATERIALIZE` memory | per-task peak **142 MiB** (the far heavier `proj_imported_desc` restore peaked ~620 MiB per task); container never above ~4.5 GiB of 20 including concurrent user searches; 0 restarts, no OOM |
| Disk | real free space steady at ~207–213 GiB; `system.disks.unreserved_space` dipped by the tasks' conservative reservations (each reserves the source part's size; ~125 GiB while five tasks ran) and recovered on completion |
| Result equality (17-domain monitor predicate) | original + projections off vs rewritten: both `n = 4`, value hash `14879193306084178667` |
| Original query | 8.7 s, 474.2M rows read, 21,469 / 21,469 marks |
| Rewritten query via the projection | **0.197 s**, 6.97M rows read, 109 marks (109 / 21,469 granules, 93 ranges): 44× faster |
| Parameterized form (`{p:String}`) | same plan shape (16 / 21,469 granules for two domains) and executes, returning the expected values: `reverse({p})` folds, no pre-reversed literals needed |
| UI exact filter `email_domain = 'protonmail.com'` | 31 ms / 1.18M rows / 18 marks (was ~4.8 s earlier the same day), with no query change |
| Browse plans (two shapes) | identical before and after |
| `domain` scan (projections off) | unchanged by construction (`optimize_use_projections = 0` disables every projection) |

Stop conditions never tripped. Decision: go.
