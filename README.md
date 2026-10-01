# ULP Suite

**ULP credential intelligence platform.** Ingest URL:Login:Password dumps at scale, search them instantly, monitor domains, and alert on new exposures — all self-hosted.

> ⚠️ **For authorized security research and internal threat intelligence only.** Do not deploy on public networks or use against systems you do not own or have explicit permission to test.

---

## What it is

ULP Suite ingests stealer log ULP (URL:Login:Password) credential lines, stores them in ClickHouse, and exposes a fast search and monitoring interface. It runs entirely on your own infrastructure, on one machine: the reference deployment holds **1.39 billion rows (~132 GiB on disk)** on a 32 GB laptop.

**Tech stack:** Next.js 15 · React 19 · ClickHouse · SQLite · TypeScript · Docker

---

## Features

### Search & Discovery
- **Credential search** — query by email, domain, URL, password, or breach name; combine terms with AND (`+`), OR (`,`), NOT (`-`)
- **Batch lookup** — paste up to 100 emails and get all matches in one request; CSV export
- **Breach explorer** — browse all imported breach sources with credential counts and metadata

### Upload & Ingestion
- Upload `.txt` / `.csv` ULP files or `.zip` archives via drag-and-drop
- **Live progress bar** — real-time import counter (lines imported, skipped, elapsed time) via Server-Sent Events
- RFC 3986-correct ULP parser — handles ports, IPv4, colons in passwords, tab/semicolon/colon separators
- CSV streaming insert into ClickHouse — peak heap ~2 MB per 500K-row batch (vs ~400 MB with JSON)
- `async_insert = 1` server-side buffering for sustained high-throughput ingestion

### Domain Monitoring
- Define monitors on one or more domains; match by credential, URL, or both
- **Scheduled re-scans** — each monitor runs on a configurable interval (1–168 hours)
- **Dedup mode** — alert only on credentials not previously seen
- **Digest mode** — alert on all current matches every interval (periodic summary)
- Webhook delivery to Slack, custom APIs, or any HTTP endpoint
- Alert history and webhook delivery status visible in the UI

### Self-Service Check Portal
- Public endpoint (`/check`) — users enter an email address and see which breaches it appears in
- Passwords are **never** exposed — breach names and domains only
- Rate-limited (10 req/IP/min, 50 req/email/hr) with no authentication required

### System
- **Roles** — Admin (full access) and Analyst (read-only search)
- **API keys** — role-scoped, rate-limited, optional expiry
- **REST API v1** — credential search, domain search, batch lookup, upload
- **Audit logs** — all admin actions logged with user, IP, and timestamp
- **API docs** — built-in interactive documentation at `/docs`

---

## Architecture

```
Browser / API client
       │
  Next.js 15 (App Router)
       │
  ┌────┴────────────┐
  │                 │
ClickHouse       SQLite
(credentials,    (users, sessions,
 1.39B rows)      monitors, webhooks,
                  API keys, audit log)
```

- **ClickHouse** — columnar store, MergeTree ORDER BY `(domain, email, imported_at)`, ZSTD(3) compression, monthly partitions, bloom filters on email/domain/url.
- **SQLite** — lightweight relational store for all metadata. No MySQL, no replication setup required.
- **Monitor cron** — 15-minute tick registered in `instrumentation.ts` (production only); runs in-process via `setInterval`.
- **Inbox watcher** — drop files into `./inbox/` and they process automatically. Polling + 30s reconciliation loop for reliability.

---

## Getting Started

### Prerequisites

