# Ingest hardening: design and result (2026-10-21)

Status: built, rehearsed on the isolated stack and checked on the live table (see "Evidence"); the deploy and its result are at the end. The repository is public: this file holds numbers and reasons only, never file
names, search terms or credential values.

## Why

Two batches ran on 2026-10-21: 24 files in the morning (18.0M lines, 4 m 47 s) and six files of 1.1-4.2 GB in the afternoon (19.5 GB, 330.4M lines, 47.4 minutes,
two lanes). Everything that imported was verified independently (88 of 88 and 48 of 48 checks, 0 duplicate hashes, the table 1,884,234,495 -> 2,048,779,170 rows,
exactly the sum of the jobs' new rows). Around the import, six things were wrong or missing:

1. **Eight names stranded in `inbox/processing/`.** rename(2) between two names of one file does nothing and reports success (POSIX). A file put back into the inbox
   with a hard link, while held/ or done/ kept the same file under the same name, finished its import and the final move of processing/X onto held/X, done/X or
   failed/X left X behind. The next start would have reported eight failed imports; a Release of such a file imported it and then ran a second, empty pass.
2. **10% of the lines were in no job counter.** The rows that repeat inside a file are removed by the stage table and were never stored: 33.0M of the 330.4M lines,
   22.4M of them in one file. A file the same-name check skipped logged a bare `done` row with 0/0/0 that looked like an import that found nothing.
3. **The same-name check blocked by name alone.** A different file that reuses the name of an earlier import (a refreshed dump of a source) was skipped silently.
4. **The search-dictionary rebuild started in the middle of the batch.** Its only test for "the table is quiet" was an unchanged fingerprint over 120 s, and a big file
   commits minutes after the one before it. The rebuild took 328 s (215 s on an idle machine), slowed the scans of one file 1.6-1.8 times, and was stale on arrival.
5. **The progress card assumed 80 bytes per line.** The files had 47-74, so the bar sat at 99% with a negative ETA for the last 14-30% of three of the six files. The
   watcher also kept ONE progress record: with `UPLOAD_CONCURRENCY` above 1 the second file replaced the first one's, and whichever finished first cleared the other's.
6. **The recount tool died on the biggest file.** `scripts/pile/verify-file.ts` stopped with a memory-limit error (code 241 at its 6 GB cap) on a 4.2 GB file of 74
   million distinct hashes: one probe held the IN set and two distinct sets of the whole file at once. It was also one file at a time.

## What changed

| # | Change | Where |
|---|---|---|
| 1 | `moveFile`: after the rename, a source name that still exists and is the same file as the destination (same device and inode, another directory entry) is removed; a file moved onto its own path, or onto an alias of it through a symlinked directory, is left alone. Used by the claim, the startup sweep, the watcher's five moves, Retry and Release. | `lib/inbox-claim.ts`, `lib/inbox-helpers.ts`, `lib/inbox-watcher.ts` |
| 2 | `processing_jobs.repeats` and `.note`, both nullable (an older row reads NULL, "not recorded"; 0 would claim a measurement). The watcher and both upload routes record the rows repeated inside the file (summed over the entries of a ZIP) and the note `already-imported` when the check skipped every entry that did not fail. With imported, known and skipped, repeats makes the lines add up. The Inbox and Upload job lists show "already imported · skipped" in place of "0 rows", with a tooltip that says where every line went. | `lib/sqlite.ts`, `lib/processing-log.ts`, `lib/import-summary.ts`, the two routes, the two pages |
| 3 | The same-name check compares size: `processTextFile` passes the size of the file it opens (`ImportHooks.fileSize`), the check counts a row with that name only when its recorded size is 0 or equal, and `recordSource` writes the size. A row without a size (an import from before this) and a ZIP entry still go by name, so nothing blocked before is let through; an import from the archive keeps its sha256 comparison. | `lib/upload-processor.ts`, `lib/import-runner.ts` |
| 4 | The rebuild cron skips (new outcome `importing`) while the shared upload queue holds work, before its first read and again after the settle wait (a file can be claimed while the tick sleeps). The queue is the one place every import goes through; a directory listing would have let a stale name in processing/ block the cron for ever. | `lib/search-dictionary-cron.ts` |
| 5 | `computeProgress`: a plain file and a file read from the archive report the bytes read (`ImportHooks.onSourceBytes`: the read stream's own counter, a counter in the hashing stream); the share read, the rows still to come and the time left follow from them and do not depend on the length of a line. After the read the card waits at 99% with the staged rows as its total and no ETA (the writes wait for the commit lock). A reference to an archived file reports the plaintext size, not its few hundred bytes. The watcher keeps one record per file (a map on `globalThis`), `GET /api/inbox/status` returns `jobs_progress` (`current_progress` stays the first of them), and the Inbox page shows a card per file. A ZIP keeps the old estimate. | `lib/inbox-progress.ts`, `lib/inbox-watcher.ts`, `lib/archive-ref.ts`, `app/api/inbox/status/route.ts`, `app/inbox/page.tsx` |
| 6 | `verify-file.ts` probes the table in buckets of the content hash (`h % B = k`, `B = ceil(importable rows / 16M)`; each pass holds a 1/B share of the sets and the shares add up exactly), checks "rows repeated inside the file (offline) == job.repeats" when the job recorded them, reports and skips a job the same-name check skipped, and takes `--jobs N` (one child process per file, each file printed as one block). `jobs-summary.cjs` prints repeats, lines, unrecorded and skipped files. | `scripts/pile/verify-file.ts`, `scripts/pile/jobs-summary.cjs` |

No setting is new, so `docker-compose.yml`, `.env.example` and the README's settings list are unchanged. The only schema change is the two additive SQLite columns, added
at start like the phase timings of fast-ingest step A3.

## Not changed, on purpose

- **The 7-day purge of `inbox/done/` by file mtime** was left for a separate change; it was made the same evening (see "Follow-up", first part).
- **`UPLOAD_CONCURRENCY` stays at 2**, and the estimate written here first (four lanes in about 23-28 minutes instead of 47) was wrong: the lanes share one JavaScript
  thread (see "Follow-up", second part, with the measurement).
- Group commit, parse workers and a native parser are the fast-ingest spec's steps B and C.

## Evidence

**Unit and integration tests.** Every change was written test-first and the new tests were watched failing for the right reason before the code. Final tree: 259 files
passed (10 live files skipped), 3,962 tests passed, typecheck of the app, `scripts/` and `__tests__/` clean, ESLint clean, `next build` ok (inside the image build).
A fake-docker test runs the real `verify-file.ts` and pins its bucket SQL, the sums, the new checks and the parallel mode.

**On the live table, read-only** (`verify-file.ts` against the real ClickHouse and a copy of the job log; its only write is a scratch Memory table it drops):

| File | Importable rows | Distinct hashes | Buckets | Result |
|---|---|---|---|---|
| a small one, single probe, then 4 buckets | 913,502 | 882,263 | 1, then 4 | identical numbers; each of the 4 passes took 15-22 s and peaked at 207-287 MB |
| a 4.2 GB file | 61,014,785 | 56,630,708 | 4 | all 8 checks pass at the default 6 GB cap |
| the file that stopped the old tool with a memory error | 74,081,817 | 74,071,354 | 5 | all 8 checks pass |
| a second big file, in the same `--jobs 2` run | 47,633,232 | 43,123,013 | 3 | all 8 checks pass; the run prints each file as one block and ends `ALL CHECKS PASSED (2 files)` |

**On the isolated rehearsal stack** (a real ClickHouse and the real inbox volume; candidate image built from the commit under test, `REHEARSAL_APP_IMAGE`):

- The three new scenarios first ran against the PREVIOUS (live) image and failed where the defects are, 20 of 36: a finished file put back as a second name left `processing/`
  with a link count of 2 and the file was imported twice over, a used name with another size was skipped silently with no size in `ulp.sources`, and the status endpoint had
  no per-file progress (0 samples).
- Against the candidate: fresh install 49 of 49, novelty-aware ingest **182 of 182** (the 8 older scenarios and all the earlier checks included, with the 3 new ones),
  upload resilience 33 of 33, search dictionary 81 of 81 (the rebuild cron still builds when no import runs). The first full run had 8 failures in the new scenarios' own
  fixtures (reused line tags, a percentage that two batches in flight make meaningless on a 5-batch file, two files that could miss each other); they were fixed in the
  fixtures and the same fixtures fail on the previous image.
- Progress, two lanes (500,000 rows each, one file of short lines and one of long ones): both files listed in the same answer, the share read within a point of the bytes
  read and never going back, the time left never negative and never growing past 40%, the other file's card kept when the first finished.
- Looked at in the Browser pane against that stack: two cards at once (21.9 MB of 492.2 MB read, 4%, est. 2.2M rows, ETA about 1 min; 21.9 MB of 175.3 MB read, 12%),
  the card of the short file gone when it finished while the long one went on (440.4 MB of 492.2 MB, 89%), "already imported · skipped" with its tooltip for a re-dropped
  finished file, and the line-by-line tooltip of a finished job. A 3,000,000-row file of long lines failed in that stack only because its ClickHouse is capped at 4 GB
  (the live one has 20 GiB); nothing was left stranded.

**Not proven by the rehearsal:** the cron's skip on the live queue (it is unit-tested against the real `uploadQueue`, and the rehearsal showed the cron still builds when
idle). The estimate of the total rows on a small file lags by the batches in flight (up to about 50% on a 5-batch file, 0.7% on a 74-million-row one); the share read and
the time left come from the bytes alone and do not.

## Follow-up (2026-10-21, evening): `done/` retention, and why the lane count stays at 2

Two items of "Not changed, on purpose" were looked at again after the release. The first became a code change; the second was measured and the answer is no.

### 1. `inbox/done/` is pruned by the age of the import, and only for files the archive holds

**The defect.** At every start the watcher deleted each file of `done/` whose own modification date was older than 7 days. A rename keeps that date, so a file downloaded ten
days before it was imported was "old" the moment it landed in `done/`. On the afternoon of 2026-10-21 that rule would have deleted the first of the 20 files that nobody had
archived (21.6 GB) at the next start from 2026-10-24, and the rest on the days after; the start of the release deploy deleted two files for the same reason (both archived).
The archive (`scripts/archive-sources.ts`) is the only other copy of a source file, and the owner's rule is never to delete an original that is not archived.

**Why not the change time.** The first idea was to age a file from when it moved (ctime). It cannot work: `docker-entrypoint.sh` runs `chown -R` and `chmod -R 777` on
`/app/inbox` at every container start, which sets the ctime of every file in the folder to the time of the start. Measured on the live folder: all 21 files of `done/` and the
one in `failed/` showed the time of that day's deploy as their change time, although the imports had ended three hours earlier.

**The rule now** (`lib/inbox-retention.ts`, called from `startInboxWatcher`). A file leaves `done/` only when both hold:
- the job log (`processing_jobs`, source `inbox`, status `done`, the newest row of that name, read as UTC) is more than 7 days old. A file with no such row stays;
- the source archive holds that exact file: the manifest has the same name and size, and `<id>.zst` is on disk at the `archive_bytes` the manifest records; for an
  `.archiveref` the archive file it points to exists. A manifest that cannot be read means nothing counts as archived, one warning says so, and nothing is deleted.

Everything else stays. The start-up log, now `console.warn` because the production build strips `console.log` (the old deletion lines never reached `docker logs`), says what was
deleted and how many files and GiB wait for the archive. The app reads the manifest through the read-only `/archive` mount it already has; no setting is new. A deployment
with no archive keeps `done/` for ever, which is the safe side of the old behaviour (a full disk is loud: the ingest disk gate pauses imports; a deleted original is silent).

**Evidence.** Test-first: the first 19 unit tests, written against the old rule, failed 14 of 19 for the right reasons (a file nobody archived deleted, one imported yesterday
deleted because the file was a month old, a file the log never imported deleted, no lookup failure contained). Final: 20 unit tests on real directories, a real archive made with
the archive tool's own functions and the real job log, plus 3 checks that the watcher calls the rule and logs with `console.warn`. Rehearsal scenario `retention` in
`scripts/e2e-novelty-ingest.ts` (a real archive copied into the container, five files in `done/` with their own date 40 days back and job rows of 8 days, 8 days, 1 day, 8 days
(an `.archiveref`) and none, then a restart of the production image): on the PREVIOUS image 5 of its 18 checks fail (the file nobody archived, the file imported yesterday and
the file the log never imported are all deleted, and there is no log line); on the candidate it passes, and so do `basic`, `concurrent`, `link`, `same-name` and `progress`
(77 of 77 together).

### 2. `UPLOAD_CONCURRENCY` stays at 2: the lanes share one JavaScript thread

The release notes above said four lanes should take about 23-28 minutes for the 47-minute batch. That was an estimate that treated each lane as a parallel parser, and it was
wrong. Parsing runs on the app's main thread (no `worker_threads` anywhere in the code; the parse pool of the fast-ingest spec, step C, is specified and not built), so lanes
only overlap one file's waits (inserts, the commit lock) with another file's parsing. The batch itself already said so: the two lanes used 1.09 cores of 16 in total, and its
aggregate of 115k lines/s sits next to a one-thread parse ceiling of 129k lines/s (330M lines at that ceiling are 43 of the 47.4 minutes).

Measured with `scripts/measure-upload-lanes.mjs` on the isolated rehearsal stack, production image, one run per setting, 4 synthetic files of 2,000,000 lines (8,000,000 rows,
every one imported exactly), the rehearsal's 30 s stall watchdog raised to the production 20 minutes:

| `UPLOAD_CONCURRENCY` | wall | end to end | app CPU | ClickHouse CPU | app memory peak (anon) |
|---|---|---|---|---|---|
| 1 | 124 s | 65k lines/s | 0.66 cores | 1.57 cores | 492 MiB |
| 2 | 85 s | 94k lines/s | 0.90 cores | 2.16 cores | 546 MiB |
| 4 | 131 s | 61k lines/s | 0.60 cores | 2.31 cores | 842 MiB |

Two lanes get the app to 0.9 of the one core it can use (an earlier 2-lane run took 94 s, so the spread is about 10%). Four lanes add no capacity and only contention: each file
took 76-128 s instead of about 30 s alone, the app used less CPU, ClickHouse more. A first 4-lane run with the rehearsal's own 30 s watchdog failed one file after 36 s
without progress (a lane that was waiting, most likely for the commit lock; the cause was not isolated); the production limit is 20 minutes, and in the live batch a slab
commit holds the lock about a minute. Memory is not what limits it: the app's heap peaked at 492, 546 and 842 MiB at 1, 2 and 4 lanes (the live app has an 8 GiB limit and a
6 GiB heap). Limits of the measurement: one run per setting; the rehearsal ClickHouse is capped at 4 GB and holds almost no data, so its commit is cheaper than the live one and
the four-lane slowdown may be smaller or larger live. The one-thread argument does not depend on it.

**What this changes.** The setting stays at 2, and the lever for a big-file batch is the parse pool, not the lane count. Parsing is 51.5% of lane time in the 47.4-minute batch;
spread over several cores the floor becomes the serialized commit (16.3 minutes of lock in that batch), so roughly 20-25 minutes with four or more workers is the order of
magnitude to expect (an estimate from those numbers, not a measurement). For a batch of many small files the lever is group commit (step B: 11 existence scans become 1).
Both are in the fast-ingest spec and await its review.
