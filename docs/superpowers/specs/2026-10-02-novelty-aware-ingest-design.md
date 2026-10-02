# Novelty-aware ingest — design (2026-10-02)

Status: **proposed, not implemented.** Sub-project 2 of the 2026-10-02 improvement plan (sub-project 1 is
`2026-10-02-import-reliability-design.md`; this one does not require it, but both touch `lib/upload-processor.ts`, so build 1 first).
Reference table: `ulp.credentials`, 1,394,459,025 rows, 128.88 GiB (about 99 bytes per row on disk), ordered by `(domain, email, imported_at)`.
Every timing below is cold (query cache and condition cache off) on the one 16-thread laptop, against the live server, using throwaway
`ulp.zz_*` tables that were dropped afterwards (live row counts identical before and after).

## The problem: the importer stores what it already has

- The insert path keeps every row whose batch bytes differ. The batch dedup token hashes `source_file` on purpose
  (`lib/upload-dedup.ts`), so the same credential arriving in another file is inserted again. Nothing in the importer asks whether the
  credential is already in the table.
- The scheduled content-dedup (`lib/content-dedup.ts`) undoes that later, keeping the **earliest `imported_at` per
  `content_key_hash`** (`argMin(col, imported_at)`). At the 2026-09-30 cutover it removed **50%** of the table (2.78B -> 1.39B rows).
  It only applies once the excess reaches `DEDUP_MIN_EXCESS` (14M rows) and each apply is a multi-hour rewrite that needs a second copy of
  the table (the 381 GiB archive `credentials_predup_auto` is still on disk).
- The pending Telegram file (`inbox/failed/…KURZL0GS_UP - 29.04.2026 - ULP PRIVATE.08`, 77 MB) shows what that costs: 1,336,290 lines ->
  1,058,060 importable -> **1,053,269 distinct credentials, of which 1,053,228 (99.996%) are already in the table** (spread over 77
  imported files, 692,921 of them in a single one); **41 are new**. Importing it would add about 100 MB of rows that the next dedup
  would delete.
- Retries are not exactly-once. ClickHouse's block dedup window is 3600 s / 10000 blocks, so a half-imported file retried after more than
  an hour re-inserts the batches that already landed. That is why the inbox sweep says "may be partially imported; review before re-adding".
- In-file dedup is a per-file JS `Set` capped at 2M entries (about 440 MB of heap per concurrent file); past the cap a file has no in-file
  dedup (`lib/ulp-parser.ts`, `SEEN_CAP`).
- The operator cannot tell how much of a file was new: `imported` counts rows inserted, `skipped` counts parse rejections.

## Goals

1. Insert only credentials that are not already in `ulp.credentials`, identified by the table's own `content_key_hash`. First-seen wins,
   the same survivor content-dedup would keep.
2. Exactly-once by content on retry or resume, independent of the 1-hour dedup window.
3. Every finished import reports **new / already known / duplicate within the file** (SSE, `processing_jobs`, upload page, inbox monitor).
4. Exact in-file dedup for any file size, and the 440 MB-per-file heap `Set` is gone from this path.
5. No change to the `ulp.credentials` schema, search, or the dedup cron (it stays as the reconciliation net).

Not goals: remembering *which other files* a known credential appeared in (decision D1 below); a preview / dry-run screen (phase B, below);
changing the same-name re-upload guard; making the parser faster.

## Measurements (all on the live server)

| What | Result |
|---|---|
| Existence check, strategy A: `content_key_hash IN (stage hashes)`, one-column scan of the live table | **10.7 s cold, 9.9 s warm**, reads 10.4 GiB (1,395,517,085 rows) for the 1.06M-row file |
| Same, pruned by `domain IN (...)` first | 13.8 s |
| Same, pruned by `(domain, email) IN (...)` | 36.0 s |
| Parse + insert into a plain MergeTree stage (no projections, no skip indexes) | 26.0 s for 1,058,060 rows |
| `INSERT ... SELECT` stage -> clone of the **live DDL** (19 skip indexes, 3 projections) | 1,058,060 rows in **10.2 s = 103k rows/s**, identical at `max_insert_threads` 1 / 4 / 8 |
| Today's direct CSV stream, one file | 31-33k rows/s (per-100k insert p50 2.2 s, p95 3.6 s) |
| Direct CSV stream, N concurrent files | 1 -> 32.8k, 2 -> 51.1k, 3 -> 61.7k, 4 -> 69.7k, 6 -> 80.9k rows/s |

