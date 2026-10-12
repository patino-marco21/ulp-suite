# Source archive and ingest gate: design (2026-10-12)

Status: Part 1 (the source archive: library, guards, CLI, readers, runbook) is BUILT and merged (plan `docs/superpowers/plans/2026-10-12-source-archive.md`); the importer's
archive reference (`.archiveref`), the ingest gate (Part 2) and the DDL v28 are designed here and not built yet. The repository is public: this file holds numbers only,
never file names, search terms or credential values.

## Why

The owner's goal: a parser or policy improvement must never again mean re-importing the whole pile by hand. The pile (140 GiB, 504 files, 2.39 billion
lines) was imported five times in two days, because every defect was found after its rows were stored.

Measured on 2026-10-12 (scratch tools only; nothing in the live stack changed):

1. **Two things make a redo unavoidable today.**
   - *The raw lines are not kept.* The planned side copy (`lib/dropped-lines.ts`) keeps only the lines the parser drops. A defect in **stored** rows
     (tags inside passwords, swallowed lines: most of the past defects) cannot be re-parsed once the originals are deleted. `ulp.sources` holds only a file
     name, a line count and a time, so even "which bytes became these rows" is not recorded.
   - *Nothing checks a file before its rows are stored.* The two worst defects were visible in a two-minute sample: two files with 99.8% of their lines
     rejected, and one file with 29% junk-looking rows (from the notes of the run).
2. **The parser is near its ceiling for this pile, so more rules are not the lever.** Sample of all 504 files (5 slices of 2 MiB each, extrapolated), final
   parser: 83.6% of lines stored, 13.8% dropped by the T3 policy, 1.6% garbage, 0.69% unsplit; 0.24% of the stored rows look mis-split; at most about 0.09%
   of the lines are unsplit lines that still carry an e-mail address. What is left is a long tail: 98,189 distinct line shapes, the top 10 hold 27% of the
   failures, the top 50 hold 57%, none is above about 0.05% of the lines. Holding each source family out in turn, only 0.75% of the lines have a layout seen
   nowhere else, and 93% of all failures are in layouts that exist elsewhere in the pile (ambiguity inside known layouts, not unknown formats). The real
   out-of-sample error can only be measured on a fresh batch.
3. **A correction is expensive in this schema.** ClickHouse 26.3.17, a throwaway server with the live DDL (19 indexes, 3 projections), 3M rows, 400 MiB:

   | Operation | Measured |
   |---|---|
   | load 3M rows, one stream | 29 s (~100k rows/s; the importer manages ~11k) |
   | `INSERT ... SELECT` 1.2M rows into a shadow table | 15 s |
   | `OPTIMIZE ... FINAL`, one part | 28 s |
   | `ALTER ... DELETE` 5% of the rows | 19 s: rewrites the whole part with its projections (~21 MiB/s; ~45 min and +55 GiB for the 55 GiB pile partition, extrapolated) |
   | lightweight `DELETE`, default | refused: table setting `lightweight_mutation_projection_mode` is `throw` (it is a table setting, not a query setting) |
   | lightweight `DELETE`, `rebuild` | 15 s |
   | lightweight `DELETE`, `drop` | 0.8 s, but it drops the projections of the touched parts |
   | `REPLACE PARTITION ... FROM` a shadow table | 0.12 s, atomic |
   | `NOT IN (small table)` filter | ~16 ns per row |

   This spec uses none of those operations. They are recorded because the next spec (a shadow-table loader) builds on them.

## Decisions (owner, 2026-10-12)

1. The permanent raw copy is a **compressed archive made in place**: each original is replaced only after its archive is verified, by a command the owner
   runs. (Offered and not chosen: keep the originals as they are; copy to an external drive or S3.)
2. The first spec is the archive plus the gate. The shadow-table loader, the parser clean-up and policy-as-data come later.

## Goals

- **G1** Every byte the importer reads is also kept compressed, verifiably identical, and readable by every offline tool.
- **G2** A bad file is stopped before one row reaches `ulp.credentials`, with a report that says why; the owner can override.
- **G3** The disk never dips: archiving and replacing go file by file, verified before each original is touched.
- **G4** A good file is stored exactly as today: the gate only counts, it does not change what the parser produces.

## Non-goals

No change to the parser's output. No shadow loader, no parser refactor, no policy-as-data. The old partitions (202607, 202608) are untouched. No external
backup: an archive on the same disk protects against a parser or policy change, **not** against losing the disk.

## Part 1: the source archive

### Layout

`<archive dir>` is `~/ulp-archive` (env `ULP_ARCHIVE_DIR`), outside the repository and outside the Docker build context. It holds:

