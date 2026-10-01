# Credential Dedup Reconciliation Design

## Objective

Consolidate the credential-deduplication landscape on `ulp.credentials` — currently four independent, overlapping mechanisms plus four dead aggregate tables — into one supported path, cut it over from report-only to actually reclaiming disk space on the live ~2.4B-row table, and do it without silently discarding data that matters. "Matters" is not assumed — it's checked empirically against the live table throughout this doc, per this project's own precedent of verifying ClickHouse behavior against the real instance rather than reasoning about it in the abstract.

## Confirmed Requirements

- Disk reclaim and query/scan performance are the actual drivers (confirmed by the user 2026-09-28), not just Credentials Browser UX — the non-destructive "Unique" view toggle already solves the UX-duplication-annoyance problem without deleting anything, so a destructive mechanism needs its own justification. It has one: `ulp.credentials` is 381.20 GiB on a disk at 71.5% used (266.75 GiB free of 936.79 GiB total — live-checked 2026-09-28), and content-dedup's own rewrite-swap approach needs headroom to build a second near-full-size copy before swapping.
- Content-dedup (`lib/content-dedup.ts` + `lib/dedup-cron.ts`) is the adopted long-term mechanism (reconciliation decision, 2026-09-28), superseding the `credential_dedup_meta` backfill approach.
- The disk-headroom guard (merged 2026-09-28, commits `85ad9f7`/`d41dd49`/`7ebacae`) is wired into content-dedup's populate step and is the last structural blocker that's now cleared.
- Cutover happens via one supervised, watched manual run before the daily cron is armed for unattended operation — not by flipping `CONTENT_DEDUP_APPLY` and letting the first-ever real run happen unsupervised.
- The supervised run reuses content-dedup's own guarded, bucketed code path (`runContentDedupTick`) rather than the separate, unguarded `scripts/dedup-credentials-content.sh`, so there is exactly one implementation of the safety-critical logic, not two that can drift.
- Recurring daily cron cadence (unchanged from content-dedup's existing default: 04:00 UTC, every `DEDUP_CRON_HOURS`) is acceptable once the supervised run is verified — confirmed by the user, disk isn't in a crisis state today.
- A `was_duplicated` boolean is added to `ulp.credentials`, computed accurately against the full historical backlog on the first run — not a numeric count. Precise counts (raw row count or distinct-`source_file` count) are rejected: see "Repackaging" finding below.
- `ulp.credential_dedup_meta` + `scripts/backfill-credential-dedup.sh` are dropped/deleted after cutover is verified — confirmed cross-source lineage has no analytical value here once `breach_name` (confirmed empty) and `domain` (confirmed stable) are accounted for.
- `app/api/admin/dedup/route.ts` is deleted — confirmed orphaned dead code, not a live alternative mechanism.
- `scripts/dedup-credentials-content.sh` is deleted once the new one-off script exists — a third redundant implementation of the same job, and the one that was never given the disk guard.
- The four dead materialized-view aggregate tables (`domain_counts`, `password_counts`, `url_host_counts`, `reuse_pairs`) and their MVs are dropped as part of this same effort (folded in by user decision 2026-09-28) rather than as separate follow-up work.

## Current State (verified live, 2026-09-28)

### Four mechanisms found, one adopted

| Mechanism | Scope/key | Status |
|---|---|---|
| `lib/content-dedup.ts` (cron, `lib/dedup-cron.ts`) | `(url_normalized, email, password)` — cross-source | **Adopted.** Disk-guarded, bucketed, rewrite-swap. Enabled/scheduled by default in prod, but `CONTENT_DEDUP_APPLY` has always been `false` — it has never actually deleted anything anywhere. |
| `scripts/dedup-credentials-content.sh` | Same key as above, own `_cdedup`/`_predup` tables | README's documented "verified" manual tool, but a **separate implementation**: single unbucketed `INSERT...SELECT` for all 2.4B rows, 30-minute timeout, no disk-headroom check at all. To be retired. |
| `scripts/backfill-credential-dedup.sh` (`ulp.credential_dedup_meta`) | `content_key_hash`, scoped to preserve per-source/per-import distinctness | Dry-run only, never scheduled. Confirmed 49.84% dupes / 1.38B rows (2026-09-26). Superseded; its narrower key is fully subsumed by content-dedup's broader one. To be retired. |
| `app/api/admin/dedup/route.ts` | `OPTIMIZE...DEDUPLICATE BY (domain, email, imported_at, url, password, source_file)` — exact full-row match | **Orphaned dead code.** Predates content-dedup entirely (created in `c9dd498`, last touched only to strip an unrelated import in `a616ac9`). Two existing tests (`__tests__/pagination-import-docs.test.ts:18`, `__tests__/ulp-parser-stream.test.ts:20-23`) already assert the README/parser guidance should *not* reference it — one literally names it "the removed admin endpoint" — confirming the team's intent was full removal; only the code itself was left behind. Its exact-match key is a strict subset of content-dedup's key, so it catches nothing content-dedup doesn't already catch. To be deleted. |

### Correctness verification: what survives the collapse

`ulp.credentials` has exactly 7 real (non-`MATERIALIZED`) columns: `url, email, password, domain, source_file, breach_name, imported_at`. The other 12 (`tld`, `country_tier`, `login_type`, `password_mask`, `url_host`, `is_noise`, `content_key_hash`, etc.) are pure deterministic functions of those 7, so they cannot independently carry lost information beyond what's checked below. Content-dedup's survivor selection (`LIMIT 1 BY CONTENT_KEY`, keeping earliest `imported_at`) was checked against each:

- **`url`, `email`, `password`** — these *are* the dedup key (post scheme/trailing-slash normalization, per the 2026-06-28 `URL_CONTENT_KEY` design). Identical across every row in a group by definition; nothing to lose.
- **`breach_name`** — checked live: a 1%-hash-bucket sample (`WHERE content_key_hash % 100 = 0`, 27,786,160 rows) has exactly **one** distinct value across the entire sample: empty string. `breach_name` is set by `matchBreach(filename)` (`lib/breach-matcher.ts:127`), which is only wired into the interactive `app/api/upload`/`app/api/v1/upload` routes — whatever bulk process loaded this dataset never populated it. There is nothing to lose because there is nothing there. (Separately flagged as its own out-of-scope gap — see spawned task `task_2e886a49`.)
- **`domain`** — checked live: of 5,824,714 duplicate groups in the same 1% sample, only **126 (0.0022%)** show more than one `domain` value. Inspected all 126: not genuine distinct-credential collisions, but two pre-existing `extractDomain()` parser inconsistencies (Android app "token@package" URLs like `...==@com.netflix.mediaclient`, and colon-ambiguous garbled lines) that already produce unreliable `domain` values independent of dedup. Dedup doesn't cause this; it just picks one of two already-imperfect parses.
- **`source_file`** (97.0% of sampled duplicate groups have more than one) and **`imported_at`** (earliest kept) — expected, explicitly-documented tradeoffs going back to `content-dedup.ts`'s own header comment and the original `dedup-credentials-content.sh` design. Confirmed acceptable (lineage has no standalone analytical value here — see Repackaging below).
- **`url_scheme`/`tld`/`url_host`** (all `MATERIALIZED` from the *raw*, non-normalized `url`) — minor, already-reviewed exception: a group mixing `http://`/`https://` variants of the same page keeps whichever scheme the survivor happened to use. This is the deliberate, already-approved point of the 2026-06-28 `URL_CONTENT_KEY` design, not a new gap.

### Repackaging: why frequency needs a boolean, not a count

Investigated because `source_file` diversity (97% of duplicate groups) initially looked like it might mean genuine multi-breach/multi-source prevalence worth counting. Empirically it doesn't: a self-join on the same 1% sample, pairing files that share duplicate credentials, shows file pairs like `DUMP ULP 12.07.2026 Base34 7.txt` / `...Base34 8.txt` sharing 664,564 credentials — in a 1% sample alone. Distributor "brands" (`AMRTECH-TXTLOG-ULP-FREE`, `StarX Cloud`, `@SKYULP PRIVATE ULP`, `@AhegaoCloud`) show comparable overlap with each other and with the `Base34` series. This is the stealer-log ecosystem's well-known repackaging pattern: the same underlying collection gets rechunked and re-released under new filenames repeatedly. Consequently:

- **Raw duplicate row count** would be dominated by repackaging churn, not genuine independent sightings.
- **Distinct `source_file` count** is less bad but has the identical flaw — it counts relabeled copies of the same leak as if they were independent.
- A trustworthy independent-sightings count would require file-level repackaging-cluster detection (grouping near-duplicate files before counting) — a materially bigger, separate effort, explicitly out of scope here (see Out of Scope).
- **Decision:** `was_duplicated UInt8 DEFAULT 0` — a boolean that says "this credential was not unique" without claiming a precision the data can't support.

### Dead materialized views (folded in 2026-09-28)

`domain_counts`, `password_counts`, `url_host_counts`, `reuse_pairs` and their four `mv_*` materialized views: zero references anywhere in `app/` or `lib/` outside `lib/clickhouse-migrations.ts` itself. Migration `v10`'s own comment confirms why — they backed `/api/reuse`, `/api/stats`, `/api/admin/rebuild-mv`, all already deleted from the app. `v11` exists specifically to retry `v10`'s drop after it partially failed during the 2026-06-12/13 incident (broken parts on `domain_counts` at the time).

Live-checked 2026-09-28: this instance's `ch_ddl_version` is **20** (`./data/ulp.db`, `app_settings` table) — `v11` should long since have run — but all 8 objects are still live and healthy (no detached/broken parts, ruling out a repeat of the original incident):

| Table | Rows | Size |
|---|---|---|
| `domain_counts` | 16,456,862 | 250.07 MiB |
| `password_counts` | 140,152,948 | 1.83 GiB |
| `reuse_pairs` | 123,858,542 | 3.11 GiB |
| `url_host_counts` | 25,629,317 | 473.33 MiB |

**~5.66 GiB total**, plus all four MVs still firing (aggregation work) on every single credential insert, for outputs nothing reads. Root cause of `v11`'s silent no-op is unconfirmed — the original failure mode doesn't apply (tables are healthy now), so this needs its own diagnosis during implementation, not a re-run of the same drop statements on faith.

**Separately confirmed (empirical test, disposable `ulp.test_mv_*` objects, cleaned up after):** a `TO`-style materialized view *does* survive content-dedup's exact rename-swap pattern (`RENAME TABLE live TO old, new TO live`) mechanically — inserts into the post-rename table still fire the MV correctly, tested against this instance's ClickHouse 26.3.17. This means content-dedup's swap does not orphan any MV it needs to keep working (none exist post this cleanup, but confirms the mechanism is sound in general, and rules out one hypothesis for why `v11` didn't take effect).

