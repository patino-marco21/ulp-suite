# Content-dedup mutation: safe deletion at scale

- **Date:** 2026-07-04
- **Status:** Approved (design)
- **Scope:** Make `lib/content-dedup.ts`'s DELETE mutation safe to actually enable (`CONTENT_DEDUP_APPLY=true`) against the current ~91M-row `ulp.credentials` table, on the existing daily-cron cadence. Does not change ingest-time behavior and does not build new schema.

## Problem

`lib/content-dedup.ts`'s own header comment said the DELETE mutation was "fine at the current ~20M rows; at billions, revisit." The table is now at 91,447,591 rows — 4.5x that assumption, en route to "billions."

Confirmed live (2026-07-04):
- The mutation's exact `CONTENT_DUPLICATE_PREDICATE` subquery (`SELECT min(FULL_HASH) FROM ulp.credentials GROUP BY CONTENT_KEY`, ~67M distinct content-key groups) exceeds 4 GiB in 1.6s for a single evaluation.
- `system.mutations` shows this DELETE has never actually run against this table (consistent with `CONTENT_DEDUP_APPLY` defaulting to `false` — report-only mode).
- ClickHouse mutations re-evaluate big-table subqueries per merge, per part — not once (each merge keeps its own HashSet in memory). This instance runs a ~20-thread background pool with a merge/mutation concurrency ratio of 3 (per `docs/superpowers/specs/2026-06-21-low-memory-t3-purge-design.md`), so a single 1.6s/4GiB evaluation could multiply substantially if run as a heavyweight mutation today.
- 24.6M of 91M rows (27%) are currently flagged as content-duplicates by the (safe) stats query.

If `CONTENT_DEDUP_APPLY` is ever set to `true` without addressing this, the daily cron would very likely crash the ClickHouse server rather than clean up duplicates.

## Background

Content dedup collapses exact `(url, email, password)` duplicates (scheme/trailing-slash-insensitive on the URL — see `lib/url-content-key.ts`) that arrive across different source files/import times. It cannot use `OPTIMIZE ... DEDUPLICATE BY` because ClickHouse requires that key to include the table's `ORDER BY`/partition columns, and `imported_at` being mandatory is exactly what keeps legitimate cross-import copies distinct.

Current mechanism: `runContentDedupTick()` (invoked daily by `lib/dedup-cron.ts`) runs a cheap `uniqExact`-based stats query, and — only when `CONTENT_DEDUP_APPLY=true` and excess duplicates clear `DEDUP_MIN_EXCESS` (default 1000) — submits `buildDeleteSql()`'s `ALTER TABLE ulp.credentials DELETE WHERE <predicate>` as an async mutation, guarded against double-submission via a `system.mutations` in-flight check.

## Investigation

All testing below is read-only (`SELECT`s bounded by explicit `max_execution_time`/`max_memory_usage`); no data was modified.