- `<id>.zst`, where `id` is the first 24 hex characters of the sha256 of the plaintext (content addressed: two names with identical bytes share one archive,
  and a file name never appears in a path);
- `manifest.jsonl`, one line per archived name: `name`, `id`, `size`, `sha256`, `lines`, `frames` (`[plainOffset, plainLength, compOffset, compLength]` per
  frame), `archive_bytes`, `archive_sha256`, `level`, `created_at`, `replaced_at`.

The manifest holds file names, so it is never committed; the directory is also listed in `.gitignore` and `.dockerignore` in case it is ever placed inside
the checkout.

### Format

Concatenated zstd frames of at most 64 MiB of plaintext each, cut at a newline (when the last 1 MiB holds no newline, at 64 MiB), level 12, 128 MiB window,
long-distance matching. `zstd -dc <id>.zst` gives back the original file (a test checks that with the `zstd` binary). Frames exist for three reasons: the
sampling tools (`scripts/parser-diff.ts`) read slices at offsets, workers can compress and decompress frames in parallel, and an interrupted run can resume.

Measured on 96 MB slices of six files spread over the size range: 2.39x at level 3, 2.93x at level 12, 3.16x at level 19. The whole pile is therefore about
48 GiB at level 12 (44 GiB at level 19; level 12 is several times faster).

### The tool, `scripts/archive-sources.ts`

| Command | What it does |
|---|---|
| `archive --src <dir> [--out <dir>] [--workers 8] [--only a,b] [--replace] [--include-unimported]` | archive every `.txt` of the directory; with `--replace`, also remove the originals |
| `status` | per name: archived, replaced, size, ratio; totals; names in `ulp.sources` that have no archive |
| `verify [--all \| --sample N]` | decompress and re-hash archives against the manifest |
| `restore <name \| id> --out <path>` | write the plaintext back, then check its sha256 |

Per file, in a worker process:

1. Skip when the manifest already holds the name with an archive of the same size (resume).
2. Read the file once, cut frames, compress each, hash the plaintext while reading, write `<random>.part`.
3. Flush the file and the directory, rename to `<id>.zst`.
4. **Verify independently:** decompress frame by frame, hash the result, compare size, line count and sha256 with what was read. Any mismatch deletes the
   archive, reports the file, and records nothing.
5. Append the manifest line (one write, flushed).
6. Only with `--replace`: stat the original again (size and modification time unchanged since step 2), then unlink it and every other name of the same
   inode under `inbox/done` (a same-device, same-inode check; any other path is left alone).

Refusals, all checked before the first byte is read, each printed with its reason:

- `--replace` while `inbox/` holds a top-level file or `inbox/processing/` is not empty (a file is in flight);
- a file modified in the last 10 minutes (still being downloaded): skipped, not an error;
- `--replace` of a name that is not in `ulp.sources` (not imported yet), unless `--include-unimported`;
- free space below 10 GiB plus twice the compressed size of the file being worked on;
- an archive directory that does not exist or is not writable (the tool never creates it: the owner creates it, so it cannot silently land on the wrong disk).

It never touches `inbox/failed`, `inbox/held`, or anything it did not create.

### The library, `lib/source-archive.ts`

`readManifest(dir)` and `openSource(pathOrName)`, which returns `{ size, stream(), readSlice(offset, length) }`. A path that exists is read as a plain file;
otherwise the basename is looked up in the manifest and decoded frame by frame (one frame resident at a time, no reliance on multi-frame stream
decoding). `scripts/parser-diff.ts`, `scripts/pile/verify-file.ts` and `scripts/extract-dropped-lines.ts` switch from `createReadStream`/`readSync` to it,
so they keep working after the originals are gone; **this must be merged before any original is replaced.**

### The importer reads the archive too (a redo after the originals are gone)

Without this, the archive does not deliver its purpose. After `--replace` there is nothing to hardlink into `inbox/`, restoring 140 GiB of plaintext would need 140 GiB
of free space, and `inbox/done` keeps plaintext for seven days. So the importer accepts an **archive reference**:

- A tiny file `<name>.archiveref` (JSON: archive id, original name, size, sha256) dropped into `inbox/` is claimed like a text file (`.archiveref` joins the
  supported extensions in `lib/inbox-watcher.ts`). `processTextFile` (and the parse workers of the fast-ingest spec) read the plaintext through `openSource(id)`: no
  plaintext touches the disk, `ulp.sources` records the original name, and `inbox/done` keeps only the reference.
