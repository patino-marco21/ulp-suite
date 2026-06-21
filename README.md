# ULP Suite

**ULP credential intelligence platform.** Ingest URL:Login:Password dumps at scale, search them instantly, monitor domains, and alert on new exposures — all self-hosted.

> ⚠️ **For authorized security research and internal threat intelligence only.** Do not deploy on public networks or use against systems you do not own or have explicit permission to test.

---

## What it is

ULP Suite ingests stealer log ULP (URL:Login:Password) credential lines, stores them in ClickHouse, and exposes a fast search and monitoring interface. It is designed for **tens to hundreds of billions of credential lines** and runs entirely on your own infrastructure.

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
  Next.js 14 (App Router)
       │
  ┌────┴────────────┐
  │                 │
ClickHouse       SQLite
(credentials,    (users, sessions,
 100B+ rows)      monitors, webhooks,
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
| App (Node.js 22) | 6 GB | 4 GB heap + 2 GB headroom |
| ClickHouse | 6 GB | Scales caches to limit |
| OS | ~2 GB minimum | |
| **Total** | **~14 GB** | 16 GB laptop recommended |

**8 GB laptop:** Lower both services to `mem_limit: 4g` in `docker-compose.yml`.

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
Run the dedup endpoint when you want to manually dedup after importing:
```bash
curl -s -b cookies.txt -X POST http://localhost:3000/api/admin/dedup | jq
```

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

# Run dedup after large imports
curl -s -b cookies.txt -X POST http://localhost:3000/api/admin/dedup | jq

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
# Install Node.js 22 via nvm
nvm install 22 && nvm alias default 22

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
- **Unique** — collapses exact `(url, email, password)` duplicates to one row each (`LIMIT 1 BY`).

Both are view-only — storage is untouched; toggle off to see everything.

The browser defaults to 200 rows per page, globally ordered Domain A→Z. Page size and sort order remain selectable in the UI and API.

### Content deduplication (storage)

Exact `(url,email,password)` duplicates accumulate when the same credential arrives across different combolist files. To remove them from storage:

The old post-file full-table dedup pass is removed; scheduled or manual dedup remains available.

```bash
# one-time (dry-run, then apply)
bash scripts/dedup-credentials-content.sh
APPLY=1 bash scripts/dedup-credentials-content.sh
```

The app supports scheduled or manual dedup — **report-only until you opt in**:

```bash
CONTENT_DEDUP_APPLY=true   # allow the background ALTER … DELETE
DEDUP_CRON_HOURS=24        # 0 disables the scheduled job
DEDUP_MIN_EXCESS=1000      # skip the (heavy) mutation below this many excess rows
```

### Ingest tier filter — permanently reject T3

Drops T3 rows **before insert**, so they never cost storage / dedup / index / query compute (see `lib/ingest-filter.ts`). T1, T2, and untiered (`@gmail`/`.com`, no country signal) remain accepted.

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

Tested at tens of billions of credential lines:

| Metric | Value |
|---|---|
| Insert throughput | ~1–2M rows/min on laptop SSD (single-process) |
| Peak heap per 500K-row batch | ~100 MB (array in memory before insert) |
| Dedup Set cap | 2M entries → ~440 MB max (prevents OOM on huge files) |
| Credential search P99 | <200 ms with ClickHouse bloom filters |
| Monitor re-scan tick | 15 minutes, in-process, no external queue |
| Inbox reconciliation | Every 30 s — catches any missed chokidar events |

---

## Contributing

Issues, pull requests, and security reports are welcome. Please open an issue before submitting large changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
