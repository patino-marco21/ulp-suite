# Fast ingest: design (2026-10-12)

Status: design, written for the owner's review. Nothing in this document is built. The repository is public: this file holds numbers only, never file names,
search terms or credential values.

## Why

A full import of the pile (2.39 billion lines, 504 files) takes 9-10 hours. The owner's goal is that a parser or policy improvement never again costs a day.
The archive and gate spec (`2026-10-12-source-archive-and-ingest-gate-design.md`) makes a redo unnecessary in most cases; this spec makes the remaining ones
cheap. The owner chose "Node first, Rust later" on 2026-10-12: no new language in the app, a native parser only if the numbers below are not enough.

Measured on 2026-10-12 (scratch tools and a throwaway ClickHouse; the live stack was only read):

1. **Where run 5 spent its CPU** (13:57-15:52Z, 423 files, 478M lines, from `system.query_log` and the app's cgroup counters). ClickHouse used about 35,900
   CPU-seconds, of which **31,389 (87%) went to one statement**: for every file, `INSERT INTO zz_import_known_* SELECT DISTINCT content_key_hash FROM
   ulp.credentials WHERE content_key_hash IN (<the file's stage>)` scans the whole 1.4-billion-row hash column (405 statements read 573.8 billion rows; about 77
   CPU-seconds and 6 s per file whatever its size; 225 files of under 100k lines cost about 17k CPU-seconds on their own). Committing new rows took 1,159
   CPU-seconds (10.6 us per row), staging inserts 578 (1.5 us per row), merges 1,693. The Node app used 5,450 CPU-seconds, 11.4 us per line, 0.78 cores on average.
2. **The importer is one thread.** Parse alone: 164k lines/s per process (7.05 us of CPU per line); with the CSV rows and the dedup token 128k; with the client's
   gzip of every insert body (`compression.request: true` in `lib/clickhouse.ts`, over loopback) 74k (15.1 us). Several processes scale: 4 -> 435k, 8 -> 831k,
   12 -> 917k lines/s on this 8-core, 16-thread machine while run 5 was loading it. The parser profile is flat (`parseLine` 16%, garbage collection 14%, the
   token hash 5%, nothing larger), so only a rewrite or many fast paths would speed up one thread.
3. **The commit insert is under-parallelised.** `INSERT ... SELECT` into the live DDL (19 indexes, 3 projections, 12 derived columns), 4M rows: server defaults
   137k rows/s (27.4 s); `max_insert_threads = 4` 399k rows/s (9.4 s, 33 CPU-seconds against 29); 4 statements on disjoint hash slabs 389k rows/s; 8 statements
   506k rows/s (CPU-bound). Run 5's commit statements averaged 92k rows/s on about one core: 400M new rows would take about 72 minutes of commit time alone.
4. **A bulk existence check is cheap.** 100M staged hashes against 200M existing ones: 28 CPU-seconds in 8 hash buckets (a grace-hash join: 49), against about
   760 as 100 per-file scans of the same table (27x, and the gap grows with the table).

## Decisions (owner, 2026-10-12)

1. Node first. A native (Rust) fast path is a later spec; Rust 1.99 is already installed and a throughput prototype did 7.46M lines/s on 12 threads, so the door
   stays open.
2. The scope is steps A, B and C below. Splitting one huge file across several workers is not included.

## Goals

- **G1** A full pile redo in about one hour on this machine (a model built from the measurements above; the rehearsal checks it).
- **G2** Every change is off, or identical to today, until it is switched on; the defaults reproduce the current behaviour.
- **G3** Equivalence: the rows stored, each row's `source_file`, each file's new / known counts and the monitor matches are the same as when the files are
  imported one at a time in the same order.

## Non-goals

No change to what the parser produces. No native parser, no shadow-table loader, no splitting of one file across workers, no change to the search side. ZIP
archives and anything not on disk keep the in-process path.

## Step A: three small changes

- **A1, no gzip on loopback.** `lib/clickhouse.ts` sets `compression.request` from `CLICKHOUSE_COMPRESS_REQUESTS` (default off; `1` restores the old
  behaviour). Response compression is unchanged. Measured: 5.3 us of CPU per line, a third of the per-line cost.
- **A2, parallel commit insert.** The commit `INSERT ... SELECT` (`commitInsertSql` in `lib/ingest-novelty.ts`) runs with `max_insert_threads` from
  `INGEST_COMMIT_INSERT_THREADS` (default 4, allowed 1-16), as a per-statement setting; the existence scan and the monitor queries are not touched. Measured
  137k -> 399k rows/s. The memory guard (`lib/clickhouse-memory-guard.ts`) still runs before every slab.
- **A3, phase timings.** `processing_jobs` gets three additive columns, `parse_ms`, `check_ms` and `insert_ms` (`INTEGER NOT NULL DEFAULT 0`, idempotent
  `ALTER`s next to the `known` column in `lib/sqlite.ts`). They are filled from the `timings` accumulator `streamCredentialsToTable` already has and from the
  durations of the existence scan and the commit insert; `logJob` (`lib/processing-log.ts`) takes them as optional fields and
  `scripts/pile/jobs-summary.cjs` prints them. Today the split had to be reconstructed from ClickHouse's query log.

## Step B: group commit

**Today.** `importThroughStage` (`lib/upload-processor.ts`) parses a file into its own stage table and calls `commitStage` (`lib/ingest-novelty.ts`), which for
every slab of the stage (20M rows by default, so a small file is one slab) takes the process-wide commit lock, scans the whole hash column for the stage's
hashes, and inserts the rows that are not known.

**New.** A commit coordinator (`lib/ingest-commit-coordinator.ts`, state on `globalThis` like the commit lock and the upload queue, because the watcher and the
routes are separate bundles). `importThroughStage` calls `submitCommit(job)` instead of `commitStage`.

- **Group formation, no timers.** When the commit slot is free and at least one staged file is waiting, the coordinator takes every waiting file, in the order
  they were submitted, up to `INGEST_GROUP_MAX_FILES` (default 16) and `INGEST_GROUP_MAX_ROWS` (default 100M staged rows); the rest wait for the next group. A lone
  file on an idle system commits at once, and a group of one runs today's `commitStage` unchanged. Groups therefore appear exactly when commits are the
  bottleneck, and their size follows the load.
- **One existence scan per slab for the whole group.** Slabs are taken over the union of the stages' hashes (`content_key_hash % K = k`, K from the union's
  row count and `INGEST_NOVELTY_SLAB_ROWS`). For slab k, `known` is filled by one statement, `SELECT DISTINCT content_key_hash FROM ulp.credentials WHERE
  content_key_hash IN (<slab k of stage 1> UNION ALL <slab k of stage 2> ...)`, into one group table `zz_import_known_<group>`.