Strategy A is the only one that does not get slower when the probe set is large: the cost is the hash column's size, not the number of
probes, so one scan answers a whole file (and could answer several staged files together). Estimated wall time for a 1M-row file from the
measured parts (to be confirmed end to end in the first plan task): fully novel about 46 s (+50% over the direct 31 s), half known
about 41 s, fully known about 36 s with nothing written to the table.

## Approaches

| | Verdict |
|---|---|
| **A. Stage in ClickHouse, probe with the stage's hashes, insert only the new rows** | **Recommended.** Exact, uses one bounded scan per file, keeps the existing insert machinery, restartable. |
| B. Probe per 100k-row batch | Each probe is a full scan (about 10 s): 10x the scans per 1M rows. Rejected. |
| C. App-side Bloom filter / hash set | An exact set of 1.39B hashes is 11 GB; a Bloom filter's false positives silently drop genuinely new rows. Rejected. |
| D. Hash-ordered side table (`credential_hashes`) | A 1M-probe lookup touches every granule anyway (about 9 GB read), so no gain for bulk files; only helps files under ~10k rows. Rejected for now, possible small-file fast path later. |
| E. `NOT IN (SELECT hash FROM ulp.credentials)` | Forbidden: builds a ~34 GB in-memory set against the 18 GiB limit (the lesson recorded in `lib/content-dedup.ts`, "PROBING the live table with the (tiny) set of candidate keys"). Approach A probes with the small side and never builds a set of the big table. |
| F. Status quo + cron | The cost above. |

## Design (approach A)

### Flow, inside the existing queue slot