- The importer hashes the plaintext while it reads; at the end, a sha256 that differs from the manifest's fails the job before the commit, so a damaged archive cannot
  put damaged rows into the table.
- The duplicate-file guard (`querySourceAlreadyImported` in `lib/upload-processor.ts`) compares the sha256 when both the reference and the `ulp.sources` row have one: the
  same name with different content is a new file (the twenty same-name files of the pile then no longer need their `ulp.sources` rows removed by hand before a redo),
  the same name with the same content stays blocked. A plain file has no hash at claim time, so it keeps the name-only guard.
- `scripts/pile/feed.sh` gets `SOURCE=archive`: it writes the reference files from the manifest instead of hardlinking originals.
- Decompression (189 MB/s per stream at level 12) is far faster than parsing (about 10 MB/s per Node worker), so it adds well under 10% CPU.

This is an app change, so it ships with the gate in the single deploy after run 5.

### Identity in `ulp.sources`

Three columns are added (DDL v28, `ADD COLUMN IF NOT EXISTS`, a table of a few hundred rows): `size UInt64 DEFAULT 0`, `sha256 String DEFAULT ''`,
`archive_id String DEFAULT ''`. The archive tool fills them for names that exist in both `ulp.sources` and the manifest (`ALTER TABLE ... UPDATE`, cheap on
this table) and ensures the columns itself, so the order of the tool and the app deploy does not matter. The importer does not write them in this change:
a new batch shows empty values until the tool has run on it, which the batch procedure below makes a fixed step.

### Procedure

- **New batch:** `scripts/preflight.ts` (Part 2) → `archive-sources archive` (no `--replace`) → import → verify → `--replace` when the owner decides.
- **The current pile:** after the redo's checks 1-4 in `docs/pile-import-runbook.md`, the dropped-lines side copy (step 5) is replaced by the full archive,
  because the archive is a superset of it; then the owner runs `archive --replace`. The archive is never written to this disk while a run is writing to it
  (free space is the limit: the feeder floor is 60 GiB, the app gate 50 GiB).

### Disk and time

Peak extra disk while a file is worked on: its archive (at most ~1.5 GiB for the largest, 4.2 GB file) next to the original. Net effect of `--replace` on
the pile: 140.3 GiB of originals become about 48 GiB, i.e. about 92 GiB freed (the `inbox/done` names are hardlinks and share the blocks). Node's built-in zstd
compresses a 64 MiB frame at level 12 (128 MiB window, long-distance matching) at 18 MB/s per stream and decompresses it at 189 MB/s (measured 2026-10-12 on
Node 24.16), so the pile takes about 17 minutes with 8 workers plus about 2 minutes of verification on an idle machine; the rehearsal confirms it on three
real files.

## Part 2: the ingest quality gate (not the disk gate)

### What it counts

`lib/ingest-quality-gate.ts` exports `classifyStoredRow(url, login, password): GateKind | null`, a pure function. The kinds are the invariants a correctly parsed row
never violates (the same ones as the probe that produced the numbers above):

| Kind | A row has it when |
|---|---|
| `login-is-scheme-or-ends-colon` | the login is a URL, or ends with a colon |
| `login-has-scheme` | the login contains `://` |
| `login-has-slash` | the login contains `/` (not for `android://` urls) |
| `login-has-colon` | the login contains `:` |
| `login-is-bare-host` | the login looks like a host name, has no `@`, and the url is empty |
| `url-holds-credential` | the url field holds what `holdsCredential` (lib/ulp-recover.ts) calls a credential |
| `password-has-scheme` | the password contains `://` |
| `telegram-link-in-field` | login or password contains `t.me/` |
| `double-encoded-text` | the password shows UTF-8 read as Latin-1 |

`streamCredentialsToTable` calls it for every row it stages, next to the rejection counters the parser already keeps, and returns the counts in its result.
The cost is a few string tests per row; the plan measures it against a budget of 5% of parse time.

### Signals and thresholds

- **junk** = rows with a kind / stored rows, **unsplit** = `no_fields` rejects / non-blank lines, **garbage** = `garbage` rejects / non-blank lines.
- **Hold** when at least 20,000 lines were read and junk > 2% or unsplit > 5% or garbage > 25%. **Warn** when at least 20,000 lines were read and
  junk > 1% or unsplit > 2%. Under 20,000 lines the verdict is at most warn.
- Environment: `INGEST_QUALITY_GATE` (`hold` default, `warn`, `off`), `INGEST_QUALITY_GATE_JUNK_PCT` (2), `INGEST_QUALITY_GATE_UNSPLIT_PCT` (5), `INGEST_QUALITY_GATE_GARBAGE_PCT` (25),
  `INGEST_QUALITY_GATE_WARN_JUNK_PCT` (1), `INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT` (2), `INGEST_QUALITY_GATE_MIN_LINES` (20000).

