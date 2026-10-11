# Novelty-aware ingest — design (2026-10-02, revised 2026-10-11)

Status: **approved 2026-10-11 (revised from the 2026-10-02 proposal), not implemented.** Sub-project 2 of the 2026-10-11 plan (sub-project 1,
`2026-10-11-disk-safety-and-hygiene-design.md`, shipped the same day; the import-reliability work it builds on is
`2026-10-02-import-reliability-design.md`).
Reference table: `ulp.credentials`, 1,394,459,025 rows, 128.88 GiB (about 99 bytes per row on disk), ordered by `(domain, email, imported_at)`.
Every timing below is cold (query cache and condition cache off) on the one 16-thread laptop, against the live server, using throwaway
`ulp.zz_*` tables that were dropped afterwards (live row counts identical before and after). The operator's file names and channel names are
deliberately absent (the repository is public).

## Revision 2026-10-11: what changed since the proposal

1. **The need is measured.** About 140 GiB of downloads (503 `.txt` files) are waiting to be imported. A read-only probe of 44 of the 483
   candidate files found **61% of the sampled rows already in the table** (see "The download pile").
2. **Monitor alerts are matched in ClickHouse on the stage**, one SQL query per monitor per slab, not by streaming new rows back to Node.
3. **No ClickHouse schema change.** `ulp.sources.known_count` is dropped (the Inbox job log carries the same number); only SQLite gains a column.
4. **Stage tables are `ulp.zz_import_stage_<id>` and `ulp.zz_import_known_<id>`**, so the backup script's existing `zz_*` exclusion covers them.
5. **The gates and the clock.** The SP1 disk gate already covers every staged batch; the commit adds one disk and one memory gate call per slab,
   a heartbeat after every statement, and its own `max_execution_time` on every statement (the client default is 60 s).
6. **Owner decision D6:** once this ships, the nightly dedup is report-only (`CONTENT_DEDUP_APPLY=false`).

## The problem: the importer stores what it already has

- The insert path keeps every row whose batch bytes differ. The batch dedup token hashes `source_file` on purpose
  (`lib/upload-dedup.ts`), so the same credential arriving in another file is inserted again. Nothing in the importer asks whether the
  credential is already in the table.
- The scheduled content-dedup (`lib/content-dedup.ts`) undoes that later, keeping the **earliest `imported_at` per
  `content_key_hash`** (`argMin(col, imported_at)`). At the 2026-09-30 cutover it removed **50%** of the table (2.78B -> 1.39B rows).
  It only applies once the excess reaches `DEDUP_MIN_EXCESS` (14M rows) and each apply is a multi-hour rewrite that needs a second copy of
  the table. Its step 2 drops the previous archive (`credentials_predup_auto`, 381 GiB, the only pre-dedup copy) **before** the disk guard's
  preflight, so an import that leaves 14M duplicates makes the next armed tick drop the archive and rewrite the whole table unattended.
- The pending Telegram file in `inbox/failed/` (a 77 MB `.08` file from 2026-05-31) shows what that costs: 1,336,290 lines ->
  1,058,060 importable -> **1,053,269 distinct credentials, of which 1,053,228 (99.996%) are already in the table** (spread over 77
  imported files, 692,921 of them in a single one); **41 are new**. Importing it would add about 100 MB of rows that the next dedup
  would delete.
- Retries are not exactly-once. ClickHouse's block dedup window is 3600 s / 10000 blocks, so a half-imported file retried after more than
  an hour re-inserts the batches that already landed. That is why the inbox sweep says "may be partially imported; review before re-adding".
- In-file dedup is a per-file JS `Set` capped at 2M entries (about 440 MB of heap per concurrent file); past the cap a file has no in-file
  dedup (`lib/ulp-parser.ts`, `STREAM_SEEN_CAP`).
- `recordSource` runs only when a file added rows (`imported > 0`), so a fully-known file is never recorded and the same-name guard
  cannot stop its re-upload.
- The operator cannot tell how much of a file was new: `imported` counts rows inserted, `skipped` counts parse rejections.

## Goals

1. Insert only credentials that are not already in `ulp.credentials`, identified by the table's own `content_key_hash`. First-seen wins,
   the same survivor content-dedup would keep.
