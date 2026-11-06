# Known-share preflight: design (2026-11-05)

Status: Step A approved by the owner on 2026-11-05 (the answers are at the end); not built yet. Step B is not approved. The repository is public: this file
holds numbers only, never file names, search terms or credential values.

## Why

Most of the time an import spends is spent on rows the database already holds. The job log (inbox imports from 2026-10-17, 191 files read, 4.31 billion lines):

| | |
|---|---|
| new rows | 896 M = 28.9% of the valid rows (71.1% were already known) |
| the less productive half of the files (95) | 2.2% of the new rows, 20% of the job time |
| files that added under 1% new | 29 files, 3.0 job-hours, 0.4 M new rows |
| files that added under 20% new | 46% of the job time, 10.8% of the new rows |
| new share of the valid rows, by week | 47.0% (week of 10-19), 23.5% (10-26), 16.9% (11-02, to 11-05) |
| new rows per job-hour, by week | 53 M, 28 M, 26 M |

One batch of 11 files (366.6 M lines, 57 minutes) shows the shape: 2 files gave 89% of the 52.5 M new rows; 7 files with under 10% new took 58% of the job
time (3,892 of 6,673 job-seconds) and added 4.7 M rows, 9% of the batch. Nothing tells the owner which is which until the lane has spent its minutes.

## The question tested

Can a small sample of a file say, before a lane is spent on it, how much of it is new?

Method (read-only on the data; scratch tables in a separate ClickHouse database, dropped afterwards). For 70 files already imported (archived, at least 2 M
lines, spread over the whole range of yield): take 5 slices of 1 MiB through the importer's own parser (`parseULPStream`, the policy of the running app), drop
repeats inside the sample, compute the normalised key (`normKeySql`) of every row in ClickHouse, and ask `ulp.credentials` which `source_file` holds that key.
A key held by this file was new when the file was imported; a key held only by other files was known. Estimate = new / (new + known). The reference is the share
the job log recorded for the whole import. 4.40 M distinct sampled rows in all (about 63 k per file).

## Result

| | |
|---|---|
| absolute error of the new share | median 1.9 points, p75 4.7, p90 11.5, worst 28.3 |
| rank correlation (Spearman) with the real share | 0.952 |
| flag "under 1% new" at predicted under 1% | 11 of 12 caught, 3 false flags (the worst of them was really 5%) |
| flag "under 5% new" at predicted under 5% | 21 of 21 caught, 3 false flags (the worst was really 17%) |
| flag "under 10% new" at predicted under 10% | 26 of 28 caught, 2 false flags (the worst was really 17%) |
| the five richest files | predicted within 13.5 points (89.1 -> 87.2, 81.7 -> 81.1, 71.7 -> 71.5, 67.1 -> 57.0, 65.0 -> 78.5) |
| files of the 11-file batch in the test (5) | 48.5 -> 45.1, 28.9 -> 21.7, 0.0 -> 0.0, 10.2 -> 11.2, and one that read 16.8 against a real 5.2 |

The larger misses are files whose novelty sits in part of the file (46% real against 18% predicted, 57% against 40%): a sample of 5 slices under-reads such a
file. Five of the six largest misses read lower than the real share and one read higher (65% real against 78.5%), so the estimate is a reason to look, never a
reason to discard.

A sample can also miss a bad region altogether. One held file passed a 5-slice preflight (0.09% unsplit) and was held by the importer's early check, which reads
the first million lines (8.08% unsplit, 19 seconds). The importer's own checks stay the authority; the preflight only advises.

## Design

**Step A, a flag on the existing tool (no deploy, no change to the import path).** `scripts/preflight.ts --known <file | archived name>...` prints, after the
quality verdict of each file, `expected new share ~X% (sample N rows, Y% of them already known)`. It samples as above, loads the sample keys into a scratch
table, runs one scan of the key column per call (a scan of 1.83 billion hashes took 19 seconds inside a live import) for all the files of the call together,
and drops the scratch table. It needs the ClickHouse container like the other scripts (`docker exec`), and without `--known` it behaves exactly as today.
Cost for a batch of 11 files: about one scan plus the parse of 55 MiB, against the 3,892 job-seconds that the seven files with under 10% new took in the batch above.

**Step B, in the app (a later step, only if Step A earns its place).** The Inbox page shows the expected new share of each waiting file, computed the same way
before the file is claimed, and sorts or marks the waiting list by it. No automatic skip, park or hold: the owner decides what a low number means for a file.

**Not in this design.** No automatic action on a prediction. No change to the same-name check, the quality gate or the order the queue runs in.

## Verification

Unit tests for the pure parts (the TSV escaping of a sampled row, the arithmetic and the wording of the line). The query is proven on a real ClickHouse: the
isolated rehearsal stack, with files whose new share is known by construction (a file all new, a file all known, a half-overlap file), and the estimate must
land within the error above. The retrospective test is repeated by hand on the next batch and compared with its job log.

## The owner's answers (2026-11-05)

1. An advisory line before a batch (Step A) is built first. Step B (the Inbox page) is decided only after Step A has been compared with the job log of a real batch.
2. "Low yield" is under 5% new. In the test that threshold caught 21 of 21 files that really added under 5%, with 3 false flags.
3. A flagged file stays where it is in the queue. No reorder, skip or park.