- **The files are then committed in order, each excluding what the group already inserted.** A second group table, `zz_import_group_<group>`, holds the
  hashes inserted so far by earlier files for this slab. For file f: (1) `expected_f` = its slab's distinct hashes that are in neither `known` nor `group`;
  (2) `INSERT ... SELECT` its rows whose hash is in neither, `LIMIT 1 BY content_key_hash`, and check that ClickHouse reports `expected_f` rows written (the check
  that exists today); (3) the monitor queries for the new rows (same predicate, before step 4); (4) `INSERT INTO group SELECT DISTINCT content_key_hash` of the same
  rows. The group table is truncated between slabs. Slabs partition the hash space, so slabs never interact.
- **Why this equals sequential imports.** By induction over the files of the group, file f inserts exactly the hashes that are in neither the table as it was
  before the group nor any earlier file of the group: the same set as importing f after its predecessors, one at a time. So the rows, the first file's
  `source_file` for a repeated credential, `imported` and `known` per file (known = distinct - expected) and the monitor matches are identical. A test asserts it.
- **Failure.** If any statement of file f fails, the group stops after f: files before f are done, f fails (its Retry works as today; its partially written rows
  count as known on the retry), and the files after f go back to the queue for a new group, which re-scans `known` and therefore sees f's partial rows.