2. Exactly-once by content on retry or resume, independent of the 1-hour dedup window.
3. Every finished import reports **new / already known / duplicate within the file** (SSE, `processing_jobs`, upload page, inbox monitor).
4. Exact in-file dedup for any file size, and the 440 MB-per-file heap `Set` is gone from this path.
5. Monitor alerts only for new credentials, matched in ClickHouse.
6. A fully-known file is still recorded in `ulp.sources` (0 rows added), so the same-name guard catches its re-upload.
7. No change to the `ulp.credentials` schema, search, or the dedup cron's code (it stays as the reconciliation net, report-only).

Not goals: remembering *which other files* a known credential appeared in (decision D1 below); a preview / dry-run screen (phase B, below);
changing the same-name re-upload guard; making the parser faster; any ClickHouse DDL.

## Measurements (all on the live server)

| What | Result |
|---|---|
| Existence check, strategy A: `content_key_hash IN (stage hashes)`, one-column scan of the live table | **10.7 s cold, 9.9 s warm**, reads 10.4 GiB (1,395,517,085 rows) for the 1.06M-row file |
| Same, pruned by `domain IN (...)` first | 13.8 s |
| Same, pruned by `(domain, email) IN (...)` | 36.0 s |
| Parse + insert into a plain MergeTree stage (no projections, no skip indexes) | 26.0 s for 1,058,060 rows |
| `INSERT ... SELECT` stage -> clone of the **live DDL** (19 skip indexes, 3 projections) | 1,058,060 rows in **10.2 s = 103k rows/s**, identical at `max_insert_threads` 1 / 4 / 8 (measured WITHOUT `LIMIT 1 BY`: see Risks) |
| Today's direct CSV stream, one file | 31-33k rows/s (per-100k insert p50 2.2 s, p95 3.6 s) |
| Direct CSV stream, N concurrent files | 1 -> 32.8k, 2 -> 51.1k, 3 -> 61.7k, 4 -> 69.7k, 6 -> 80.9k rows/s |

Strategy A is the only one that does not get slower when the probe set is large: the cost is the hash column's size, not the number of
probes, so one scan answers a whole file (and could answer several staged files together). Estimated wall time for a 1M-row file from the
measured parts (to be confirmed end to end in the first plan task): fully novel about 46 s (+50% over the direct 31 s), half known
about 41 s, fully known about 36 s with nothing written to the table.

### The download pile (2026-10-11, read-only)

503 `.txt` files, 140.2 GiB; 20 of them (7.8 GiB) already have their name in `ulp.sources` (the same-name guard skips them), leaving 483
candidates (132.4 GiB: 12 files over 3 GiB = 44.9 GiB, 36 of 1-3 GiB = 42.6, 161 of 0.1-1 GiB = 43.1, 47 of 10-100 MiB = 1.7, the rest
smaller). The probe parsed 66 slices of 2 MiB from 44 files with the importer's own `parseULPStream` and the live ingest policy
(`INGEST_FILTER_HARD_DROP_TIERS=T3`), hashed the 1,688,215 importable rows with the table's own `content_key_hash` expression and checked
them against `ulp.credentials` (16 s for the whole probe):

| | Result |
|---|---|
| Sampled rows already in the table | **61.1%** (1,032,082 of 1,688,215) |
| Per file | 0-100%: of 44 files, 9 are 95% or more known, 17 are 50-95%, 15 are 5-50%, 3 are new |
| Whole pile, ratio-estimated per size stratum | about 1.68B importable rows, about 0.67B (40%) not in the table; 40% is an upper bound (duplicates between pile files were not measured) |
| Stored cost at 99.2 bytes per row | **raw import about 156 GiB** (table x2.21, about 1B duplicate rows left for the dedup) vs **new rows only about 62 GiB** (x1.48) |
| Time at 30-51k rows/s | about 9-15 h either way: the parser is the limit, so the filter saves disk and the table rewrite, not parse time |

Row density per byte varies about tenfold between files (some are mostly junk lines), so the estimate is in rows, not bytes.

### Importer facts verified in code (2026-10-11)

- Every import path (the HTTP route, the v1 API, the inbox watcher, each entry of a ZIP) reaches `processTextStream` in
  `lib/upload-processor.ts`: one integration point.
- Monitor alerts already filter against SQLite's `monitor_credential_seen` ledger (`fireMonitorAlertsFromMatches`), and
  `lib/domain-match.ts` has SQL builders (`buildDomainSetWhereClause`) with the same semantics as the in-process matcher; they read only the raw
  `url`, `email`, `password` and `domain` columns, so they run on a plain stage table.