Per-file distributions on the pile with the final parser (281 files of at least 50k lines): junk p50 0.21%, p90 0.54%, p99 3.1%; unsplit p50 0.26%, p90
1.8%, p99 3.7%; garbage p50 1.1%, p90 5.0%, p99 18.6%. The hold rule would stop **6 of 281 files (0.18% of the lines)**; the warn rule flags 31 files
(8.2% of the lines, including those 6) in the report without blocking. Layout novelty is **not** a signal: only 7% of the failures sit in unseen layouts. It is listed in the
report as information.

### Where it runs

`importThroughStage` (`lib/upload-processor.ts`) parses a file into its own stage table; nothing reaches `ulp.credentials` before `commitStage`. The gate
evaluates twice: once after the first 1,000,000 lines of a larger file, and once after the last line, just before `commitStage`. A hold throws
`IngestHeldError(report)`; the existing `finally` drops the stage tables; the job ends as `held`. A held file therefore leaves no trace in `ulp.credentials`,
and an early hold costs one million lines of parsing instead of a 4 GB file. With `INGEST_NOVELTY_CHECK=off` (the legacy path inserts as it parses) the
gate is warn-only.

### What a hold does

- The file moves from `inbox/processing/` to `inbox/held/`. The job row gets `status = 'held'` and a new column `gate_report TEXT` (JSON: the counts, the
  thresholds crossed, up to 20 masked shapes with counts; a shape replaces every run of word characters by `w`, so no raw text is stored).
- The Inbox page gets a **Held** section (reason, counts, masked shapes) with a Release button for admins. `POST /api/inbox/release` moves the file back to
  `inbox/` and stores a one-shot override in SQLite (`gate_overrides`), consumed by the next claim; it writes an `inbox.release` audit row.
- An HTTP upload gets the same verdict: `422` with the report, the spooled file goes to `inbox/held/`, an admin releases it the same way.
- The Ingest Health panel shows the number of held files.
- `scripts/pile/feed.sh` treats `inbox/held/` as "fed and finished": it logs `HELD`, keeps feeding, and the run's last report lists the held files. (A failed
  file still stops the feeder; a held one is a decision for the owner, not an error.)

### The offline preflight

`scripts/preflight.ts [--slices 5] [--slice-mb 2] <file | archived name>...` reads K slices of S MiB per file (the whole file when it is at most 8 MiB), runs
the same parser and counters, and prints one line per file (index, lines, stored %, junk %, unsplit %, garbage %, verdict) plus the masked top shapes. The
exit code is 1 when any file would be held. The pile took 116-123 s with four low-priority workers (measured 2026-10-12). It is used before a batch and by
the feeder (`PREFLIGHT=1` in `scripts/pile/feed.sh` skips a file it would hold and logs it).

### Edge cases

- The counters are plain integers owned by one import (no module state, two concurrent imports cannot mix). An exception inside `classifyStoredRow` is
  caught and counted as `gate_errors`; it never fails the import; more than 0.1% of rows with a gate error turns the verdict into a warn.
- A Retry or Release starts a new import, so its counters start at zero.
- The release override applies to one claim of one file name; the next import of a file with the same name is gated again.

## Testing and rehearsal

All fixtures are synthetic (made-up hosts, logins and passwords); no real credential and no file name from the pile appears in a test.

- `__tests__/source-archive.test.ts`: frame cutting at newlines; round trip for an empty file, a file without a trailing newline, CRLF, bytes that are not
  UTF-8, a line longer than a frame; `readSlice` equals the plaintext slice for random offsets; one flipped bit in an archive fails `verify` and a failed
  archive is deleted and not recorded; an interrupted `.part` is ignored and removed; `zstd -dc` returns the plaintext (skipped when the binary is missing);
  `--replace` unlinks only same-inode names, refuses while `inbox/processing` holds a file, refuses a file younger than 10 minutes, and never touches
  `inbox/failed`.
- `__tests__/ingest-quality-gate.test.ts`: one fixture per kind; the thresholds, the 20,000-line minimum, the warn tier, `gate_errors`; row sets shaped like the output
  of the two old defects (tag text inside passwords; a url line, a login line and a password line joined into one row) must be **held**, and row sets
  shaped like a clean file must pass. (The gate is a function of rows, so these are built as rows; the current parser no longer produces such rows.)