| Test | Result |
|---|---|
| `GROUP BY email` (39.4M distinct), capped at 4 GiB | **Fails** — exceeds 4 GiB |
| `countDistinct(email)` / `countDistinct(domain)` (the `/api/v1/summary` query, no cap override) | Succeeds, 3.7s — `uniqExact` doesn't retain per-group state, different cost profile than `GROUP BY ... ORDER BY count` |
| `lookup/batch` domain query against the hottest real domain (`accounts.google.com`, 3.86M rows) | Succeeds, 1.08s — `LIMIT BY domain` aligns with the table's actual leading primary-key column |
| Content-dedup stats query (`uniqExact`-based) at 91M rows | Succeeds, 5.16s |
| Exact `CONTENT_DUPLICATE_PREDICATE` subquery, capped at 4 GiB | **Fails** — exceeds 4 GiB in 1.6s |
| `GROUP BY domain, email, imported_at` (matches the table's actual `ORDER BY` prefix exactly), capped at 4 GiB, default settings | **Fails** — exceeds 4 GiB in 0.97s |
| Same, with `optimize_aggregation_in_order=1` explicit | **Still fails** — but takes 11.7s first, confirming the setting changes execution strategy without keeping it under a 4 GiB cap |
| Exact `CONTENT_DUPLICATE_PREDICATE` subquery with `max_bytes_before_external_group_by=4294967296`, no `max_memory_usage` override | **Succeeds**, 17.8s (disk spill) |

Key finding: matching the `GROUP BY` key to the table's sort order does **not** by itself avoid the memory cost (ruling out a "just reorder the GROUP BY" fix) — the fix has to come from bounding/spilling, or from restructuring what gets grouped.

Related finding (flagged, not fixed here): the ClickHouse profile (`docker/clickhouse/users/ulp-profiles.xml`) already sets `max_bytes_before_external_group_by=20 GiB`. The existing `lib/clickhouse-query-limits.ts`'s `exportGroupBySettings()` (used by `streamWordlist`/`exportHcmask`) sets `max_memory_usage=4 GiB` without lowering that spill threshold — meaning spill can never trigger before the 4 GiB hard cap does, for those routes. Password cardinality is 35.9M distinct (same order of magnitude as the email test that failed above), so this is plausibly a live, separate latent bug. Out of scope for this spec; worth its own follow-up.

Directly relevant precedent found in this codebase: `docs/superpowers/specs/2026-06-21-low-memory-t3-purge-design.md` documents this exact class of failure — a heavyweight `ALTER TABLE ulp.credentials DELETE` OOMing under this same ~20-thread background pool — and its shipped fix (`scripts/purge-existing-t3.sh`) switched to lightweight `DELETE FROM ... SETTINGS lightweight_deletes_sync=2, max_threads=2`. Confirmed this is actually implemented, not just designed.

## Approaches considered

**A — Settings-only fix on the existing heavyweight `ALTER TABLE ... DELETE`.** Smallest change, but heavyweight mutations still do full-part rewrites concurrently across the background pool; doesn't address the per-part multiplication risk from ClickHouse's own documented mutation behavior.

**B — Precomputed content-key survivor table (materialized view), following `mv_domain_counts`.** Eliminates the live subquery entirely by maintaining a small incrementally-updated lookup. The most robust long-term fix, but a real schema-change project: needs its own backfill design (which must itself avoid this same memory pitfall), and this codebase's existing MV tables of this shape aren't read from anywhere yet, so the read-path pattern is unproven here.

**C — Lightweight `DELETE FROM` + bounded `max_threads` + `max_bytes_before_external_group_by` (chosen).** Combines this codebase's own proven fix for the same class of problem (T3 purge) with the spill setting verified above. Bounding `max_threads` directly addresses the per-part-multiplication risk (fewer concurrent execution contexts each potentially re-evaluating the expensive subquery), and the spill setting bounds any single evaluation's memory.

## Decision

Ship C now. Treat B as a longer-term hardening step once C is live and its real-world mutation behavior has been observed, not before.

## Design

### SQL change

```sql
-- Before (buildDeleteSql()):
ALTER TABLE ulp.credentials DELETE WHERE <CONTENT_DUPLICATE_PREDICATE>

-- After (buildDeleteSql()) — no SETTINGS here, see "Settings consolidation" below:
DELETE FROM ulp.credentials WHERE <CONTENT_DUPLICATE_PREDICATE>
```

The full statement actually submitted (assembled in `runContentDedupTick()`):

```sql
DELETE FROM ulp.credentials WHERE <CONTENT_DUPLICATE_PREDICATE>
SETTINGS mutations_sync = 0,
         max_threads = 2,
         max_bytes_before_external_group_by = 4294967296
```

Deliberately **not** setting `max_memory_usage` on this statement — leaving it at the server/profile default is what lets the spill threshold actually get a chance to trigger before any hard cap. Setting a hard cap below the spill threshold is exactly the `exportGroupBySettings()` mistake found during investigation.

### Settings consolidation (correctness detail)

`runContentDedupTick()` currently appends `SETTINGS mutations_sync = 0` after calling `buildDeleteSql()` (string concatenation). If `buildDeleteSql()` also returned its own `SETTINGS` clause, the combined statement would have two `SETTINGS` keywords — invalid syntax. Fix: keep `buildDeleteSql()` returning just the bare `DELETE FROM ... WHERE ...` (matching its current no-settings shape), and consolidate all three settings (`mutations_sync`, `max_threads`, `max_bytes_before_external_group_by`) into the one clause built at the call site.

### Code changes

- `lib/content-dedup.ts`:
  - Add `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES = 4_294_967_296` (4 GiB) constant, matching the existing `EXPORT_GROUP_BY_MAX_MEMORY_BYTES` naming/magnitude pattern.
  - `buildDeleteSql()`: `ALTER TABLE ulp.credentials DELETE WHERE ...` → `DELETE FROM ulp.credentials WHERE ...`.
  - `runContentDedupTick()`'s submit line: fold `max_threads = 2` and `max_bytes_before_external_group_by = ${CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES}` into the existing `SETTINGS` clause alongside `mutations_sync = 0`.
  - `MUTATION_MARKER`'s value (`GROUP BY ${CONTENT_KEY}`) is unaffected by the `ALTER TABLE`→`DELETE FROM` change — the `GROUP BY` clause text inside the predicate doesn't change. Whether lightweight deletes populate `system.mutations.command` the same way heavyweight mutations do is **not yet confirmed** — see Verification below.

### Verification plan (before touching production data)

**Both items below are confirmed**, tested live (2026-07-05) against a disposable
`ulp.content_dedup_verify_test` table — a read-only `CREATE TABLE ... AS SELECT ... FROM
ulp.credentials LIMIT 2000000` copy, dropped after testing. `ulp.credentials` itself was never
written to, only read from (the `CREATE TABLE AS SELECT` and one row-count check, both plain
`SELECT`s).

1. **Does lightweight `DELETE FROM` combined with this subquery-based `WHERE` clause actually stay memory-bounded? Confirmed yes.** Red case: the exact `CONTENT_DUPLICATE_PREDICATE`-shaped `GROUP BY` against the 2M-row test table, capped at `max_memory_usage = 67108864` (64 MiB) with no spill setting, failed as expected — `Code: 241. DB::Exception: ... MEMORY_LIMIT_EXCEEDED` ("would use 70.25 MiB ... maximum: 64.00 MiB"), confirming the test data is large enough to genuinely stress the query at that threshold. Green case: the same predicate, same 64 MiB `max_memory_usage`, run as an actual `DELETE FROM ... SETTINGS lightweight_deletes_sync = 2, max_threads = 2, max_bytes_before_external_group_by = 67108864` (only the spill setting added), completed with no error. Isolating the spill setting as the only variable changed between the failing and succeeding run directly confirms `max_bytes_before_external_group_by` is what makes this combination memory-safe.
2. **Does the in-flight-mutation guard still work? Confirmed yes.** After the green-case DELETE, `system.mutations` showed one row for the test table with `is_done = 1` and `command` containing the exact substring `GROUP BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password` — `MUTATION_MARKER`'s literal value — confirming the existing `LIKE '%GROUP BY ...%'` in-flight check matches a lightweight-delete-produced mutation the same way it matched the heavyweight version. Worth noting for future readers: ClickHouse represents a lightweight `DELETE FROM` internally as `UPDATE _row_exists = 0 WHERE <predicate>` in `system.mutations.command` — the leading verb changes from the heavyweight version's `DELETE WHERE`, but `MUTATION_MARKER` only matches the `GROUP BY ...` tail of the command, so the check is unaffected by that internal representation change.

### Known limitation: exact full-tuple duplicates are not deduplicated (tie-breaking gap)

Found during the verification above, **not fixed by this plan, not introduced by this plan**:
`CONTENT_DUPLICATE_PREDICATE`'s `WHERE FULL_HASH NOT IN (SELECT min(FULL_HASH) ... GROUP BY
CONTENT_KEY)` shape does not break ties. When two or more rows within the same content-key group
are exact full-tuple duplicates (identical across `url`, `email`, `password`, `domain`,
`source_file`, `breach_name`, **and** `imported_at`), they all hash identically via `FULL_HASH`
and all equal that group's `min(FULL_HASH)` — so `NOT IN` is false for every one of them, and
**none get deleted**, not just all-but-one.

Evidence: in the 2,000,000-row disposable test table, Step 2's stats query reported `excess =
518939` (rows expected removable). After running the fixed lightweight DELETE, the table held
1,495,144 rows, not the expected `2000000 - 518939 = 1481061` — 14,083 more than expected. Re-running
the same `uniqExact`-based stats query against the post-delete table confirmed `distinct_creds`
was unchanged at `1481061` but `excess` was `14083`, not `0`. Grouping by the full 7-column tuple
and summing `(n - 1)` across groups with `count() > 1` yielded exactly `14083` — a complete,
exact match, with no unexplained remainder. Inspecting one such group directly showed 47 rows,
all sharing one `FULL_HASH` value, all from the same `source_file`/`imported_at` batch, with blank
`url`/`domain` and an apparent unsplit `url:username:password` triplet stuffed into `email` —
consistent with the mis-split-field import corruption this codebase's noise-handling work (see
recent `fix(noise)`/`fix(parser)`/`fix(credentials)` commits) has been separately hardening
against on the read/declutter side. That corruption is what makes exact full-tuple duplicates
reachable in practice; diagnosing or fixing the corruption itself is out of scope here.

Confirmed via `git diff` between the pre-this-plan commit and this plan's shipped `lib/content-dedup.ts`
that `CONTENT_DUPLICATE_PREDICATE`, `FULL_HASH`, and `CONTENT_KEY` are byte-for-byte unchanged by
this plan's `ALTER TABLE ... DELETE` → `DELETE FROM` change — this tie-breaking behavior is a
pre-existing property of the predicate itself. It was never previously observed because, per the
Problem section above, `system.mutations` shows this DELETE had never actually run against real
data before this verification.

**This does not block enabling `CONTENT_DEDUP_APPLY`** — it is not a memory-safety or crash risk,
which is what this plan exists to address, and both verification items above are unaffected by it.
It does mean dedup will not reach 100% for this specific edge case: rows that are exact full-tuple
duplicates of each other will persist indefinitely, and the stats-reported `excess` will never
reach zero while such rows exist, regardless of how many times the DELETE runs. A follow-up (e.g.
a stable tiebreaker such as `argMin` over a deterministic column, or a `LIMIT 1 BY`-based approach)
is tracked separately and is not part of this plan.

### Rollout plan

1. Ship the code change. `CONTENT_DEDUP_APPLY` stays `false` — no functional/behavioral change yet, purely SQL-construction.
2. Run the verification plan above against disposable data.
3. Only then, deliberately enable `CONTENT_DEDUP_APPLY=true` in production. Confirm the first real run: no `MEMORY_LIMIT_EXCEEDED` in server logs, the mutation reaches `is_done=1` in `system.mutations` within a reasonable window rather than staying queued, and the post-run stats query's `excess` drops by roughly the count that was reported before the run (allowing for new imports landing concurrently).

### Testing

- Unit test (matching this codebase's `readFileSync` + `toContain` source-assertion style) asserting `buildDeleteSql()` produces `DELETE FROM` (not `ALTER TABLE ... DELETE`), and that the assembled submit statement contains all three settings.
- Confirm existing `__tests__/content-dedup.test.ts` and `__tests__/dedup-cron.test.ts` (env-knob functions, unaffected by this change) still pass.

## Out of scope

- Approach B (materialized-view content-key survivor table) — deferred to a follow-up once C has run in production.
- The `exportGroupBySettings()` spill-threshold-ordering issue affecting `streamWordlist`/`exportHcmask` (35.9M distinct passwords) — flagged during this investigation, not fixed here.
