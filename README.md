# ULP Suite

**ULP credential intelligence platform.** Ingest URL:Login:Password dumps at scale, search them instantly, monitor domains, and alert on new exposures — all self-hosted.

> ⚠️ **For authorized security research and internal threat intelligence only.** Do not deploy on public networks or use against systems you do not own or have explicit permission to test.

---

## What it is

ULP Suite ingests stealer log ULP (URL:Login:Password) credential lines, stores them in ClickHouse, and exposes a fast search and monitoring interface. It is designed for **tens to hundreds of billions of credential lines** and runs entirely on your own infrastructure.

**Tech stack:** Next.js 14 · ClickHouse · SQLite · TypeScript · Docker

---

## Features

### Search & Discovery
- **Credential search** — query by email, domain, URL, password, or breach name; combine terms with AND (`+`), OR (`,`), NOT (`-`)
- **Batch lookup** — paste up to 100 emails and get all matches in one request; CSV export
- **Similar passwords** — find accounts reusing passwords similar to a target credential
- **Password reuse** — surface accounts sharing the same password across breaches
- **Breach explorer** — browse all imported breach sources with credential counts and metadata
- **Stats dashboard** — top domains, top emails, credential volume over time, TLD breakdown

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

---

## Getting Started

### Prerequisites

- Docker and Docker Compose v2
  - [Docker Desktop](https://www.docker.com/products/docker-desktop) (Windows/macOS)
  - Linux: `./install_docker.sh` or install `docker-ce` + `docker-compose-plugin`
- Git

### Quick Start

```bash
git clone https://github.com/patino-marco21/ulp-suite
cd ulp-suite

cp .env.example .env
# Edit .env — set strong passwords and a random JWT_SECRET

bash docker-start.sh
```

Open [http://localhost:3000](http://localhost:3000).

**Default credentials:**
- Email: `admin@ulpsuite.local`
- Password: `admin`

> Change the default password immediately after first login.

### Service URLs

| Service | URL |
|---|---|
| ULP Suite | http://localhost:3000 |

ClickHouse is intentionally NOT exposed on the host — it is only reachable inside the Docker network. To query it directly:

```bash
docker exec -it ulpsuite_clickhouse clickhouse-client
```

### Useful Commands

```bash
# View logs
docker compose logs -f

# Stop
docker compose down

# Restart
docker compose restart

# Check status
bash docker-status.sh
```

### Development (hot reload)

Run ClickHouse in Docker, Next.js locally:

```bash
# Start infrastructure only (no app container)
docker compose up -d clickhouse

# Configure local environment
cp env.local.example .env.local

yarn install
yarn dev
```

Open [http://localhost:3000](http://localhost:3000). Changes apply instantly without rebuilding Docker.

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
| Insert throughput | ~50–100K lines/sec per worker (single-process) |
| Peak heap per 500K-row batch | ~2 MB (CSV streaming) |
| Credential search P99 | <200 ms with ClickHouse bloom filters |
| Monitor re-scan tick | 15 minutes, in-process, no external queue |

---

## Contributing

Issues, pull requests, and security reports are welcome. Please open an issue before submitting large changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