1. **Parse and stage.** Parse and filter exactly as today (hard-tier drop in the parser, soft policy after). Kept rows go to a per-job stage
   table, `ulp.import_stage_<12 hex of the job id>`, in the same 100k-row batches, using the existing CSV insert and the memory guard.
   The stage is a plain `MergeTree ORDER BY tuple()` with the six insert columns plus
   `content_key_hash UInt64 MATERIALIZED cityHash64(<URL_CONTENT_KEY>, email, password)` (the expression comes from
   `lib/url-content-key.ts`, the same constant the table's DDL v18 and the cron use). No skip indexes, no projections.
2. **Commit, under a process-wide lock.** One statement group per slab (a slab is the stage rows whose `content_key_hash % K = k`; K is
   `ceil(distinct / 20M)`, so almost every file is one slab):
   ```sql
   -- known = stage hashes that already exist in the live table
   INSERT INTO ulp.import_known_<id>
   SELECT DISTINCT content_key_hash FROM ulp.credentials
   WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.import_stage_<id> WHERE content_key_hash % {K} = {k});

   INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name)
   SELECT url, email, password, domain, source_file, breach_name
   FROM ulp.import_stage_<id>
   WHERE content_key_hash % {K} = {k}
     AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.import_known_<id>)
   LIMIT 1 BY content_key_hash;
   ```
   `import_known_<id>` is a small plain MergeTree (`ORDER BY content_key_hash`). `LIMIT 1 BY` makes in-file dedup exact; which of several
   equal-content rows from one file is kept is unspecified (they differ at most in URL scheme or trailing slash, and content-dedup has the same
   tie rule). The lock
   (an async mutex anchored on `globalThis`, because `lib/upload-queue.ts` documents that module-level state is duplicated across this
   app's webpack chunks) serializes only this phase, so two concurrent uploads still parse and stage in parallel but never both read
   "unknown" for the same new credential. Concurrency 2 stays useful: parse (about 26 s per 1M rows) overlaps; only about 20 s per 1M novel
   rows is serialized.
3. **Account, record, alert, clean up.**
   `rows` (kept by the parser) = `inserted + known + inFileDuplicates`, where `distinct = uniqExact(content_key_hash)` of the stage,
   `known = count(import_known)`, `inserted = distinct - known`, `inFileDuplicates = rows - distinct`. The job is **failed, not silently
   completed,** if the three do not add up. `recordSource` is called when the file finished (also with 0 new rows, so the same-name guard
   and the Sources list see it). Monitor alerts fire for **new** rows only: when monitors exist, the new rows are read back from the stage
   (`... WHERE hash NOT IN known LIMIT 1 BY hash`) through the unchanged in-process matcher (`matchCredentialsAgainstIndex`), capped by
   `MAX_INPROCESS_MATCHES`. Stage and known tables are dropped in a `finally`.

### Why this is exactly-once

The retried unit is "recompute `known` for the slab, then insert the rest". If a retry follows an ambiguous failure, or an app/ClickHouse
crash that left some of the `INSERT ... SELECT`'s blocks committed, the recompute finds those rows in the table and does not insert them
again. This replaces the 1-hour dedup window rather than adding to it. The `INSERT ... SELECT` therefore runs with
`insert_deduplicate = 0`: a dedup token is only sound for deterministic block formation, and a parallel read of the stage is not.

### Pieces (each testable alone)

| Unit | Responsibility |
|---|---|
| `lib/ingest-stage.ts` | create / insert-into / drop a stage and its known table; `sweepOrphanStages()` (drop `ulp.import_stage_*` / `import_known_*` that no running job in this process owns: at startup before the queue starts, and hourly); refuses to stage when the existing disk-headroom guard (`lib/clickhouse-disk-guard.ts`, fail-closed) trips |
| `lib/ingest-novelty.ts` | the commit phase above: slabbing, the lock, the retried unit, the accounting invariant; takes `target` and `noveltyAgainst` tables separately (default both `ulp.credentials`) so a probe can read the live table while writing a clone |
| `lib/upload-processor.ts` | `streamCredentialsToTable` gets a `mode` option, `'direct'` or `'novelty'` (default `direct`, so the benchmark script and current callers are untouched); `processTextStream` passes `novelty` when `INGEST_NOVELTY_CHECK` is on; `ProcessResult` gains `known` and `inFileDuplicates` |
| `lib/ulp-parser.ts` | `parseULPStream` gets `dedupInFile?: boolean` (default `true`); the novelty path passes `false` and relies on the stage |
| `lib/upload-jobs.ts`, SSE | `known` and `phase` (`parsing` / `checking` / `inserting`) in the job and the event payload |
| SQLite + ClickHouse | `processing_jobs.known INTEGER NOT NULL DEFAULT 0` (additive `ALTER` guarded like the existing ones in `lib/sqlite.ts`); `ulp.sources.known_count UInt64 DEFAULT 0` (new DDL version in `lib/clickhouse-migrations.ts` and the init SQL) |
| UI | upload page result card, inbox monitor and queue status show "N new, M already in the database, K duplicates in the file" |

### Behavior changes the operator will see

- `imported` now means **new rows**. A renamed copy of an imported file (verified before: stored again, 2000 stored / 1000 distinct) now
  reports 0 new.
- `ulp.sources.line_count` stays "rows this file added"; `known_count` is new.
- The inbox sweep message for an interrupted file changes from "review before re-adding" to "safe to Retry: rows already imported are skipped".
- Fully novel files take about 50% longer; fully known files cost the scan and write nothing.
- The 04:00Z dedup tick finds almost no excess; it stays as the net for anything that slips through (for example a hash collision or the
  fallback path).

### Failure matrix

| Failure | Outcome |
|---|---|
| App crash while staging | Nothing reached the live table; the orphan stage is dropped by the sweeper; inbox file goes to `failed/`; Retry is clean |
| Crash or kill mid-`INSERT ... SELECT` | Some blocks committed; Retry recomputes `known` and inserts only the rest |
| ClickHouse down / Keeper read-only during the commit | Existing `withClickHouseRetry` loop (2 h budget); sub-project 1 adds the Keeper/read-only codes to what it retries |
| Disk guard trips before staging | Job fails with the guard's message; nothing staged |
| Two concurrent uploads of overlapping new content | Serialized by the commit lock; the second sees the first's rows as known |
| Dedup cron swap during an import | Unchanged risk: the cron already carries a catch-up step for live inserts; the commit statements address `ulp.credentials` by name |

### Risks

- **A false "known" would drop a new credential.** Mitigations: the stage and the table compute the hash from one shared expression, with a
  parity test (same row through both paths -> same hash) and a drift test against the init SQL; the per-job accounting invariant;
  expected `cityHash64` collisions are negligible (about 1M new x 1.39B existing / 1.8e19 = 0.00008 rows per file; the cron has the same
  exposure).
- The probe scan grows linearly with the table (about 10 s at 1.39B rows, about 20 s at 2.8B). Several staged files could share one scan later.
- ClickHouse memory: one slab's set is at most 20M x 8 B before overhead, checked after the existing memory guard; the cap is a setting.
- Stage disk use is about the compressed row size (tens of bytes per row; a 100M-row file is under 10 GiB), guarded as above.

## Decisions for the owner (defaults in bold)

- **D1.** First-seen wins and nothing records repeat sightings (matches what content-dedup already keeps). The alternative, a
  "seen again" counter or last-seen date, needs a small side table and is a separate feature.
- **D2.** A finished file is recorded in `ulp.sources` even when it adds 0 rows, and the same-name guard stays as is.
- **D3.** Accept about +50% wall time on fully novel files in exchange for no more duplicate rows.
- **D4.** Ship the one-step import first (summary after the fact); the preview screen is phase B.
- **D5.** `INGEST_NOVELTY_CHECK` defaults on after the rehearsal; `off` restores today's direct path as the rollback.

## Verification plan (empirical, per the project's own rule)

All against real ClickHouse, never an insert into the real table: the existing live-DDL clone approach, with `noveltyAgainst` pointing at the
live `ulp.credentials` (read-only) and `target` at the clone.

1. The pending `.08` file end to end: expect 41 new and 1,053,228 known out of 1,053,269 distinct credentials, parse rejections matching the
   dry run, the remainder reported as in-file duplicates (the dry run's in-memory dedup already dropped 211 of them, so the staged row count
   is a little above its 1,058,060); the clone ends with 41 rows.
2. A novel 1M-row file: all inserted, counts add up, wall time recorded against the 31 s direct baseline.
3. The same file twice, then under a second name: second run adds 0.
4. Kill the commit mid-`INSERT ... SELECT`, rerun: total equals distinct.
5. Two overlapping files at `UPLOAD_CONCURRENCY=2`: no duplicates; elapsed vs sequential.
6. A 10M-row synthetic file: peak ClickHouse and app memory, stage size, one slab.
7. The rehearsal e2e (`scripts/e2e-alert-rehearsal.ts`) gains a step that imports one file under two names; the fresh-install path must pass.
8. Unit tests for accounting, slabbing, sweeper, parity and drift; the existing 1,864 tests stay green.

## Phase B (after D4)

`POST /api/upload/preview` runs parse + stage + probe and keeps the stage for an hour; the page shows importable / known / new (and, for an
extra scan of about 10 s, the top five source files holding the known rows), with an "Import the N new rows" button that runs the commit
phase from the kept stage with no re-parse. It reuses everything above.

## Deliberately NOT done

- Provenance of repeat sightings (D1), a hash-ordered side table (approach D), changing the same-name guard, parser speed-ups, and any change
  to `ulp.credentials` itself (no new column, projection or index).