## Design

### 1. Consolidation target

One mechanism (`lib/content-dedup.ts`'s bucketed, disk-guarded rewrite-swap), two trigger paths:
- **Scheduled:** existing `lib/dedup-cron.ts`, unchanged cadence, armed by setting `CONTENT_DEDUP_APPLY=true` after cutover is verified.
- **Manual:** new `scripts/run-content-dedup-once.ts` — imports and calls `runContentDedupTick({ trigger: 'manual' })` (`lib/content-dedup.ts:497`), the exact function the cron calls. `contentDedupApplyEnabled()` reads `CONTENT_DEDUP_APPLY` from `process.env` at call time, so dry-run vs. apply is just whether that variable is set for the invocation — no new flag plumbing needed.

### 2. `was_duplicated` flag

- New column: `ALTER TABLE ulp.credentials ADD COLUMN was_duplicated UInt8 DEFAULT 0` (new `clickhouse-migrations.ts` DDL version, following the existing `breach_name`-style column-add pattern at line ~205).
- Populate step (`buildPopulateDedupedTableSqlForBucket`, `content-dedup.ts:316`) changes from `SELECT * FROM ulp.credentials ORDER BY ... LIMIT 1 BY CONTENT_KEY` to additionally compute, per group: `greatest(was_duplicated, if(count() OVER (PARTITION BY <content key columns>) > 1, 1, 0)) AS was_duplicated`, applied via `SELECT * REPLACE(...)` so every other column keeps today's behavior. The `greatest(...)` against the existing survivor's own `was_duplicated` value is what makes this cumulative and cycle-agnostic — once true, always true, regardless of how many cycles have run or whether a given cycle sees a new duplicate for that credential.
- **Unverified, flagged honestly:** the exact interaction between a window function (`OVER (PARTITION BY ...)`) and `LIMIT n BY` in one ClickHouse query needs to be confirmed against the live instance during implementation, the same way the 2026-06-28 spec verified its regex before relying on it. Fallback if it doesn't compose cleanly: a per-bucket aggregation subquery (`content_key_hash, count() > 1 AS dup`) joined back into the row-selection query — more SQL, same bucket-by-bucket shape the rest of the populate step already uses.
- Because this is a per-row flag, not a row-count change, the existing verification invariant (`AUTO_DEDUP_TABLE` row count must equal `uniqExact(cityHash64(CONTENT_KEY))` of the source) is unaffected.
- First run computes this accurately for the ~1.38B+-row historical backlog as a side effect of the same full-table scan the populate step already does — no extra pass required (confirmed cheap; this was the user's explicit requirement once a boolean, not a count, was chosen).

### 3. Cutover sequence

1. Ship the `was_duplicated` column migration and the updated populate-step SQL.
2. Run `scripts/run-content-dedup-once.ts` without `CONTENT_DEDUP_APPLY` — dry-run, reports `total`/`excess` only.
3. **Sanity gate (hard):** excess-row percentage must be ≥ 49.84% (the `credential_dedup_meta` figure from 2026-09-26 — content-dedup's key is a superset, so its number should be equal or higher). If this fails, stop and investigate before proceeding.
3b. **Sanity check (judgment call, not an automated threshold):** re-run the domain-variance-within-groups query from the Current State section above and compare against the measured 0.0022% baseline. This is a human-reviewed spot-check, not a bright-line gate — there's no principled exact cutoff, just "does this still look like the same negligible parser-noise pattern, or has something changed." A materially higher number (not just noise around 0.0022%) is worth investigating before proceeding.
4. Run again with `CONTENT_DEDUP_APPLY=true` set for the invocation — the real, watched, first-ever apply. Disk guard preflight + per-bucket checks are live since this is the same code path as the cron.
5. Verify: row count in `ulp.credentials`, spot-check the browser/API, confirm `ulp.credentials_predup_auto` (automatic rollback archive) exists, confirm the `proj_imported_desc` projection is present and functioning on the new table (e.g. via `SHOW CREATE TABLE` and the same `force_optimize_projection=1` technique migration `v14` used to confirm the projection actually gets matched). *(Amended 2026-09-30: the deduped copy is built without projections and `proj_imported_desc` is restored after the swap; `proj_domain_reversed` is intentionally retired — see "Amendments from the live cutover" below.)*
6. Set `CONTENT_DEDUP_APPLY=true` in `.env` so the daily cron takes over unattended from here on.
7. Legacy cleanup (only once the above is verified good — these are all things this design's own correctness depends on being superseded, so wait for proof):
   - Drop `ulp.credential_dedup_meta`, delete `scripts/backfill-credential-dedup.sh`.
   - Delete `app/api/admin/dedup/route.ts`.
   - Delete `scripts/dedup-credentials-content.sh`; repoint README (~lines 146-150, 221-222, 276-280) and `lib/ulp-parser.ts`'s dedup-cap guidance string at `scripts/run-content-dedup-once.ts`; update (not delete) `__tests__/pagination-import-docs.test.ts:18` and `__tests__/ulp-parser-stream.test.ts:20-23` to pin the new script name — they're exactly the regression guard this kind of doc/code drift needs, per the admin-route lesson above.
8. Fix doc bookkeeping: the disk-guard spec's "Approved, not yet implemented" header (`2026-09-28-clickhouse-disk-headroom-guard-design.md:4`) and its plan's unchecked boxes, now that it's shipped.

**Independent of the above** (no functional dependency on the cutover — can happen before, during, or after in any order): drop `domain_counts`, `password_counts`, `url_host_counts`, `reuse_pairs` and their 4 MVs. Diagnose why `v11` silently no-op'd before assuming a re-run of the same statements will succeed this time — add visible logging/error surfacing around the drop this time rather than the same non-fatal swallow that already masked one failure (`v10`'s). This is bundled into this same design/spec because it shares this effort's motivation and was folded in by explicit decision, not because it depends on anything else here.

## Error Handling and Data Safety

- Disk guard (fail-closed preflight + per-bucket check, floor = `max(50 GiB, 15% of total)`) already covers the populate step's own disk risk — unchanged by this design.
- Automatic rollback archive (`ulp.credentials_predup_auto`) is created on every apply cycle, cron or manual, before this design and after it.
- `tickInFlight` re-entrancy guard prevents the new manual script and a concurrently-firing cron tick from racing.
- The `was_duplicated` computation only touches the survivor row's own value; it cannot change which row survives or the row-count verification already in place.
- Legacy cleanup (step 7 above) only happens after step 5's verification passes — nothing is deleted on the assumption the cutover will work.
- The dead-MV drops are all `IF EXISTS` (idempotent), matching `v10`/`v11`'s own pattern — but this design explicitly calls for *not* trusting a silent non-fatal catch this time, given that pattern already masked one real failure.

## Testing

- `scripts/run-content-dedup-once.ts`: no dedicated test, consistent with this repo's convention for operator scripts (`dedup-credentials-content.sh` had none either) — verified via its own dry-run output, same as every other operator script here.
- New test coverage for the `was_duplicated` computation in `buildPopulateDedupedTableSqlForBucket`'s SQL-generation tests (same pattern as existing `content-dedup.test.ts` substring assertions).
- Update `__tests__/pagination-import-docs.test.ts` and `__tests__/ulp-parser-stream.test.ts` per step 7 above.
- `npx tsc --noEmit` clean.
- Live verification (not unit-testable): the sanity gate in cutover step 3, and the projection-survival check in step 5.

## Deployment and Operations

Normal `app`-only rebuild for the schema migration and populate-step change:
```bash
cd ~/ulp-suite
git pull && docker compose up -d --build app
```
The cutover script and legacy-cleanup steps run manually per the sequence above — this is a deliberate, watched, one-time operation, not something that ships and runs itself.

## Amendments from the live cutover (2026-09-30)

The first real runs against the 2.78B-row table changed the design in two places and corrected one assumption. The design-relevant outcomes come first; the numbered detail and measurements are under "Detail and measurements" below.

- **Projections are deferred, not cloned.** They were 64% of the table (243 of 381 GiB) and made the build ~2.5x larger than it needs to be (~288 GiB vs ~114 GiB), which the disk guard correctly refused. The clone carries the base table and all skip indexes only; `proj_imported_desc` is restored on the live table after the swap, within the existing `lib/projection-scope.ts` recency window. A projection is a redundant derived copy, so nothing is lost — only query speed until the restore finishes.
- **`proj_domain_reversed` is retired.** The "both projections present" expectation in step 5 was wrong: only this instance has it (an abandoned 2026-08-25 experiment — no migration defines it), and it makes the domain monitor's `email_domain` query ~6x slower. Bring-back command is in item 6 under "Detail and measurements".
- **The catch-up step could not have worked at this scale** and was rewritten to probe the live table with the candidate keys instead of building a set of every key (in-memory IN-sets have no disk spill; 1.39B keys needs ~34 GB against an 18 GiB limit).

### Detail and measurements

These were first recorded as amendments in the implementation plan, which was removed from the tree on 2026-10-01 (`git show ad4e3a8:docs/superpowers/plans/2026-09-28-dedup-reconciliation.md`); the items are moved here unchanged. Task 3's attempts against the real 2.78B-row table surfaced problems that were invisible from the code alone. Every item below was confirmed against the live container, and each changes what the plan's Tasks 3-4 expected.

1. **Stats / verify queries** (`830c7b3`, `44fe3c7`). The 200-bucket loops cost ~107 s per bucket because `cityHash64(...) % N = i` is unprunable, so every bucket was a full scan: ~6 h per pass, twice per tick. Replaced by one `GROUP BY content_key_hash` pass (101 s, 11.4 GiB peak, identical result: total 2,778,102,283, distinct 1,393,449,551); timeout raised to 900 s.
2. **Populate** (`7748ef9`). The `ORDER BY … LIMIT 1 BY` sort hit MEMORY_LIMIT_EXCEEDED even unbucketed, and 200 buckets projected to ~28 h. Replaced by `argMin` + `GROUP BY` over 16 buckets at `max_threads = 6`.
3. **Disk guard projection** (`c005ba0`). It extrapolated free-space delta, which mixes real growth with ~30 GiB/bucket of non-compounding transient overhead, so it over-projected regardless of headroom. It now projects from the target table's own `bytes_on_disk`.
4. **Cleanup pulled forward.** Task 5's dead-table drops and `credential_dedup_meta` (124 GiB) were applied by hand on 2026-09-29 to free cutover headroom, and codified in migration v22 (`28f58e4`). Task 4's "drop the legacy table" step (Step 7) is therefore already done.
5. **Deferred projections.** Projections are 64% of `ulp.credentials`' 381 GiB (`proj_imported_desc` 157.55 GiB, `proj_domain_reversed` 85.21 GiB, column data 82.33 GiB, skip indexes 56.10 GiB). Building the deduped copy with them cost ~18 GiB per populate bucket (~288 GiB) against ~252 GiB of usable headroom, so the guard tripped on every attempt. The clone is now created **without** projections (measured on a real bucket: 7.10 GiB, ~114 GiB total) and `proj_imported_desc` is restored on the live table after the swap and catch-up, newest partition first, within `lib/projection-scope.ts`'s recency window, behind the disk guard (`lib/credentials-projections.ts`). Measured on a 1/16 sample: ADD PROJECTION 0.2 s, MATERIALIZE ~5 min, planner selects it (`force_optimize_projection = 1`). A failed restore never drops the live table and never flips the result to `applied: false`; `scripts/run-content-dedup-once.ts --restore-projections` retries it.
6. **`proj_domain_reversed` is retired, not restored.** No migration defines it (v19 replaced the `reverse(domain)` projection with `idx_ngram_domain`, so a fresh install never has it — only this instance does, from an abandoned 2026-08-25 experiment), and it is counterproductive: the domain monitor's `SELECT DISTINCT email_domain … LIMIT 1001` (`max_execution_time = 90`) makes the planner pick it as a thin covering copy and scan all 2.78B rows — 41 s / 21.12 GiB (75 s in the app's own runs) — where the base table's ngram skip index prunes to 404M rows: 7 s / 3.39 GiB with an identical result set (same count and value hash). **Task 3 Step 5's projection check therefore expects 1, not 2.** To bring it back: `ADD PROJECTION proj_domain_reversed (SELECT url, email, password, domain, email_domain, imported_at ORDER BY reverse(domain))`, then `MATERIALIZE PROJECTION`.

   **Measured after the cutover (2026-09-30):** on the new table the same query takes 22 s — the planner now picks `proj_imported_desc` as the thin covering copy and scans all 1.39B rows (10.6 GiB) — versus 9 s / 545M rows with `optimize_use_projections = 0` for that query alone. So the quirk is not specific to the retired projection: for this query shape the planner prefers *any* narrow covering projection over the base table's skip indexes. Recommended follow-up (not done here — outside the dedup scope): add `optimize_use_projections = 0` to the `SETTINGS` of the candidate scan in `lib/monitor-match-resolver.ts` (~line 259).
7. **Catch-up rewrite.** `buildCatchupInsertSql`'s `NOT IN (SELECT cityHash64(…) FROM ulp.credentials)` builds an in-memory hash set of every distinct key. At 1.39B keys it failed live with MEMORY_LIMIT_EXCEEDED ("would use 28.73 GiB", limit 18 GiB) — and it runs *after* the swap, so it would have failed at the end of a ~2 h cutover. It now probes the live table with the (tiny) set of candidate keys: 77 s / 628 MiB on the same probe, inserting identical rows to the old form on tables built from the real schema.
8. **The deployed app image predates all of the above** (built 2026-09-28): its report-only cron still ran the 200-bucket stats loop and hit the old 300 s timeout. Step 6's rebuild is what ships the fixes.
9. **Dropping the managed tables needs `max_table_size_to_drop = 0`.** ClickHouse refuses to DROP a table over 50 GB (server default, unchanged here) with Code 359, and both tables the tick manages are far past that — the archive is 381 GiB, a later cycle's ~185 GiB. Found 2026-09-30 while writing the archive-drop instructions: the tick's step 2 (drop the previous archive), step 3, and both cleanup paths were bare `DROP TABLE … SYNC`, so after this cutover every applying run would have died at step 2 and the cron could never rebuild again (the real cutover never hit it because the archive did not exist yet). Confirmed live: a bare DROP under a too-small limit errors and leaves the table; the `SETTINGS max_table_size_to_drop = 0` form drops it. All four now go through `buildDropTableSql`, and a failing cleanup drop can no longer mask the disk guard's own error. A manual drop of the archive needs the same override: `DROP TABLE ulp.credentials_predup_auto SYNC SETTINGS max_table_size_to_drop = 0`.

## Out of Scope

- File-level repackaging-cluster detection (grouping near-duplicate source files before counting) — would be needed for a trustworthy numeric "independently observed N times" signal. Bigger, separate effort; revisit only if genuine prevalence analytics become a real requirement.
- Backfilling `breach_name` for the bulk-imported dataset, or wiring `matchBreach()` into whatever bulk-import path is actually used — confirmed broken/unused, but unrelated to dedup correctness. Flagged separately (`task_2e886a49`).
- Changing survivor-selection logic (still earliest `imported_at`) or the `(url, email, password)` content-key definition — unchanged, out of scope per the original 2026-06-28 design too.
- Root-causing *why* `v11`'s drop silently no-op'd beyond what's needed to ship a working retry — full forensics on the exact ClickHouse-side mechanism isn't required to fix it, just enough to avoid masking a third failure the same way.