- Docker and Docker Compose v2
  - [Docker Desktop](https://www.docker.com/products/docker-desktop) (Windows/macOS)
  - Linux: `./install_docker.sh` or install `docker-ce` + `docker-compose-plugin`
- Git

### RAM Requirements

| Component | Default `mem_limit` | Notes |
|---|---|---|
| App (Node.js 24) | 8 GB | 6 GB heap (`NODE_OPTIONS`) + 2 GB headroom |
| ClickHouse | 20 GB | `max_server_memory_usage` is 18 GB, 2 GB under the limit on purpose |
| OS | ~4 GB | |
| **Total** | **32 GB** | the sizing the 1.39B-row reference deployment runs on |

**Smaller machines:** lower the two `mem_limit`s in `docker-compose.yml` together with the
settings they back: `--max-old-space-size` in the app's `NODE_OPTIONS`, and
`max_server_memory_usage` in `docker/clickhouse/config/ulp-performance.xml`. Only the
32 GB sizing has been run at this table size.

### Quick Start (Ubuntu / Linux)

```bash
# 1. Install Docker Engine (skip if already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone and configure
git clone https://github.com/patino-marco21/ulp-suite
cd ulp-suite

cp .env.example .env
# Set a real JWT_SECRET:
sed -i "s|change-me-run-openssl-rand-hex-32|$(openssl rand -hex 32)|" .env
# Edit .env and change ADMIN_PASSWORD to something strong:
nano .env

# 3. Build and start (first build: 3-5 minutes)
docker compose up -d --build

# 4. Wait for ClickHouse (30-60 s on first run)
docker compose logs -f app | grep -m1 "Ready in"
```

Open [http://localhost:3000](http://localhost:3000). Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

> **Security:** Change the admin password immediately. The app logs a warning at startup if it is still `admin`.
>
> The app's port is published on **127.0.0.1 only** (reachable from the machine itself). To reach it from
> other machines set `APP_BIND_ADDR=0.0.0.0` in `.env` — and enrol 2FA for every account first.
>
> **Behind a reverse proxy**, set `TRUST_PROXY_HOPS` to the number of proxies that *append* the client's address to
> `X-Forwarded-For` (`1` for one nginx/Caddy/Traefik). Without it the app does not believe that header, because
> with nothing in front of the app the caller writes it: the public `/api/check` lookup (60 requests a minute and
> 4 in flight, shared by everyone), uploads and rescans then share one rate-limit budget instead of one per
> address, and the audit log stores the address as a lead rather than proof.

### Inbox folder (batch / automated uploads)

Drop credential files directly into `./inbox/` from the host:

Imports run in 100,000-row synchronous batches, and temporary ClickHouse outages pause and retry the active batch for up to 30 minutes; permanent or semantic failures still move the file to `./inbox/failed/`.

```bash
cp /path/to/dumps/*.txt ~/ulp-suite/inbox/

# Monitor progress at http://localhost:3000/inbox
# Or from terminal:
docker compose logs -f app | grep inbox-watcher
```

Files move to `./inbox/done/` on success, `./inbox/failed/` on failure.
Existing failed files must be retried from the Inbox Monitor after deployment:

```bash
mv ~/ulp-suite/inbox/failed/* ~/ulp-suite/inbox/
# Or click "Retry All" in the Inbox Monitor UI
```

**Large files:** Files with >2M unique credentials disable in-file dedup once the cap is hit. The old post-file full-table dedup step is removed; scheduled or manual dedup remains available.
For manual content dedup, use the one-off trigger script (report-only by default):
```bash
npx tsx scripts/run-content-dedup-once.ts
CONTENT_DEDUP_APPLY=true npx tsx scripts/run-content-dedup-once.ts
```
ClickHouse's port isn't published to the host, so run it from a throwaway container on the compose network — the exact `docker run` command is in the script's header comment.

### Import throughput tuning

Imports overlap parsing with ClickHouse inserts (pipelining) to cut idle wait
without raising peak memory beyond one extra batch. Two environment knobs:

- `IMPORT_PIPELINE` — `off` disables pipelining and reverts to strictly
  sequential parse→insert (kill-switch / A-B testing). Default: on.
- `UPLOAD_CONCURRENCY` — number of files processed at once. Default `1`.
  Raising it multiplies peak memory (each concurrent file holds its own
  in-flight batch and its own dedup set). Since `lib/clickhouse-memory-guard.ts`
  (see `docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md`)
  paces every batch and file claim against ClickHouse's own live memory
  pressure, raising this to 2–3 is reasonable on hosts with memory headroom —
  this deployment runs at 2. Known limitation: the Inbox Monitor's live
  progress display is a single slot, not per-job — at concurrency > 1 a
  still-running file's progress can go invisible if another concurrent file
  finishes first. Every file still gets its own row in the job log / Inbox
  Monitor history regardless; this only affects the live in-progress
  indicator.

Batch size stays a fixed 100,000 rows; inserts remain synchronous, in-order, and
retryable (unchanged from the resilience work).

**Benchmark** (needs local ClickHouse — `npm run docker:infra`):

    npx tsx scripts/benchmark-import.ts --rows 200000          # one run
    npx tsx scripts/benchmark-import.ts --sweep --json b.json  # batch × pipeline matrix
    npx tsx scripts/benchmark-import.ts --file ./sample.txt    # real local sample

It imports into a throwaway `ulp.bench_*` table (dropped after each run) and
never touches `ulp.credentials` or `ulp.sources`.

> Running the benchmark from the host requires the `CLICKHOUSE_*` variables in
> your shell (plain `tsx` does not auto-load `.env.local`) and a ClickHouse
> instance reachable from the host (the Docker service must publish port 8123).

### Service URLs

| Service | URL |
|---|---|
| ULP Suite | http://localhost:3000 |
| Inbox Monitor | http://localhost:3000/inbox |
| API Docs | http://localhost:3000/docs |

ClickHouse is intentionally NOT exposed on the host — it is only reachable inside the Docker network. To query it directly:

```bash
docker exec -it ulpsuite_clickhouse clickhouse-client
```

### Useful Commands

```bash
# View all logs
docker compose logs -f

# Stop (data is preserved)
docker compose down

# Rebuild after git pull
git pull && docker compose up -d --build

# ⚠️ DANGER: erase ALL ClickHouse credential data
docker compose down -v

# Row count
docker exec ulpsuite_clickhouse clickhouse-client \
  --query "SELECT formatReadableQuantity(count()) FROM ulp.credentials"

# Run manual content dedup (dry-run by default)
npx tsx scripts/run-content-dedup-once.ts

# Check ClickHouse async-insert health (failures + throughput, last 60 min)
curl -s -b cookies.txt http://localhost:3000/api/monitoring/async-inserts | jq

# Check ClickHouse mutation status (MATERIALIZE COLUMN/INDEX progress, stuck mutations)
curl -s -b cookies.txt http://localhost:3000/api/monitoring/mutations | jq

# Find slow/failed queries (last 60 min, duration >= 200ms)
curl -s -b cookies.txt http://localhost:3000/api/monitoring/slow-queries | jq
```

### Development (hot reload)

Run ClickHouse in Docker, Next.js on the host:

```bash
# Install Node.js 24 via nvm
nvm install 24 && nvm alias default 24

# Start ClickHouse only
docker compose up -d clickhouse

# Copy .env and install
cp .env.example .env  # set JWT_SECRET
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Changes apply instantly without rebuilding Docker.

---

## Filtering & deduplication

Three layers, from non-destructive view filters to permanent ingest-time drops.

### Browser view toggles (non-destructive, default-on)

In the Credentials Browser:

- **Declutter** — hides low-signal rows (IP-host / `:port` / `.php` / `localhost` URLs). Backed by a precomputed `is_noise` column, so it's a cheap filter, not a per-row scan.
- **Unique** — collapses `(url, email, password)` duplicates to one row each (`LIMIT 1 BY`), ignoring URL scheme and a trailing slash — `http://`, `https://`, and no-scheme captures of the same host+path count as the same row; email/password stay exact.

Both are view-only — storage is untouched; toggle off to see everything.

The browser defaults to 200 rows per page, globally ordered Domain A→Z. Page size and sort order remain selectable in the UI and API.

### Content deduplication (storage)

`(url,email,password)` duplicates accumulate when the same credential arrives across different combolist files — ignoring URL scheme and a trailing slash, same as the browser's Unique toggle above; email/password stay exact. To remove them from storage:

The old post-file full-table dedup pass is removed; scheduled or manual dedup remains available.

```bash
# one-time (dry-run, then apply)
npx tsx scripts/run-content-dedup-once.ts
CONTENT_DEDUP_APPLY=true npx tsx scripts/run-content-dedup-once.ts
```

The app supports scheduled or manual dedup — **report-only until you opt in**:

```bash
CONTENT_DEDUP_APPLY=true   # allow the background ALTER … DELETE
DEDUP_CRON_HOURS=24        # 0 disables the scheduled job
DEDUP_MIN_EXCESS=1000      # skip the (heavy) rewrite below this many excess rows (the 1.39B-row deployment uses 14000000, ~1% of the table)
```

### Ingest tier filter — permanently reject T3

Drops T3 rows **before insert**, so they never cost storage / dedup / index / query compute (see `lib/ingest-filter.ts`). T1, T2, and untiered (`@gmail`/`.com`, no country signal) remain accepted.

Hard-tier drops (`INGEST_FILTER_HARD_DROP_TIERS`, e.g. `T3`) are rejected at parse
time — the row is dropped the instant it's classified, and shows up as
`tier_dropped` in an import's "why lines were skipped" breakdown.

```bash
INGEST_FILTER_HARD_DROP_TIERS=T3   # default; keep suffixes cannot override this
INGEST_FILTER_DROP_TIERS=          # no soft tier drops
INGEST_FILTER_KEEP_SUFFIXES=
INGEST_FILTER_DROP_NOISE=true   # also drop junk URLs (same isNoiseUrl as Declutter)
# Saudi Arabia (.sa) is T3 and rejected; UAE (.ae) is T2 and retained.
```

Evaluated noise-first → hard tier → keep → soft tier → suffix. Hard tiers are non-overridable. `DROP_NOISE` drops IP/`:port`/`.php`/`localhost`/single-label/non-web-scheme URLs at ingest regardless of country; `android://` is kept.

Companion scripts:

```bash
# see your data's tier / country breakdown (read-only)
bash scripts/tier-distribution.sh

# purge the existing T3 backlog (dry-run first)
bash scripts/purge-existing-t3.sh

# destructive mode with a verified backup
BACKUP_VERIFIED=1 APPLY=1 bash scripts/purge-existing-t3.sh

# destructive mode without a backup — irreversible
ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh
```

After pulling an update, rerun the same destructive command if an earlier purge failed. The script cancels only a failed exact T3 mutation, refuses to run while any other credential-table mutation is active, and then uses a bounded-memory lightweight delete. The rows become invisible when the command completes; background merges reclaim physical disk space gradually, so the script does not run a memory-intensive `OPTIMIZE FINAL`.

#### Purge safety gate

The purges select rows by the **stored** `country_tier` (and `tld` / `email_domain`) columns, which are a SQL copy of `lib/country-tiers.ts`, and the copy has drifted. On 2026-10-01, 1,919,919 rows were stored as `T3` and the importer's own `classifyTier()` called none of the rows it was shown T3: the stored expression treats a login with no `@` as if it were an email domain (`ED` in `buildCountryTierExpression()`), and its provider lists are an older snapshot (`att.com` is T1 in the code). The importer's T3 hard-drop is unaffected; only the stored label is wrong, so a purge on that label would have deleted mainstream sign-ins the importer accepts.

So `scripts/purge-existing-t3.sh` and `scripts/purge-existing-low-tier.sh` never delete on the label alone. Both first stream every candidate row through the importer's own decision (`shouldDropAtIngest()`, via `scripts/audit-purge-candidates.ts`, which needs `npm ci` for `tsx`), in the dry run as well as in apply mode. If the importer would have kept even one candidate, apply mode exits 3 without deleting and the dry run prints `BLOCKED`, with counts only and never row content. The audit stops reading after the first 1,000 disagreements. When it passes, the script re-counts the candidates just before deleting and refuses if they changed.

Until the stored column is repaired (a DDL change plus a `MATERIALIZE COLUMN` over the whole table, not done yet), both purges report `BLOCKED` on this data. That is expected: on 2026-10-01 none of the rows checked were rows the importer would have dropped, which fits the importer having dropped T3 since the hard-drop shipped.

Tiers: **T1** = US/UK/CA/AU/NZ · **T2** = W.Europe/JP/KR/SG/IL/AE · **T3** = RU/CN/BR/LATAM/SEA.

---

## API

Authentication: `Authorization: Bearer <api-key>` header.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/search/credentials` | Search credentials by email, domain, URL, password, breach |
| `GET` | `/api/v1/search/domain` | Domain/keyword search with subdomain and path aggregation |
| `POST` | `/api/v1/lookup` | Batch lookup up to 100 emails |
| `POST` | `/api/v1/upload` | Upload ULP file (admin keys only) |
| `GET` | `/api/check` | Public self-service breach check (no key required) |

Full interactive docs at `/docs` when the app is running.

---

## Performance

Reference deployment: 1.39 billion rows, one 32 GB laptop (cold timings, measured 2026-09/10):

| Metric | Value |
|---|---|
| Insert throughput | ~1–2M rows/min on laptop SSD (single-process) |
| Peak heap per 500K-row batch | ~100 MB (array in memory before insert) |
| Dedup Set cap | 2M entries → ~440 MB max (prevents OOM on huge files) |
| Exact domain / email lookup | 0.03–1.3 s cold (bloom filters + primary key); a very popular value such as `admin@gmail.com` takes 7–23 s |
| Token / substring search | seconds to tens of seconds depending on the term and sort; the total is a separate query that arrives after the rows |
| Domain-monitor re-scan | ~5 s per tick for 17 domains (reversed-key projections + a single normalising pass over the legacy bucket) |
| Monitor re-scan tick | 15 minutes, in-process, no external queue |
| Inbox reconciliation | Every 30 s — catches any missed chokidar events |

---

## Operations

- **Disk space.** The app checks free space on the ClickHouse data disk every 10 minutes
  (`lib/disk-watch.ts`), logs a warning when it gets low, and shows it in the Ingest Health panel
  (Upload and Inbox pages). Optional: `DISK_ALERT_WEBHOOK_URL` also POSTs each alert to a
  Slack-compatible webhook; nothing is sent anywhere unless you set it. Heavy jobs (dedup, projection
  restores) refuse to start below the same floor.
- **Backups.** The app snapshots its own SQLite (users, API keys, monitors) into `./data/backups` daily.
  ClickHouse backups are taken with `./scripts/clickhouse-backup.sh` and need an S3-compatible
  destination (`S3_*` in `.env`); until one exists the panel says "No ClickHouse backup recorded".
  Read `docs/clickhouse-backup-runbook.md` first — it explains why local snapshots are guarded by a
  disk-space check.
- **Durability.** Inserts and merges are fsynced (`fsync_after_insert`, and `min_rows_to_fsync_after_merge`
  from DDL v25).
- **Known data-quality gap.** About 6.3M rows (0.45%) imported by an earlier parser sit in the wrong
  columns, so an exact domain/email filter cannot see them; see the header of `lib/ulp-normalize.ts`.

---

## Contributing

Issues, pull requests, and security reports are welcome. Please open an issue before submitting large changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