- The ClickHouse client's default `max_execution_time` is 60 s and its `request_timeout` is one hour; long statements set their own limit
  (`lib/content-dedup.ts` does).
- The batch loop already awaits the disk gate (`lib/ingest-disk-gate.ts`) and the memory guard before every insert, whatever the target table.

### Spike results (2026-10-11, live server, throwaway tables)

| Question | Result |
|---|---|
| Hash parity: the stage's `content_key_hash` against the live table's, on real rows | 5,000,000 of 5,000,000 distinct stage hashes found in `ulp.credentials` (probe 10.1 s cold, 541 MiB) |
| `INSERT ... SELECT ... LIMIT 1 BY` throughput into the live-DDL clone | 6.0M stage rows -> 5.0M written in 45.2 s = **110.6k rows/s**, 1.87 GiB peak; the same insert without `LIMIT 1 BY` 117.2k rows/s, 1.48 GiB (cost of `LIMIT 1 BY` about 6%) |
| Is `written_rows` exact with 3 projections and 19 skip indexes? | **Yes.** The real client's `command()` returns `summary.written_rows` (a string) even with `send_progress_in_http_headers` on: 5,000,000 (all new), 0 (all known), 2,452,248 (half known, exactly `distinct - known`) |
| Known-set fill against the empty clone / the 5M-row clone | 0.19 s / 0.9 s |
| Slabs by `content_key_hash % 4` | 1,273,421 + 1,274,832 + 1,274,331 + 1,177,416 = 5,000,000 distinct (exact) |
| Monitor SQL on the stage vs the in-process matcher (17 domains, 1M rows, 489,534 new) | identical for `url`; `credential` and `both` differ by exactly 1 row, a legacy blank-first-tab row that `NORM_EMAIL_EXPR` repairs and the JS matcher cannot (the current parser never produces that shape). `buildNormalizedDomainSetMatch` 0.53 s vs `buildDomainSetWhereClause` 1.21 s per 1M rows |

