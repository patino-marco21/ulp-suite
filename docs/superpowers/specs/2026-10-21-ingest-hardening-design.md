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

- **The 7-day purge of `inbox/done/` by file mtime** (at every start) is the reason a file that exists only there is at risk: a file keeps the mtime of its download, so
  one that was imported yesterday can be older than 7 days. The run book's order (archive first, `--replace` only by the owner) is the protection; the 20 files that had
  no archive were archived by hand the same day (no `--replace`, every archive decoded again and matched). Deleting by the age of the move (ctime) or only files with an
  archive would close it in code; it is a separate, small change.
- **`UPLOAD_CONCURRENCY` stays at 2.** Two lanes used 1.1 of 16 cores while staging; four lanes should take about 23-28 minutes for a batch like this one instead of 47
  (an estimate, not a measurement). It is a setting, applied when `inbox/processing` is empty.
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
