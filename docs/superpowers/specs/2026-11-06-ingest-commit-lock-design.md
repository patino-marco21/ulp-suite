# Ingest: a shorter commit lock — one existence check per group of slabs, smaller commit blocks, the wait recorded — design and results (2026-11-06)

Date: 2026-11-06
Status: **Built on 2026-11-06; the rehearsal, the deploy and the measured batch are recorded under "Results" when they are done.**
Related: `2026-10-02-novelty-aware-ingest-design.md` (the slabs, the known table and the lock this changes), `2026-10-12-fast-ingest-design.md` (step A2, the insert threads), `2026-11-05-known-share-preflight-design.md`.
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

A batch of five dumps of 4.18 GB each went through the inbox with the parse pool on: four imported at once in 29.2 minutes, one file alone in 8.0 and 10.6 minutes. Four at once is only about 1.3 times the throughput of one at a time, although the host has 16 cores and ClickHouse used 2-3 of them for the first 12 minutes and 7 at its peak. More parse workers or more concurrency cannot help; the limit is the process-wide commit lock (`acquireCommitLock`, `lib/ingest-novelty.ts`), which lets one slab at a time check against the table and commit.

ClickHouse's query log for the batch, the statements that run under the lock (22 slabs of 4 files):

| statement | time | note |
| --- | --- | --- |
| known fill (`INSERT INTO known SELECT DISTINCT key FROM credentials WHERE key IN (slab)`) | 618 s | 61.8 billion rows read: the whole key column (2.8 billion rows, 21 GiB) once per slab, 21-28 s each |
| commit `INSERT ... SELECT` | 426 s | 16.6 s per slab on average, 2.5 cores, 1.19M rows (71k rows/s) |
| clear and count of the known table | 60 s | |
| distinct count of the stage | 12 s | |

Together 1,116 s of the 1,752 s wall (64%). A job's wait for the lock is in none of `parse_ms`, `check_ms` and `insert_ms`: 380-760 s per job in the batch against 28-40 s for the two single-file jobs.

## The mechanism

**1. One existence check per group of slabs.** The fill reads the whole key column whatever a slab holds. Measured on the live table (2.8 billion rows), a scan probing 10M keys took 21.4 s (457 MiB), the same scan probing 40M keys 24.2 s (1.75 GiB), and the repeat of the 10M scan 21.7 s: four times the keys cost 13% more. So the slabs of one file are checked in groups: one clear, one fill for all the slabs of the group (`key % K IN (...)`), one count per slab (`WHERE key_hash % K = k`), then the inserts. The lock is taken once per group and held from the fill to the group's last insert, so the snapshot stays true: no other import writes in between. The groups are balanced (5 slabs with a limit of 4 are 3 and 2). The default limit is 4 slabs of at most 10M rows, about 40M keys, `INGEST_NOVELTY_CHECK_GROUP` (1 to 16; 1 is the old slab-by-slab check).

- The accounting stays per slab: known above distinct for a slab, or rows written that differ from distinct minus known, fail that slab with its own number. An empty slab asks the table nothing; a group where nothing is left to check sends no statement.
- When a group has more than one slab with credentials, each insert (and each monitor question) subtracts only its own slab of the known table (`WHERE key_hash % K = k`), so the set a statement builds does not grow with the group. With one slab the statements are the ones they always were, byte for byte.
- The room gates (disk, ClickHouse memory) run before each group, before taking the lock, and again before every later insert of the group. The gates are global conditions, so a pause inside a group holds up no import that could have proceeded.
- An abort or a failure inside a group kills the running statement before the lock is released, as before; rows already written are kept and a retry counts them as known.

**2. Smaller blocks for the commit insert.** A slab holds only the rows that are new (about 15% of a file), 1.1-1.2M rows: two blocks of the server's default 1,048,576 rows, and one thread does a block. That is why the commits used 2.5 of 16 cores and why the earlier measurement (452k rows/s, 8 threads no better than 4) did not show it: that slab had 10M new rows, ten blocks. Skip indexes are not the cost (108 CPU-seconds of 1,244 over the 32 commits of the batch, projections 25 s); the materialised regex columns are. Measured on a scratch clone of the live table definition (20 skip indexes, 3 projections; the scratch database was dropped afterwards), a 1.09M-row slab:

| settings | time | cores |
| --- | --- | --- |
| 4 threads, default blocks | 12.4 s and 12.6 s | 2.5 |
| 8 threads, default blocks | 12.8 s | 2.5 |
| 4 threads, 131,072-row blocks | 5.3 s | 6.3 |
| 8 threads, 131,072-row blocks | 5.1 s | 6.4 |
| 16 threads, 65,536-row blocks | 4.3 s | 8.3 |

The commit statement now carries `max_insert_block_size`, `min_insert_block_size_rows` and `max_block_size` of `INGEST_COMMIT_BLOCK_ROWS` (default 131,072, 8,192 to 1,048,576; 1,048,576 is the old behaviour). The price is parts: 5 per commit instead of 1. The live table's newest partition held 11 active parts after the 38M-row batch (the delay limit is 500), so the merges keep up.

**3. The wait is recorded.** `processing_jobs.lock_wait_ms` (additive column, older rows read 0) holds the time between asking for the lock and holding it, added up over the groups of the file. The next batch needs no query-log archaeology to say where the time went.

## Decisions and dead ends

- Not a second table of keys and not a key-sorted stage table. The stage sorted by its key with range slabs reads 4 times fewer bytes (1.21 GiB against 5.08 GiB) but gained no wall time on the clone: the build of the known-keys set in `NOT IN (...)` dominates, and ten million random probes touch every granule of a key-ordered table anyway.
- Not more insert threads, not more parse workers, not more concurrent files: the lock is the limit.
- The default group is 4 and not the whole file: the set a fill builds grows with the group (1.75 GiB at 40M keys), and the lock is held for the group's whole length.
- A 20-file batch makes about 5 parts per slab, a few hundred in all: the part limits (500 to delay, 1,000 to throw) are far, and the merges run while the batch does.

## Tests

- `__tests__/ingest-novelty-commit.test.ts`: the call order of a group (distinct counts, one clear, one fill, the known counts per slab, the inserts), balanced groups, totals that do not depend on the group size, per-slab accounting (the slab is named), the scoped known subquery on both keys and in the monitor question, one lock acquisition per group (a second import waits for the group's last insert), the gates before the group and before every later insert, an abort inside a group (the statement is killed, the lock is freed, the next import runs), the phases reported, the timings of a group, the lock wait. The tests of the slab-by-slab path run with a group of 1.
- `__tests__/ingest-novelty-config.test.ts`: the three settings, their ranges and their fallbacks; a changed default fails them.
- `__tests__/phase-timings.test.ts`, `__tests__/processing-log-timings.test.ts`, `__tests__/upload-processor-novelty.test.ts`: the lock wait in the sum, the column and the job record.
- Rehearsal scenario `groups` in `scripts/e2e-novelty-ingest.ts`: two files at once with 14 slabs each sharing 30,000 rows; the grouped check and the check slab by slab write the same rows (the shared ones once), ClickHouse's own query log shows the grouped check sent far fewer fills, and the same content under a new name is all known. The scenarios `concurrent`, `big`, `kill`, `freeze`, `lookalikes` and `workers` run through the same code.

## Expected effect (estimates from the measurements above, not yet run on the stack)

A four-file batch: fills 618 s -> about 190 s (8 groups of about 24 s), commits 426 s -> about 180 s: about 11 of the 29 minutes, so about 18 minutes. One file alone: the fill of a 5-slab file 113 s -> about 25 s, about 1.5 of 8 minutes.

## Results

**Rehearsal (isolated stack, candidate image built from the commits).** The alert rehearsal passed 50 of 50 checks and the novelty-ingest scenarios (every one but the disk filler) 322 of 322, among them `groups` (the grouped check and the check slab by slab write the same 50,000 rows, the shared 30,000 once, in both runs; ClickHouse's query log shows the grouped run sent far fewer fills; the same content under a new name is all 40,000 known), `concurrent`, `big` (2.5M distinct lines in 5 slabs, now in two groups), `kill`, `freeze`, `lookalikes`, `workers`, `quality-gate` and `monitor`. The rehearsal script now stops with exit 2 when the stack runs on another image than the one a recreate would use (a stack brought up on a candidate had come back on the previous `:latest` in an earlier run).

The deploy and the measured batch follow.