- A `scripts/e2e-novelty-ingest.ts` scenario named `quality-gate` (the name `gate` is the disk gate's): a normal file with `INGEST_QUALITY_GATE_JUNK_PCT` lowered ends
  `held` with zero rows in `ulp.credentials`, Release imports it, and the audit row exists.
- An end-to-end scenario `archive-ref` in `scripts/e2e-novelty-ingest.ts`: the same synthetic file imported from `inbox/` as plain text and through an
  `.archiveref` gives the same rows and the same job counts, a flipped bit in the archive fails the job before any row is committed, and no plaintext copy of the file
  appears in `inbox/`.
- Rehearsal on real files (read-only on the originals, output in a scratch directory): archive a small, a 100 MB and a 1 GB pile file, restore them and compare
  sha256; the speed and the ratio are appended to this spec as a Results section after the build.
- Gate: the full suite, `tsc`, `eslint`, `next build`, and the alert, upload-resilience and novelty rehearsals on the isolated stack.

## Rollout and rollback

1. Build on branch `reversible-pipeline` in its own worktree. Part 1 first: it is offline (scripts, a library, tests, docs) and touches nothing that runs.
2. Part 1 merges to `main` with no deploy. `docs/pile-import-runbook.md` gets "archive before import" and the archive step in place of the side copy.
3. After run 5 is complete and its checks are recorded: one app deploy carrying DDL v28 and the gate (`INGEST_QUALITY_GATE=hold`). The usual rules: nothing in
   `inbox/processing`, the rollback tag first, `docker compose` from the merged commit anchored to the primary checkout's environment.
4. The owner reads `archive-sources status`, then runs `archive --replace` when ready.

Rollback: `INGEST_QUALITY_GATE=off` or the image's rollback tag for the gate; DDL v28 is additive. The archive is additive until `--replace`, and `restore` rebuilds
the exact bytes (checked by sha256), so even `--replace` can be undone as long as the archive directory exists.

## Risks

- **A bug in `--replace` loses data.** Mitigations: the independent decompress-and-hash before anything is unlinked, the unchanged-original check, per-file
  operation, a dry run, `--only` for a first small run, the owner starts it, and a restore drill before the first real use.
- **The archive shares the disk with everything else.** It is not a backup. Copying `~/ulp-archive` to an external drive later is one command.
- **False holds block a good file.** The thresholds come from the pile's own distribution, there is a warn tier, a Release button, and `INGEST_QUALITY_GATE=off`.
- **False passes.** The gate only catches what its invariants encode; there is still no ground truth. The stage is the place to add a check later.
- **Node's zstd binding** exposes the compression level, the window log, long-distance matching and worker threads (checked on Node 24.16); the plan keeps the
  `zstd` binary as a fallback behind the same interface.
- **Cost of the counters** in the hot loop: measured against the 5% budget before merge.

## Later specs (not part of this change)

1. A shadow-table loader (parallel parse, bulk load into a shadow table, verify, `REPLACE PARTITION` or `EXCHANGE TABLES`) so that a full rebuild is
   an hour of unattended work with no downtime, built on the primitives in the table above (`ReplicatedMergeTree`, `ATTACH PARTITION FROM` hardlinks and
   `EXCHANGE TABLES` still need their own check).
2. One source of truth in the parser: a pure `parseFile` with line spans, rule ids and a version; `parseULPContent` has no production caller yet duplicates
   the positional state machine of `parseULPStream`, and the refactor must give zero difference on the whole pile (`scripts/parser-diff.ts --whole`).
3. Policy as data: a reason-coded quarantine, which the archive makes cheap (a policy change re-reads the archive instead of redoing anything).
4. The old partitions: ~20M junk rows whose raw lines are gone; possibly rebuilt from the pile where it covers them (the coverage is not measured).

## Results (archive rehearsal, 2026-10-12)

Three pile files picked by size rank (1,073.7 MB, 126.8 MB and a few KB) were archived with 3 workers while a pile run was loading the machine: 1.12 GiB of plaintext became
0.37 GiB of archive (3.06 x overall; 3.03 x, 3.38 x and 3.05 x per file). The `archive` run took 93.7 s (the 1 GB file on one worker dominates) with a peak of 339 MB of memory in
the main process; `verify --all` took 8.95 s; the three restored files were identical to the originals (`cmp`), and the `zstd` binary decoded the largest archive to the original
in 2.3 s. At 3.06 x the whole pile (140.3 GiB) is about 46 GiB; at the roughly 11 MB/s per worker seen here (busy machine) eight workers need about 27 minutes, at the 18 MB/s
measured on an idle machine about 17.