Consequences, all adopted in the implementation plan: the settings of the commit statements are passed as client settings (the client's default `max_execution_time` is 60 s, and the 20M-row slab takes minutes), `K` is derived from the stage's row count and `distinct` is counted per slab, and monitors are matched with `buildNormalizedDomainSetMatch`.

## Approaches

| | Verdict |
|---|---|
| **A. Stage in ClickHouse, probe with the stage's hashes, insert only the new rows** | **Recommended.** Exact, uses one bounded scan per slab, keeps the existing insert machinery, restartable. |
| B. Probe per 100k-row batch | Each probe is a full scan (about 10 s): 10x the scans per 1M rows. Rejected. |
| C. App-side Bloom filter / hash set | An exact set of 1.39B hashes is 11 GB; a Bloom filter's false positives silently drop genuinely new rows. Rejected. |
| D. Hash-ordered side table (`credential_hashes`) | A 1M-probe lookup touches every granule anyway (about 9 GB read), so no gain for bulk files; only helps files under ~10k rows. Rejected for now, possible small-file fast path later. |
| E. `NOT IN (SELECT hash FROM ulp.credentials)` | Forbidden: builds a ~34 GB in-memory set against the 18 GiB limit (the lesson recorded in `lib/content-dedup.ts`, "PROBING the live table with the (tiny) set of candidate keys"). Approach A probes with the small side and never builds a set of the big table. |
| F. Status quo + cron | The cost above. |
| G. An external filter script that writes `*.novel.txt` files for the inbox | Rejected: it re-serialises rows (losing multi-line block formats), bypasses sources, metrics and monitors, duplicates the parse, and helps only this pile. |

## Design (approach A)

### Flow, inside the existing queue slot

1. **Parse and stage.** Parse and filter exactly as today (hard-tier drop in the parser, soft policy after). Kept rows go to a per-file stage
   table, `ulp.zz_import_stage_<12 hex>` (random id; a ZIP entry is its own file), in the same 100k-row batches, through the existing
   `insertBatch`, so the SP1 disk gate and the memory guard apply to every staged batch. The stage is a plain
   `MergeTree ORDER BY tuple()` with the six insert columns plus
   `content_key_hash UInt64 MATERIALIZED cityHash64(<URL_CONTENT_KEY>, email, password)` (the expression comes from
   `lib/url-content-key.ts`, the same constant the table's DDL v18 and the cron use). No skip indexes, no projections;
   `parts_to_delay_insert` and `parts_to_throw_insert` are raised on it so a 300M-row file cannot trip TOO_MANY_PARTS. The parser runs with
   `dedupInFile: false`.
2. **Commit, one slab at a time.** `distinct = uniqExact(content_key_hash)` of the stage and `K = max(1, ceil(distinct / SLAB))`
   (`INGEST_NOVELTY_SLAB_ROWS`, default 20,000,000: almost every file is one slab; a slab is the stage rows whose `content_key_hash % K = k`).
   For each slab: await the disk gate and the memory guard, take the **process-wide lock** (an async mutex anchored on `globalThis`, because
   `lib/upload-queue.ts` documents that module-level state is duplicated across this app's webpack chunks), then:
   ```sql
   -- known = stage hashes of this slab that already exist in the table (the known table is truncated per slab)
   TRUNCATE TABLE ulp.zz_import_known_<id>;

   INSERT INTO ulp.zz_import_known_<id>
   SELECT DISTINCT content_key_hash FROM {noveltyAgainst}
   WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.zz_import_stage_<id> WHERE content_key_hash % {K} = {k})
   SETTINGS max_execution_time = 3300, use_query_cache = 0, async_insert = 0;

   INSERT INTO {target} (url, email, password, domain, source_file, breach_name)
   SELECT url, email, password, domain, source_file, breach_name
   FROM ulp.zz_import_stage_<id>
   WHERE content_key_hash % {K} = {k}
     AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_<id>)
   LIMIT 1 BY content_key_hash
   SETTINGS insert_deduplicate = 0, async_insert = 0, max_execution_time = 3300;
   ```
   `zz_import_known_<id>` is a small plain MergeTree (`ORDER BY content_key_hash`). `LIMIT 1 BY` makes in-file dedup exact; which of several
   equal-content rows from one file is kept is unspecified (they differ at most in URL scheme or trailing slash, and content-dedup has the same
   tie rule). The lock is per slab, so two concurrent files still parse and stage in parallel, their slabs interleave, and two imports never both
   read "unknown" for the same new credential. Concurrency 2 stays useful: parse (about 26 s per 1M rows) overlaps; only about 20 s per 1M novel
   rows is serialized. A heartbeat (`ctx.beat`) follows every statement; the stall watchdog's 20-minute default is far above one slab
   (20M rows is about 3-4 minutes) and `max_execution_time` bounds a hung statement.
3. **Monitor alerts for new credentials.** After each slab's insert, while its `known` table is still valid, one query per active monitor
   (until `MAX_INPROCESS_MATCHES` is reached):
   ```sql
   SELECT url, email, password, domain FROM ulp.zz_import_stage_<id>
   WHERE content_key_hash % {K} = {k}
     AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_<id>)
     AND <buildDomainSetWhereClause(monitor.domains, monitor.match_mode).clause>
   LIMIT 1 BY content_key_hash LIMIT <remaining cap>
   ```
   Rows become `MatchedCredential`s and go, after the last slab succeeded, through the unchanged `fireMonitorAlertsFromMatches`, whose SQLite
   ledger still filters what each monitor has already seen.
4. **Account, record, clean up.** `rows` (kept by the parser) = `inserted + known + inFileDuplicates`, where
   `known = sum of count(known) over the slabs`, `inserted = distinct - known` and `inFileDuplicates = rows - distinct`. Each slab's insert is
   checked against the number of rows ClickHouse reports as written for the statement (its summary); the job is **failed, not silently
   completed,** if they differ. `recordSource` is called when the file finished, **also with 0 new rows**. The stage and known tables are
   dropped in a `finally`.

### Why this is exactly-once

The retried unit is "recompute `known` for the slab, then insert the rest". If a retry follows an ambiguous failure, or an app/ClickHouse
crash that left some of the `INSERT ... SELECT`'s blocks committed, the recompute finds those rows in the table and does not insert them
again. This replaces the 1-hour dedup window rather than adding to it. The `INSERT ... SELECT` therefore runs with
`insert_deduplicate = 0`: a dedup token is only sound for deterministic block formation, and a parallel read of the stage is not.

### Pieces (each testable alone)

| Unit | Responsibility |
|---|---|
| `lib/ingest-stage.ts` (new) | create and drop a stage and its known table; `sweepOrphanStages()` (drop `ulp.zz_import_stage_*` / `zz_import_known_*` that no running job in this process owns: at startup before the queue starts, and hourly) |
| `lib/ingest-novelty.ts` (new) | the commit phase above: slabbing, the lock, the gates, the retried unit, the accounting check, the monitor query; takes `target` and `noveltyAgainst` tables separately (default both `ulp.credentials`) so a probe can read the live table while writing a clone |
| `lib/upload-processor.ts` | `processTextStream` runs the novelty flow when `INGEST_NOVELTY_CHECK` is on (default on after the rehearsal; `off|0|false` keeps today's direct path, which the benchmark script also keeps); `streamCredentialsToTable` stays the batch loop and gets the parser option; `ProcessResult` gains `known`, `inFileDuplicates`; phase callbacks |
| `lib/ulp-parser.ts` | `parseULPStream` gets an optional `{ dedupInFile?: boolean }` (default `true`); the novelty path passes `false` and relies on the stage |
| `lib/upload-jobs.ts`, `/api/upload` SSE | `known`, `inFileDuplicates`, `phase` (`parsing` / `checking` / `inserting`) and `staged` in the job and the event payload; while parsing, `imported` stays 0 |
| `/api/upload`, `/api/v1/upload` | the ZIP branch keeps entries that added nothing but had known rows; the v1 reply gains `known`; `imported` documented as "new rows" |
| SQLite | `processing_jobs.known INTEGER NOT NULL DEFAULT 0` (additive `ALTER` guarded like the existing ones in `lib/sqlite.ts`); `logJob` takes `known` |
| `lib/inbox-watcher.ts` | logs and records `known`; `current_progress` gains `phase`; the interrupted-file message becomes "safe to Retry" |
| UI | the Upload result card gets "Already in the database" and a phase line; the Inbox list and current-progress line show "N new, M known" |
| Config and docs | `INGEST_NOVELTY_CHECK`, `INGEST_NOVELTY_SLAB_ROWS` forwarded in compose, in `.env.example` and the README; the API docs say what `imported` means |

### Behavior changes the operator will see

- `imported` now means **new rows**. A renamed copy of an imported file (verified before: stored again, 2000 stored / 1000 distinct) now
  reports 0 new, and is recorded in `ulp.sources` with `line_count` 0 so its name is remembered.
- `ulp.sources.line_count` stays "rows this file added".
- While a file is being read the Upload page and the Inbox show the phase and the rows read so far, not "imported".
- The inbox sweep message for an interrupted file changes from "review before re-adding" to "safe to Retry: rows already imported are skipped".
- Fully novel files take about 50% longer; fully known files cost the parse, the stage and one scan, and write nothing to the table.
- Deleting a source (Sources page) removes the credentials first seen in that file, which is what it already means after the 2026-09-30 dedup.
- The 04:00Z dedup tick finds almost no excess. With D6 it is report-only, so nothing slipping through can rewrite the table or drop the archive.

### Failure matrix

| Failure | Outcome |
|---|---|
| App crash while staging | Nothing reached the live table; the orphan stage is dropped by the sweeper; inbox file goes to `failed/`; Retry is clean |
| Crash or kill mid-`INSERT ... SELECT` | Some blocks committed; Retry recomputes `known` and inserts only the rest |
| ClickHouse down / Keeper read-only during the commit | Existing `withClickHouseRetry` loop (2 h budget) for the stage inserts; the commit statements fail the job, and Retry is safe |
| Disk below the gate's floor while staging, or before a slab | The import waits (SP1 gate, no timeout); the stage stays; it resumes by itself |
| A statement hangs | `max_execution_time = 3300` ends it with an error; the stall watchdog fails the job if no statement completes in 20 minutes |
| Two concurrent files with overlapping new content | Slabs serialized by the lock; the second sees the first's rows as known |
| Dedup cron swap during an import | Unchanged risk: the cron already carries a catch-up step for live inserts; the commit statements address `ulp.credentials` by name (and with D6 no apply runs) |

### Risks

- **A false "known" would drop a new credential.** Mitigations: the stage and the table compute the hash from one shared expression, with a
  parity test (same row through both paths -> same hash) and a drift test against the init SQL; the per-slab written-rows check;
  expected `cityHash64` collisions are negligible (about 1M new x 1.39B existing / 1.8e19 = 0.00008 rows per file; the cron has the same
  exposure).
- **`INSERT ... SELECT ... LIMIT 1 BY` throughput and the written-rows summary: settled by the spike above** (110.6k rows/s; `written_rows` exact), so
  no second probe per slab is needed. The check still skips with a warning if a future server version stops sending the summary.
- The probe scan grows linearly with the table (about 10 s at 1.39B rows, about 20 s at 2.8B). Several staged files could share one scan later.
- ClickHouse memory: one slab's set is at most 20M x 8 B before overhead, checked after the existing memory guard; the cap is a setting.
- Stage disk use is about the compressed row size (tens of bytes per row; a 100M-row file is under 10 GiB), guarded by the SP1 gate.

## Decisions for the owner (defaults in bold)

- **D1.** First-seen wins and nothing records repeat sightings (matches what content-dedup already keeps). The alternative, a
  "seen again" counter or last-seen date, needs a small side table and is a separate feature.
- **D2.** A finished file is recorded in `ulp.sources` even when it adds 0 rows, and the same-name guard stays as is.
- **D3.** Accept about +50% wall time on fully novel files in exchange for no more duplicate rows.
- **D4.** Ship the one-step import first (summary after the fact); the preview screen is phase B.
- **D5.** `INGEST_NOVELTY_CHECK` defaults on after the rehearsal; `off` restores today's direct path as the rollback.
- **D6 (decided 2026-10-11, "Report-only"):** once this ships, `CONTENT_DEDUP_APPLY=false` in `.env`: the 04:00Z pass still measures and logs the
  excess but never drops the archive or rewrites the table unattended; a rewrite becomes a deliberate
  `npx tsx scripts/run-content-dedup-once.ts`.

## Verification plan (empirical, per the project's own rule)

Unit tests are mocks; the 2026-10-04 rehearsal found two ClickHouse bugs they could not. So both layers, all against real ClickHouse, and
never an insert into the real table: the existing live-DDL clone approach, with `noveltyAgainst` pointing at the live `ulp.credentials`
(read-only) and `target` at the clone.

1. **The spike (first plan task), on a scratch clone of the live DDL:** `INSERT ... SELECT ... LIMIT 1 BY` throughput on a 5M-row stage, and
   what the statement's summary reports as written rows with three projections present.
2. **Unit tests** for slabbing, accounting, the sweeper, the lock, the phase callbacks, the parser option, the hash parity and drift tests,
   the monitor query builder, the job and SSE payloads, and the config parsing.
3. **Live parity, read-only on the real table:** two or three small real files from the pile go through the novelty commit with a throwaway
   clone as `target`; their `known` counts must equal what the 2026-10-11 probe computes for the same rows (a cross-check of two
   independent implementations of the same hash).
4. **Rehearsal on the production image** (isolated stack, synthetic data only), a new `scripts/e2e-novelty-ingest.ts`: an all-new file; the same
   content under a second name (0 new, source recorded); a half-overlap file; kill the app mid-commit, restart, retry (total equals distinct); two
   overlapping files at `UPLOAD_CONCURRENCY=2` (no duplicates); a file past the old 2M in-file cap with repeated rows (exact); a ZIP with two
   entries; the inbox path; a disk-gate pause while staging; `INGEST_NOVELTY_CHECK=off` (the direct path); a monitor alert fired for new rows only.
5. The existing rehearsals (alert 36, upload resilience 33, disk gate 20) must still pass, and the existing suite stays green.

## Rollout

Same as the disk-safety work: a branch in the primary checkout, tests first, the rehearsals above, a rollback tag, `up -d --no-deps app`. At
deploy time `.env` gets `CONTENT_DEDUP_APPLY=false` (D6). Importing the download pile is a separate operation afterwards: the same-name guard
skips 20 files; the new rows add about 62 GiB, which leaves about 58 GiB free against the 50 GiB gate while the raw files are still on the
disk, so the raw files should be moved off the disk as they finish (the operator's call; if the gate pauses an import it simply waits).

## Phase B (after D4)

`POST /api/upload/preview` runs parse + stage + probe and keeps the stage for an hour; the page shows importable / known / new (and, for an
extra scan of about 10 s, the top five source files holding the known rows), with an "Import the N new rows" button that runs the commit
phase from the kept stage with no re-parse. It reuses everything above. A cheaper triage tool already exists in spirit: the sampling probe of
2026-10-11 ranks files by novelty in seconds per file.

## Deliberately NOT done

- Provenance of repeat sightings (D1), a hash-ordered side table (approach D), changing the same-name guard, parser speed-ups, any change
  to `ulp.credentials` itself (no new column, projection or index), any ClickHouse DDL (no `ulp.sources.known_count`), and any change to the
  dedup code (D6 is configuration).