- **Gates and locks are unchanged:** the disk and memory gates before every slab, the process-wide commit lock held for a slab of the group, the abort signal, the
  statement kill on failure, the heartbeat for the stall watchdog after every statement. The sweeper (`lib/ingest-stage.ts`) learns the new table names
  (`zz_import_group_<id>`, and the group's known table).
- **Progress.** Each file keeps its own `checking` / `inserting` events; while its group's scan runs it shows `checking`.
- **Flags:** `INGEST_GROUP_COMMIT` (`off` default until rehearsed, then `on`), `INGEST_GROUP_MAX_FILES`, `INGEST_GROUP_MAX_ROWS`.

Effect (measured pieces): the 87% of ClickHouse CPU that went to per-file scans falls by the group size (about 20x for a manual batch of 20 files), and a batch of
tiny files costs one scan instead of one each. Groups only grow when several files are waiting to commit, which is the normal state of a manual batch and of a run
with parse workers (step C); with one in-process parser and mid-size files the queue rarely builds, so B pays off most together with C.

## Interaction with the archive and gate spec

Both specs change `importThroughStage` and `streamCredentialsToTable`, so their plans must be sequenced, not run in parallel. The order that keeps each step small:
the archive tool (offline, touches nothing that runs) -> step A -> the gate (its counters live in `streamCredentialsToTable`) -> step C's extraction of
`lib/ingest-stream.ts` (the counters move with it and travel back in the worker's `progress` and `done` messages) -> step B -> step C's pool. The gate's
`processing_jobs.gate_report` column and this spec's three timing columns are separate additive `ALTER`s. Neither spec needs ClickHouse DDL besides the archive
spec's `ulp.sources` columns (v28).

## Step C: parse workers

**Pool.** `lib/ingest-pool.ts` (state on `globalThis`) keeps `INGEST_PARSE_WORKERS` worker threads (default 0 = today's in-process path; at most 12), each running
`dist/ingest-worker.cjs` with `resourceLimits: { maxOldGenerationSizeMb: 768 }`. A worker stages one file at a time: it opens the file itself, runs the same
`streamCredentialsToTable` (parser, T3 predicate, CSV rows, dedup token, insert into the stage table) with its own ClickHouse client, and sends the main thread
a heartbeat and counts after every batch. The main thread creates and drops the stage tables, applies the gate's verdict (archive and gate spec, once built), runs
the group commit, writes `ulp.sources` and the job row, and reports progress; it no longer parses.

**Protocol.** Main to worker: `stage` (job id, path, file name, stage table, breach name, the ingest policy as plain data, batch size) and `abort`. Worker to
main: `progress` (staged, skipped, rejection counts, gate counters), `done` (the `StreamToTableResult`) or `error` (message, whether it is retryable). The
heartbeat feeds `runImportJob`'s stall watchdog exactly as the in-process callbacks do. Abort stops the batch loop and cancels the insert in flight, as the
`AbortSignal` does today.

**Isolation.** A worker that fails fails only its file. A worker that exceeds its heap limit is terminated and replaced; its file fails with a clear message and
its stage is dropped by the existing `finally`. A worker file that is missing or fails to start turns the pool off with one warning and the import falls back to
the in-process path.

**The worker file.** `streamCredentialsToTable`, `insertBatch` and their helpers move to `lib/ingest-stream.ts`, which imports nothing that touches SQLite, Next
or `yauzl`; `lib/upload-processor.ts` re-exports them, so no caller changes. `scripts/build-ingest-worker.mjs` bundles `lib/ingest-worker.ts` with esbuild
(already installed as a dependency of `tsx`; platform node, CommonJS, tsconfig paths) into `dist/ingest-worker.cjs`. The Dockerfile builder stage runs it after
`npm run build`, the runner stage copies `dist/`, CI runs it, and `dist/` is added to `.gitignore` and `.dockerignore`. If the bundle pulls in a module that
needs SQLite or Next, the build fails (an assertion on the bundle's inputs), so the boundary cannot drift silently.

**Concurrency and memory.** `UPLOAD_CONCURRENCY` stays the number of files in flight (queue slots); with workers on it is set to the worker count, and a file holds
its slot for staging and commit as today. A worker costs about 768 MB at most plus its batches (two of about 15-30 MB). Eight workers are about 6-7 GB in the worst
case, so `docker-compose.yml` raises the app's `mem_limit` from 8g to 12g (ClickHouse keeps 20g; the machine has 31 GB) and documents the guidance next to
`INGEST_PARSE_WORKERS`.

**Eligible files.** Plain text and CSV on disk: inbox files, and HTTP uploads (which spool to disk first). ZIP entries and anything else keep the in-process path.
In development (`next dev`) and in the unit tests the pool is off.

## Testing and rehearsal

All fixtures are synthetic (made-up hosts, logins and passwords).

- **Unit tests.** The coordinator: group formation and order, both limits, a lone file, a file that arrives while a group commits, failure re-queues the rest, abort.
  The SQL builders: the union known fill, the group exclusion, the accounting check, the monitor predicate. The pool: the message protocol, abort, a worker
  that dies, a worker that runs out of memory (a tiny `resourceLimits`), fallback when the bundle is missing. Step A: the three settings reach the client and the
  statement; the migration is idempotent.
- **Equivalence scenarios** added to `scripts/e2e-novelty-ingest.ts` (the name `gate` is the disk gate's, so they are `group` and `workers`): overlapping files with
  in-file repeats, cross-file repeats, a file that is entirely known, a file with no importable line and a monitor that matches new rows. Imported with
  `INGEST_GROUP_COMMIT=off` in sequence and with it `on`; and with `INGEST_PARSE_WORKERS=0` and `4`. The scenario asserts the same rows (count and sum of
  `content_key_hash`), the same `source_file` per row, the same per-file imported / known / skipped and the same monitor matches.
- **Rehearsal on real files**, read-only on the originals, on the isolated stack (`noveltyAgainst` may read a clone): about 20 pile files of different sizes,
  imported the old way and the new way into two copies of the table; the final rows and the per-file accounting must match; the timings are recorded in a
  Results section appended to this spec. The first full-scale number comes from the next large import.
- **Gate:** the full suite, `tsc`, `eslint`, `next build`, the worker bundle build, and the alert, upload-resilience, novelty and disk-gate rehearsals.

## Rollout and rollback

1. Build on its own branch and worktree. Step A first: it is three small, independent changes.
2. After run 5 is complete and its checks are recorded: one deploy with step A (the usual rules: nothing in `inbox/processing`, the rollback tag first, `docker
   compose` from the merged commit anchored to the primary checkout's environment). B and C ship in the same image behind their flags, off. If the archive and gate spec is built by then, its app changes (DDL v28 and the gate) go into the
   same image: one deploy, one rollback tag.
3. After the real-file rehearsal passes, the owner switches them on in `.env` (`INGEST_GROUP_COMMIT=on`, `INGEST_PARSE_WORKERS=8`, `UPLOAD_CONCURRENCY=8`) and the app
   restarts once.
4. Rollback: flags off (or `INGEST_PARSE_WORKERS=0`), or the image's rollback tag. The three new columns and the new table names are additive.

## Expected effect (a model; the rehearsal and the next large import test it)

| Configuration | Full pile redo |
|---|---|
| Today | 9-10 h (run 4: 10.3 h) |
| Step A alone | a modest gain: the commit is 3x faster, the parse thread unchanged |
| A + B | the hash-scan load falls ~20x, mostly a gain for small files and for contention |
| A + B + C, 8 workers | about 1 h: parse about 45-50 minutes at 8 x 128k lines/s, overlapped with commits at about 400k rows/s (about 17 minutes of commit) |

## Risks

- **Group commit correctness.** The equivalence is by construction and tested, and the per-file written-rows check stays; a mismatch fails the file before anything
  else is committed.
- **Worker memory.** Capped per worker, with the container limit raised; an out-of-memory worker fails one file.
- **Two paths (in-process and workers).** They run the same functions; the `workers` scenario compares their output.
- **Bundle drift.** Built in the same Docker build as the app and in CI, with an assertion on what it contains.
- **Throughput not reaching the model.** The existence scans, the commit and the merges all still run in ClickHouse; the model puts them at about 20-40 minutes of
  CPU spread over the parse time. If a rehearsal shows otherwise, the timings from A3 say where the time went.

## Later specs

The native fast path (Rust, behind the same worker interface, proven against the TypeScript parser by `scripts/parser-diff.ts --whole`); splitting the twelve ~3.9 GiB
files across workers; a shadow-table rebuild with an atomic `REPLACE PARTITION` (measured at 0.12 s), which needs about 55 GiB of free space and therefore the
archive step first.
