# ClickHouse Backup Runbook (P0 — Disaster Recovery)

**Goal:** get a verified, off-host backup of `ulp.credentials` **before** the table
grows or anything else changes. This system has already lost data once on this exact
single-volume setup; this is the first and highest-value protection.

**Model (your choice — local + S3):**
- **Local** snapshots = hardlinks under `/var/lib/clickhouse/backup`. Instant, cheap,
  but on the **same disk** as the live data → fast restore from an accidental `DROP`
  or bad migration, **not** a defense against disk failure.
- **S3** copy = true off-host disaster recovery; survives total host/disk loss.

Tool: [`clickhouse-backup`](https://github.com/Altinity/clickhouse-backup), run as a
profile-gated compose sidecar that shares the ClickHouse data volume. **It never starts
with `docker compose up`** and never restarts your `clickhouse`/`app` services.

---

## 0. Prerequisites (one time)

1. Create an S3 (or S3-compatible) bucket — AWS S3, Backblaze B2, Wasabi, MinIO, etc.
   Use a **dedicated** bucket with versioning on if available.
2. Create access keys scoped to that bucket only.
3. Fill the new `S3_*` vars in `.env` (see `.env.example`):
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

---

## 1. Pin the image version

`docker-compose.yml` ships `altinity/clickhouse-backup:latest` so the first pull
works. Pin it immediately so a future `:latest` can't change behavior under you:

```bash
./scripts/clickhouse-backup.sh version
# then edit docker-compose.yml: altinity/clickhouse-backup:<that-version>
```

## 2. First backup (local + S3)

```bash
./scripts/clickhouse-backup.sh full
```

Expected: a `ulp-full-<timestamp>` backup is created locally and uploaded to S3.
At today's size (~500 MiB) this is seconds.

## 3. Confirm it exists in both places

```bash
./scripts/clickhouse-backup.sh list
```

You should see the backup under **both** "Local backups" and "Remote backups".

## 4. Prove it actually restores (DR drill — do not skip)

A backup you've never restored is a hope, not a backup. This restores the latest S3
backup into a throwaway `ulp_verify` database and counts rows — **the live `ulp` db is
never touched**:

```bash
./scripts/clickhouse-backup.sh verify
```

Compare the printed `ulp_verify.credentials` count against the live table:

```bash
docker exec ulpsuite_clickhouse clickhouse-client -q 'SELECT count() FROM ulp.credentials'
```

They should match (~21.2M today). Then drop the drill db:

```bash
docker exec ulpsuite_clickhouse clickhouse-client -q 'DROP DATABASE ulp_verify'
```

> At billions of rows this drill restores a lot of data — run it on a schedule
> (e.g. monthly) rather than every backup once the table is large.

## 5. Schedule it (host cron)

Daily incremental (only changed parts upload), weekly full, monthly DR drill:

```cron
# m h  dom mon dow   command   (cd to your repo root first)
15 3   *   *   1-6   cd ~/ulp-suite && ./scripts/clickhouse-backup.sh inc   >> ~/ch-backup.log 2>&1
15 3   *   *   0     cd ~/ulp-suite && ./scripts/clickhouse-backup.sh full  >> ~/ch-backup.log 2>&1
30 4   1   *   *     cd ~/ulp-suite && ./scripts/clickhouse-backup.sh verify >> ~/ch-backup.log 2>&1
```

## 6. Also back up the app metadata (SQLite — NOT covered by clickhouse-backup)

Users, API keys, monitors, audit logs, and the `ch_ddl_version` live in SQLite at
`./data/ulp.db` (bind-mounted), **outside** ClickHouse. `clickhouse-backup` does not
see it. It's a single file — copy it off-host too:

```cron
0 3 * * * sqlite3 ~/ulp-suite/data/ulp.db ".backup '/tmp/ulp.db.bak'" && \
          aws s3 cp /tmp/ulp.db.bak s3://your-bucket/clickhouse-backups/ulpsuite/sqlite/ulp.db.$(date -u +\%Y\%m\%d)
```

(Use `.backup` rather than `cp` so you get a consistent snapshot even while the app
is writing. Swap `aws s3 cp` for your provider's CLI / `rclone` as needed.)

---

## Real restore (actual disaster)

```bash
./scripts/clickhouse-backup.sh list                 # find the backup name
./scripts/clickhouse-backup.sh restore <backup-name> # asks you to type the name to confirm
docker exec ulpsuite_clickhouse clickhouse-client -q 'SELECT count() FROM ulp.credentials'
```

If the whole box is gone: stand up the stack on new hardware (`docker compose up -d`),
fill `.env` with the same `S3_*`, then `restore <name>` pulls from S3 and rebuilds.

---

## Caveats & troubleshooting

- **Local backups share the live disk.** They protect against logical loss (DROP, bad
  migration, the duplicate/reprocess bugs in this project's history), not hardware loss.
  S3 is the hardware-loss defense — that's why we do both.
- **Permissions:** the sidecar must read/hardlink the ClickHouse data volume. If you hit
  permission errors, the volume is owned by the `clickhouse` user (uid 101); run the
  sidecar as that uid (`user: "101:101"` on the service) or as root.
- **Native port:** the sidecar talks to `clickhouse:9000` on the internal Docker
  network — no host port is exposed, by design.
- **This only protects existing data.** It is **not** high availability. Next P0 steps:
  (#2) `ReplicatedMergeTree` + Keeper for HA and free insert-dedup, (#3) fsync settings
  for durability. Do those after you have a verified backup in hand (this runbook).
