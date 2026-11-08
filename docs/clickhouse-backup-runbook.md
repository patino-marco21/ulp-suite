# ClickHouse Backup Runbook (P0 — Disaster Recovery)

**Goal:** get a verified, **off-host** backup of `ulp.credentials`. Until one exists, losing
the disk (or one bad operation) loses every credential — the Ingest Health panel says
"No ClickHouse backup recorded" until `scripts/clickhouse-backup.sh` records one.

**Where things stand (2026-10-01):** `ulp.credentials` is 1.39 B rows / ~132 GiB on disk
(~92 GiB without its projections) on a 937 GiB disk with ~160–220 GiB free. No S3 destination
is configured, so no ClickHouse backup has ever been taken. The app's own SQLite (users, API
keys, monitors) *is* snapshotted automatically — see §6.

**Model (local + S3):**
- **Local** snapshots = hardlinks under `/var/lib/clickhouse/backup`. Instant and free *at the
  moment they are made*, but on the **same disk** as the live data, so they protect against a
  `DROP` or a bad migration, **not** against disk failure — and they **pin disk space** (see
  *Why local snapshots are guarded*).
- **S3** copy = true off-host disaster recovery; survives total host/disk loss.

Tool: [`clickhouse-backup`](https://github.com/Altinity/clickhouse-backup), run as a
profile-gated compose sidecar that shares the ClickHouse data volume. **It never starts
with `docker compose up`** and never restarts your `clickhouse`/`app` services. Drive it
through `./scripts/clickhouse-backup.sh` (run it with no argument for the command list).

---

## What gets backed up (and what must not)

The wrapper backs up the **live tables only** — by default every table in `ulp` except names
starting `credentials_` or `zz_` (today: `ulp.credentials`, `ulp.sources`, `ulp.domains`).
Override with `BACKUP_TABLES=db.table,db.table`.

It deliberately does **not** use `ulp.*`. The database can also hold dedup scratch tables and, after an applying dedup cycle,
a pre-dedup archive named `ulp.credentials_predup_auto` (the last one was dropped on 2026-11-08, see the last section). A
wildcard would snapshot such tables too — pinning their parts, so dropping them afterwards would free
nothing until the snapshot is deleted — and would try to upload over a hundred GiB it does not need.

## Why local snapshots are guarded

A hardlink snapshot costs nothing until a merge replaces the parts it points at; from then on
the old parts stay on disk until the snapshot is deleted. A merge of one partition can
therefore cost that partition's whole size (today ~68 GiB). On a disk that can dip to
~160 GiB free during an ordinary merge, that matters. So `full`, `inc` and `local` first run
the **space guard**: they refuse unless *free space − the largest partition ≥ the floor*
(the same floor the app's disk guard uses: the stricter of 50 GiB and 15% of the disk).

```bash
./scripts/clickhouse-backup.sh space     # prints the numbers; changes nothing
```

`BACKUP_FORCE=1` skips the guard if you have read the numbers and accept the risk.
`full`/`inc` also delete their local copy as soon as the upload finishes
(`--delete-source`), and local retention is 2, to keep the pinned window short.

---

## 0. Prerequisites (one time)

1. Create an S3 (or S3-compatible) bucket — AWS S3, Backblaze B2, Wasabi, MinIO, etc.
   Use a **dedicated** bucket with versioning on if available.
2. Create access keys scoped to that bucket only.
3. Fill the `S3_*` vars in `.env` (see `.env.example`):
   ```
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   S3_BUCKET=your-bucket
   S3_ENDPOINT=            # blank for AWS; set for B2/Wasabi/MinIO
   S3_REGION=us-east-1
   S3_PATH=clickhouse-backups/ulpsuite
   ```
   (MinIO / some gateways: also set `force_path_style: true` in
   `docker/clickhouse-backup/config.yml`.)

> `docker-compose.yml` pins the sidecar image (`altinity/clickhouse-backup:2.7.2`, verified
> against ClickHouse 26.3). Keep it pinned.

## 1. Check the disk first

```bash
./scripts/clickhouse-backup.sh space
```

## 2. First backup (S3)

```bash
./scripts/clickhouse-backup.sh full
```

Expected: a `ulp-full-<timestamp>` backup is created, uploaded to S3 (resumable if the
connection drops: re-run the same command), and its local copy deleted. At ~132 GiB the
upload takes as long as your uplink needs for ~90–130 GiB of zstd-compressed parts; the
projections are derived data (the restore code in `lib/credentials-projections.ts`
rebuilds them), so if bandwidth is the limit, clickhouse-backup's `--skip-projections`
option (see `clickhouse-backup create_remote --help`; untested here) can leave them out
of the upload.

## 3. Confirm it exists, and that the app knows

```bash
./scripts/clickhouse-backup.sh status
```

Prints the local and remote lists and the last recorded backup; exits non-zero when there is
none, it is older than `BACKUP_MAX_AGE_HOURS` (default 72), or it never left this disk. The
Ingest Health panel shows the same ("ClickHouse backup 3 h ago (off-host)").

## 4. Prove it actually restores (DR drill — do not skip)

A backup you've never restored is a hope, not a backup. This restores the latest S3
backup into a throwaway `ulp_verify` database and counts rows — **the live `ulp` db is
never touched**:

```bash
./scripts/clickhouse-backup.sh verify
```

It needs free space for a second copy of the data (~132 GiB) — run `space` and make sure
that fits first. Compare the printed `ulp_verify.credentials` count against the live table:

```bash
docker exec ulpsuite_clickhouse clickhouse-client -q 'SELECT count() FROM ulp.credentials'
```

They should match (~1.39 B today). Then drop the drill db:

```bash
docker exec ulpsuite_clickhouse clickhouse-client -q 'DROP DATABASE ulp_verify'
```

> Run the drill on a schedule (e.g. monthly) rather than every backup — it restores the
> whole table.

## 5. Schedule it (host cron)

Daily incremental (only changed parts upload), weekly full, monthly DR drill:

```cron
# m h  dom mon dow   command   (cd to your repo root first)
15 3   *   *   1-6   cd ~/ulp-suite && ./scripts/clickhouse-backup.sh inc   >> ~/ch-backup.log 2>&1
15 3   *   *   0     cd ~/ulp-suite && ./scripts/clickhouse-backup.sh full  >> ~/ch-backup.log 2>&1
30 4   1   *   *     cd ~/ulp-suite && ./scripts/clickhouse-backup.sh verify >> ~/ch-backup.log 2>&1
```

The wrapper exits 2 when the space guard refuses, so a cron run on a nearly-full disk fails
loudly in the log instead of eating the last of the headroom. This laptop also suspends:
cron does not run while it sleeps, so check `status` after long gaps.

## 6. The app's SQLite (users, API keys, monitors) — automatic

Users, API keys, monitors, webhooks, the audit log and `ch_ddl_version` live in SQLite at
`./data/ulp.db`, **outside** ClickHouse, so `clickhouse-backup` does not see them. The app
snapshots it on its own (`lib/sqlite-backup.ts`): SQLite's online backup API into
`./data/backups/ulp-YYYYMMDD-HHMMSS.db` whenever the newest snapshot is older than
`SQLITE_BACKUP_HOURS` (default 24), each snapshot opened and integrity-checked before it
counts, the newest `SQLITE_BACKUP_KEEP` (default 7) kept. No host cron needed.

These sit on the same disk as the live file. For protection against losing the disk, copy
the folder off the machine, e.g. `rclone sync ~/ulp-suite/data/backups remote:ulp-sqlite`
or `aws s3 sync ~/ulp-suite/data/backups s3://your-bucket/clickhouse-backups/ulpsuite/sqlite/`.
To restore: stop the app, copy a snapshot over `data/ulp.db` (delete `ulp.db-wal` and
`ulp.db-shm` first), start the app.

---

## S3-compatible targets (MinIO) and the first backup

**Rehearsed on 2026-10-12** against a throwaway MinIO container with a small synthetic table (no credentials, torn down afterwards): `full`, `inc`
(only the new part uploads), `list`, `status` and a partition-limited backup all worked, and the restore drill matched the live table row for row
(equal row counts and equal sums of the content hash). The drill needed two fixes, both made: `clickhouse.default_replica_path` in
`docker/clickhouse-backup/config.yml` (the tool's default uses a `{cluster}` macro this server does not define) and `--tables 'ulp.*'` in the wrapper's
`verify` (a comma list together with `--restore-database-mapping` builds a pattern that matches no table).

For MinIO and other self-hosted targets set `S3_FORCE_PATH_STYLE=true` (and `S3_DISABLE_SSL=true` for plain http) in `.env`; the compose service forwards both.

The space guard refuses a real backup while free space minus the largest partition is below the floor (140.5 GiB on this disk), which is not the case for
a long time on this laptop. The first real backup is the **closed months only**:

```bash
./scripts/clickhouse-backup.sh space                      # read the numbers
BACKUP_TABLES=ulp.credentials BACKUP_PARTITIONS=202607,202608 BACKUP_FORCE=1 ./scripts/clickhouse-backup.sh full
./scripts/clickhouse-backup.sh status && ./scripts/clickhouse-backup.sh verify
```

`BACKUP_FORCE=1` is justified here because the two closed months receive no writes, so a merge cannot pin their parts under the snapshot. The partition that
the current import fills can be rebuilt from the originals (or from the side copy), so it does not need a backup of its own.

---

## Real restore (actual disaster)

```bash
./scripts/clickhouse-backup.sh list                 # find the backup name
./scripts/clickhouse-backup.sh restore <backup-name> # asks you to type the name to confirm
docker exec ulpsuite_clickhouse clickhouse-client -q 'SELECT count() FROM ulp.credentials'
```

If the whole box is gone: stand up the stack on new hardware (`docker compose up -d`),
fill `.env` with the same `S3_*`, then `restore <name>` pulls from S3 and rebuilds. Restore
the SQLite snapshot too (§6) or you will have the data but no accounts.

## The pre-dedup archive (dropped on 2026-11-08)

`ulp.credentials_predup_auto` was what the 2026-09-30 content-dedup cutover left behind: the July and August 2026
partitions as they were before the duplicates were removed (2,778,102,283 rows, 381.20 GiB; 138.43 GiB after its two
projections were dropped on 2026-10-18). It was a rollback net for logical mistakes, not a disk-failure backup: it sat
on the same disk as everything else. **It was dropped on 2026-11-08 at the owner's go**, and free disk went from 196 to 335 GiB (the ClickHouse store from about 437 to 298 GiB) once the 480-second window had passed.

Why the drop was safe, checked read-only the same day:

- **No credential went with it.** In two independent slices (`content_key_hash % 64` = 0 and 17), 0 of the 43.55M
  distinct archive keys were missing from the live table; the cutover itself had been verified lossless (identical
  distinct-key count and checksum).
- **Nothing used it.** No view, dictionary or table depended on it, and no query had touched it for weeks. The only
  code that names it is the apply path of the dedup tick (`CONTENT_DEDUP_APPLY=false`, `DEDUP_CRON_HOURS=0`), which drops it with
  `DROP TABLE IF EXISTS`.
- **None of its files were shared.** No file was hardlinked to another table and `shadow/` and `backup/` were empty, so
  the whole 138 GiB came back.

What went with it: the duplicate rows (1,384,652,732 at the cutover) and their file lineage (the live table keeps the
`was_duplicated` flag and the earliest source file and import time), and the ClickHouse-side second copy of the old
rows. A sample on 2026-10-18 found that roughly a quarter to a third of the old rows exist only in ClickHouse, so the live
table is now the only copy of them. There is still no off-disk backup (the owner parked it on 2026-10-13 and again on
2026-11-08).

How it was dropped, and how to drop a table over 50 GB the same way:

```
DROP TABLE ulp.credentials_predup_auto SETTINGS max_table_size_to_drop = 0
```

without `SYNC`. The default 50 GB limit refuses a bigger table with Code 359, and the query-level setting lifts it.
Without `SYNC` the table stays recoverable for 480 seconds (`database_atomic_delay_before_drop_table_sec`):
`UNDROP TABLE ulp.credentials_predup_auto` brings it back; after that the drop is permanent and the space returns.
Both behaviours were rehearsed first on a throwaway ReplicatedMergeTree table on this server (26.3.17): a drop under a
1-byte limit was refused and left the table intact, the override dropped it, and `UNDROP` returned all 2,000,000 rows,
writable, with an empty replication queue. `SYNC` skips the window and frees the space at once.

If the apply path of the dedup tick is ever switched on again, it builds a full new copy of the table and renames the live
one to this name, so it needs the free disk for that copy (the tick checks it first), and it drops the previous archive
by itself in its next applying cycle.

---

## Caveats & troubleshooting

- **Local backups share the live disk.** They protect against logical loss (DROP, bad
  migration, the duplicate/reprocess bugs in this project's history), not hardware loss —
  and they pin disk space (see above). S3 is the hardware-loss defense — that's why we do both.
- **`check_parts_columns`:** clickhouse-backup refuses a table whose parts disagree on a
  column's type; if that bites, fix the cause (or add `--skip-check-parts-columns`).
- **No S3 configured:** `list`/`status`/`delete` wait ~30 s while the client retries
  the instance-metadata endpoint, then continue; local-only commands (`space`, `local`) work.
- **Permissions:** the sidecar must read/hardlink the ClickHouse data volume. If you hit
  permission errors, the volume is owned by the `clickhouse` user (uid 101); run the
  sidecar as that uid (`user: "101:101"` on the service) or as root.
- **Native port:** the sidecar talks to `clickhouse:9000` on the internal Docker
  network — no host port is exposed, by design.
- **This only protects existing data.** It is **not** high availability.
- **Durability of what you back up:** inserts are fsynced (`fsync_after_insert`) and, since
  DDL v25, so are merges that produce a wide part (`min_rows_to_fsync_after_merge`,
  `min_compressed_bytes_to_fsync_after_merge`).
