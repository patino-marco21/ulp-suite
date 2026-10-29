# ULP Suite

**ULP credential intelligence platform.** Ingest URL:Login:Password dumps at scale, search them instantly, monitor domains, and alert on new exposures — all self-hosted.

> ⚠️ **For authorized security research and internal threat intelligence only.** Do not deploy on public networks or use against systems you do not own or have explicit permission to test.

---

## What it is

ULP Suite ingests stealer log ULP (URL:Login:Password) credential lines, stores them in ClickHouse, and exposes a fast search and monitoring interface. It runs entirely on your own infrastructure, on one machine: the reference deployment holds **1.87 billion rows (~156 GiB on disk)** on a 32 GB laptop.

**Tech stack:** Next.js 15 · React 19 · ClickHouse · SQLite · TypeScript · Docker

---

## Features

### Search & Discovery
- **Credential search** — query by email, domain, URL, password, or breach name; separate terms with commas (every term must match) and put `-` in front of a term to exclude it
- **Search in** — a dropdown beside the search box: *All fields* (the default), *Login (whole word)* (about 0.2 s on 1.8 billion rows) or *Login (contains)* (anywhere in the login, a scan of the login column, about 25 s). `login:name` in the box always means a whole word in the login, whatever the dropdown says (`-login:name` excludes). A full address (`name@host`) is an exact match that ignores letter case, so every stored casing of it is found (about 0.4-2 s). Case is folded for ASCII letters only. A search for the literal text `login:…` now means the scope.
- **Batch lookup** — paste up to 100 emails, domains or URLs (a mixed list is fine; each line is recognised on its own) and get all matches in one request; CSV export. What is pasted is cleaned to what the table stores: a URL, `www.` host or `host:port` is looked up as the bare host, and `<a@b.tld>`, `mailto:a@b.tld` or `a@b.tld:password` as the address. 100 addresses take about 3 s (`lib/batch-input.ts`, `lib/batch-lookup.ts`)
- **Site counts** — paste or upload a list of sites (up to 2,000) and see how many rows there are for each, without the rows: the site's own host and its subdomains told apart, the subdomains with the most rows, a click on any number column's header to sort by it (biggest first, then smallest first, then the default order), CSV export in the order shown, optionally only rows imported in a window. A URL, `www.` host, `host:port` or `*.host` is cleaned to the bare host and a path is ignored. A site can be marked Done, Skip or To look at, with a note, and the mark stays with the site: it is kept in SQLite under the host the counts name, so every spelling of a site shows one mark, and it is shared by everyone who signs in. Chips narrow the table by mark, the Mark header sorts by it, and Export CSV follows what is shown (`lib/site-marks.ts`, `POST` and `PUT /api/lookup/marks`). The reversed-domain projection finds the subdomains, so a list of 100 takes about 2 s (`lib/site-counts.ts`, page `/counts`)
- **Export** — CSV, ULP (`url:login:pass`), `login:pass` and NDJSON exports stream up to 1,000,000 rows (about 215 MiB as CSV) with a running row count on the button; JSON keeps 10,000. "Since last export" only moves when the file was not cut (a result of exactly 1,000,000 rows counts as possibly cut). A broad newest-first export can take about two minutes to start.
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
- Webhook delivery to Slack, custom APIs, or any HTTP endpoint on a public address (localhost, private and cloud-metadata targets are refused and redirects are not followed; `WEBHOOK_ALLOW_PRIVATE_HOSTS=1` allows a receiver on your own network)
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
 1.87B rows)      monitors, webhooks,
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
| ClickHouse | 16 GB | `max_server_memory_usage` is 14 GB, 2 GB under the limit on purpose |
| OS and desktop | ~8 GB | a desktop session with a browser and a few other containers held about 7.5 GB when measured |
| **Total** | **32 GB** | the sizing the 1.87B-row reference deployment runs on |

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
`done/` is cleaned at every app start: a file leaves it only when the job log says it was imported more than 7 days ago **and** the [source archive](docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md) holds that exact file (the same name and size in its manifest, or, for an `.archiveref`, the archive file it points to). A file nobody archived is never deleted, however old; the start-up log (`docker compose logs app | grep cleanup`) says how many files and GiB are waiting for `scripts/archive-sources.ts`. The age counts from the import, not from the date of the file, and a manifest the app cannot read deletes nothing.
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

### Uploading over HTTP

The Upload page, `POST /api/upload` and `POST /api/v1/upload` receive the whole
file into a spool directory before they answer, then import from that file. A
connection that drops mid-upload imports nothing and leaves no file behind, and a
busy queue only delays the import; it can no longer wedge it. The request must
finish arriving within five minutes (a Node limit), so files too large for your
link are better dropped in `inbox/`, which has no such limit. `/api/upload`
answers as soon as the file is safely on disk and reports progress over SSE;
`/api/v1/upload` answers when the import has finished.

- `UPLOAD_SPOOL_DIR` — where uploads are received. Default `/tmp/ulp-spool`
  inside the container.
- `UPLOAD_SPOOL_MIN_FREE_BYTES` — an upload that would leave less than this free
  is refused (HTTP 507). Default 20 GiB; the disk is shared with ClickHouse.


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
  this deployment runs at 2. The Inbox page shows one progress card per file
  in flight (`jobs_progress` in `GET /api/inbox/status`); a plain file and a
  file read from the archive report the share of the file read from the bytes
  read, so the bar and the ETA do not depend on the length of a line. The
  job log records, for every finished file, the rows that repeat inside it
  (`repeats`) and a note when the same-name check skipped it
  (`already-imported`), so imported + already-known + repeated + rejected add
  up to the lines of the file.
- `IMPORT_STALL_TIMEOUT_MS` — an import that makes no progress for this long (no
  batch inserted, no retry, no memory-guard poll) is failed and its queue slot
  freed. Time is measured while the machine is awake, so a laptop suspend does
  not trip it. Default `1200000` (20 minutes).
- `INGEST_NOVELTY_CHECK` — novelty-aware ingest, on by default (`lib/ingest-novelty.ts`,
  `docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md`). A file is parsed into a private
  stage table and only the credentials `ulp.credentials` does not hold yet are written; every import
  reports **new / already in the database / repeated in the file**, a finished file is remembered in
  `ulp.sources` even when it added nothing, and a retry never duplicates a row (`imported` now means new
  rows). A fully new file takes about 50% longer than the direct path; a file the database already
  holds costs the parse and one scan of one column. `off` imports straight into `ulp.credentials` as before.
- `INGEST_NOVELTY_SLAB_ROWS` — rows per commit step (default `20000000`, at least `1000`). Files below
  this are committed in one step; larger ones in hash slabs, one slab at a time across all imports.
- `INGEST_COMMIT_INSERT_THREADS` — `max_insert_threads` for the commit insert (default `4`, `1` to `16`). Measured on the exact
  statement against the live table definition: 142k rows/s with the server's default, 452k with 4, nothing more with 8
  (`docs/superpowers/specs/2026-10-12-fast-ingest-design.md`, step A2).
- `CLICKHOUSE_COMPRESS_REQUESTS` — set `1` to gzip INSERT bodies again. Off by default: ClickHouse is on the same machine or
  network, where gzip only cost CPU on the thread that parses the file (step A1).
- `INGEST_QUALITY_GATE` — the ingest quality gate, on by default (`hold`; `lib/ingest-quality-gate.ts`,
  `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`). While a file is staged the importer counts
  the rows that break a rule a correctly parsed row never breaks (a login that is a URL, a url that holds a credential, a
  Telegram link in a field, double-encoded text) and the lines it could not split. When at least 20,000 lines were read and
  more than 2% of the stored rows break a rule, more than 5% of the lines were unsplit, or more than 25% are garbage, the
  file is **held** before one row is stored: it moves to `inbox/held/`, the Inbox page lists it with the reasons, and an admin
  can **Release** it (it is then imported once without being held again). `warn` only reports; `off` switches it off.
  Thresholds: `INGEST_QUALITY_GATE_JUNK_PCT` (2), `INGEST_QUALITY_GATE_UNSPLIT_PCT` (5), `INGEST_QUALITY_GATE_GARBAGE_PCT` (25),
  `INGEST_QUALITY_GATE_WARN_JUNK_PCT` (1), `INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT` (2), `INGEST_QUALITY_GATE_MIN_LINES` (20000) and
  `INGEST_QUALITY_GATE_EARLY_LINES` (1000000: a big file is checked once after that many lines, so a bad 4 GB file costs a
  million lines, not the whole file). `npx tsx scripts/preflight.ts <file>...` gives the verdict from a sample before a file is imported.
  The unsplit share leaves out the lines that cannot hold a credential in any layout (a banner, a divider, a bare link, a link with one
  field behind it; `cannotHoldCredential` in `lib/ulp-recover.ts`), and a file over 8 MiB is also sampled before its import starts (five
  slices of 2 MiB spread over the file, as the preflight reads them): it is held at once when the sample is past a hold limit by half
  again, so a file that goes bad in the middle stops in seconds. Both are described in
  `docs/superpowers/specs/2026-10-24-parser-v6-2-and-gate-noise-design.md`.
- `ULP_ARCHIVE_HOST_DIR` — the host directory of the source archive (`scripts/archive-sources.ts`, default `~/ulp-archive`,
  which must exist), mounted read-only at `/archive`. A file named `<name>.archiveref` dropped into `inbox/` (the feeder writes
  them with `SOURCE=archive`) is imported from the archive instead of from the inbox: the plaintext is decoded on the way to the
  parser, its sha256 is checked before the commit, and no plaintext copy is made.
- `MEMORY_GUARD_THRESHOLD_RATIO` — an import waits before its next batch while ClickHouse's memory
  tracker is at or above this share of its ceiling (default `0.75`).
- `MEMORY_GUARD_MAX_WAIT_MS` — how long it waits before going ahead anyway (default `600000`, ten
  minutes). The guard paces imports; it never blocks one for good.

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

- **Declutter** — hides low-signal rows (IP-host / `:port` / `.php` / `localhost` URLs, and rows the parser mangled). Backed by a precomputed `is_noise` column, so it's a cheap filter, not a per-row scan. It hides every URL ending in `.php`, a site's own `index.php` and `login.php` included, so it starts **off** for a lookup of one thing (a domain, an IP address, an address, a text with a path or a symbol in it, the Domain box and the host / e-mail domain filters), where it would hide real rows, and **on** for the bare browse and for broad searches (a word, a login, a pattern), where it removes router and parser junk (`lib/declutter-default.ts`). A click on the chip is kept until Clear. The header's "of N matching" counts the rows the search matched before Declutter and Unique; hover it for how many the chips hide. The Site counts page applies neither chip.
- **Unique** — collapses `(url, email, password)` duplicates to one row each (`LIMIT 1 BY`), ignoring URL scheme and a trailing slash — `http://`, `https://`, and no-scheme captures of the same host+path count as the same row; email/password stay exact.
- **Login type** — Email / Phone / Username / All types. A search (a text or the Domain box) starts on **Email**; the bare browse and the "View what this added" views start on All types, so they show everything and keep their free total. A click on a chip is kept until Clear, "All types" included (`lib/login-type-default.ts`). The API is unchanged: no `login_type` parameter still means every type.

Both are view-only — storage is untouched; toggle off to see everything.

The browser defaults to 200 rows per page, globally ordered Domain A→Z, and the list is endless: the next page is appended as the end of the list comes into view (it stops by itself at 5,000 rows; a button continues). Page size and sort order remain selectable in the UI and API.

### Domain search dictionary (speed)

A search for one domain, such as `ledger.com`, matches the site, its subdomains, hosts that contain the name, and email domains that contain it. ClickHouse cannot use the primary key for that mix, so it used to read most of the table (15-19 s on the 1.39B-row deployment). Two small derived tables, `ulp.search_host_dict` (distinct domain and host pairs, about 2 GiB) and `ulp.search_emaildomain_dict` (about 150 MiB), let the app look up which domains and email domains can match first and then read only those ranges: the same rows, order, cursors and totals in about 2-4 s. It is used only for a search that is exactly one domain-shaped term; everything else, and any problem, runs the original query.

- The tables are rebuilt automatically after imports (a tick every `SEARCH_DICT_CRON_MINUTES`, once the data has been quiet for `SEARCH_DICT_SETTLE_SECONDS`). While one is stale or missing, searches simply use the slower original query. Ingest Health shows its state.
- First build, by hand and watched (about 2.5 minutes, 2 GiB; run it before relying on it): `npx tsx scripts/build-search-dictionary.ts` (the header of the script shows the `CLICKHOUSE_HOST` to use from the host).
- `SEARCH_DICTIONARY=0` switches it off (no rebuild needed). `SEARCH_DICT_MAX_DOMAINS` (3000) and `SEARCH_DICT_MAX_EMAIL_DOMAINS` (300) bound how many candidates one term may have; above them the original query runs (popular terms such as `google.com`).
- `/api/credentials?...&dictionary=0` forces the original query for one request, and a response says which plan answered in `plan` (`dictionary`, `words`, `windows`, `substring` or `plain`).
- The tables are derived data: `scripts/clickhouse-backup.sh` leaves them out, and dropping them is always safe.

### Case-insensitive address lookup

Logins are stored as typed (about 5% of e-mail logins contain a capital), so an exact match on the raw column would miss them. Every exact-address lookup (a full address in the search box, `/api/check`, `/api/v1/lookup`, both batch lookups and the related panel) compares `lower(email) = lower(value)`, which finds every stored casing; each row is shown as stored, so one address can come back in several casings. A bloom-filter index on `lower(email)` (`idx_bf_email_lc`, DDL v29, about 1.2 GiB on 1.8 billion rows) keeps it as fast as the old exact match (0.4-2 s). Case is folded for ASCII letters only. The queries also run with `optimize_use_projections = 0` (`lib/address-lookup.ts`): given a projection to choose from, ClickHouse can read the projection whole and then never uses the index (17 times slower on a test copy where every part had the projection; not visible on the live table today, where only the newest partition has one, so this is insurance).

The bloom filter alone cannot narrow a long list: with `bloom_filter(0.05)` one address keeps 4.4% of the granules, ten keep 35% and a hundred keep 98.7%, so a batch of 100 read the whole table (26-38 s against the batch routes' 30 s cap, from 2026-10-13 until the fix below). The batch routes therefore also send `indexHint(hasAllTokens(email, [words of the address]) OR ...)`: the text index narrows 100 addresses to about 1,000 of 34,299 granules (about 3 s warm or cold) and the `lower(email) IN (...)` comparison still decides every row. The hint is never a row filter: evaluated on a row `hasAllTokens` is case-sensitive and, with the index off, lost the mixed-case rows of a real address (52 of 54). Only ASCII-only addresses get a hint; any other address is looked up in a second query with the plain comparison. Design and measurements: `docs/superpowers/specs/2026-10-26-batch-lookup-design.md`; proof on the real table: `BLK_LIVE=1 npx vitest run __tests__/batch-lookup.live.test.ts` (read-only).

DDL v29 adds the index definition; parts written before it need `bash scripts/materialize-address-index.sh` (a dry run unless `APPLY=1`; one partition at a time, a few minutes, with a free-disk watchdog that kills the mutation under 120 GiB). Run it before deploying a version that depends on the index, and never with `SYSTEM STOP MERGES` in effect (that stops mutations too). An install without it still answers correctly but scans the table (13-30 s; `/api/check` can time out).

### Faster single-word searches (speed)

A search for one word (a brand, a handle, a name) looks for it as a whole word in the URL, the login and the password, and also inside host names and e-mail domains. ClickHouse can use an index for each of those parts but not for their OR, so it read the whole table: 13-22 s for the totals and 9-19 s for the first rows of a rare word (26-150 s as logged while the machine was busy). The page now splits the search into three parts that never overlap and answers each the cheap way: the text indexes for the word as a whole word (0.2-0.3 s however many rows match), and the two small dictionaries of the domain search for the hosts and e-mail domains that contain it, reading only those domains. The original test stays in every part, so the rows, order, cursors and totals are the same (compared exactly on 38 real words, rows and totals alike).

- **Totals:** about 13 s down to about 1 s for a rare word, and 14-22 s down to 4-10 s for words with thousands of matches (1.7 to 14.5 times faster). Used when at most 5,000 rows have an e-mail domain that contains the word.
- **Rows:** 9-19 s down to 1.2-4.6 s (2.9 to 14 times faster), used only for a word with at most 300 candidate domains and at most 300 rows behind its matching e-mail domains. For a more plentiful word today's query stops after 200 rows and the plan has to find 200 in each part, which measured slower (up to 4.5 times): those keep the original query, and "Newest first" still tries its time windows first.
- A plan query has a time budget (8 s for rows, 12 s for totals); over it, or on any error, the original query runs, and an overrun is remembered for ten minutes so page turns and filter changes do not pay it again.
- It needs the search dictionary to be fresh (see above); while it is stale or missing, the original query runs. A word with a hyphen or underscore, several terms, a negated term, a regex and the login scopes keep the original query too.
- `SEARCH_TOKEN_PLANS=0` or `SEARCH_DICTIONARY=0` switches it off (no rebuild needed); `/api/credentials?...&dictionary=0` or `&token_plans=0` forces the original query for one request, and the response's `plan` says `words` when the plan answered. The three limits are tunable: `SEARCH_WORD_ROWS_MAX_DOMAINS`, `SEARCH_WORD_ROWS_MAX_EMAIL_ROWS`, `SEARCH_WORD_TOTALS_MAX_EMAIL_ROWS`.
- Design and measurements: `docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md`, `docs/superpowers/plans/2026-10-13-word-search-plan.md`.

### Faster substring searches (speed)

A search for one text that contains a special character (a path such as `/ledger/login.php`, a pair such as `user:pass`, anything with a space) cannot use a word index: it is a plain substring scan of the URL, the login and the password, which read about 95 GiB (35-80 s). The page now takes the whole words inside the text (`ledger` and `login` in the example; a word at either end of the text could be part of a longer one, so it does not count), counts each one through the text indexes in about 0.3 s, and when the rarest has at most 50,000 hits it adds that word as one more condition to the same query. The original substring test stays in the query, so the rows, order, cursors and totals are the same (compared exactly on real searches); only rows that cannot match are skipped: 0.4-11 s instead of 35-42 s in the measurements. A text with no whole word, or whose words are all common, runs the original query.

- A plan query has a 15 s budget; over it, or on any error, the original query runs (the page never shows a time-out because of the plan).
- `SEARCH_TOKEN_PLANS=0` switches it off (no rebuild needed). `/api/credentials?...&token_plans=0` forces the original query for one request, and the response's `plan` says `substring` when the plan answered.
- Design and measurements: `docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md`.

### One scan per substring search (speed)

The substring plan above needs a whole word inside the text that is rare. A URL with a path, a pair such as `user:pass` or anything with a space often has none, and then the search is a scan of the URL, the login and the password of every row: 150 GiB and about 650 CPU-seconds on 2.2 billion rows, 57-66 s on a quiet machine. The page asks for the rows and for the totals at once, so one search was two such scans (121 s and 130 s measured on a quiet machine), and every filter click (the Email login type, a tier, Unique) was two more, started while the earlier ones were still running (140-260 s as logged). What such a search finds is small (49 rows for a real login-page search), and the cost is all in finding it.

The page now scans once for the **positions** of the matching rows (`_part` and `_part_offset`, at most 5,000 of them) and answers every request of that search through them: today's query plus one more condition, `(_part = 'p' AND _part_offset IN (...)) OR ...`. The original substring test stays in the query, so the rows, order, cursors and totals are the same (compared byte for byte on a real search, rows and totals). Measured on the live table (2.23 billion rows): the one scan 53.6 s, then the totals and the rows, with and without the Email chip, 0.2-0.3 s each. ClickHouse's own query-condition cache cannot do this job: it writes nothing when a skip index (the login-type set index) filters the marks first, so a search with the chip on never left anything to reuse.

- Positions are positions in **parts**, and parts change: an import adds one (its rows were never scanned), a merge or a mutation replaces some. A set therefore carries a fingerprint of the table's active parts (the table uuid and every part name), read before the scan, re-read before the set is used, and again after the answering query ran. If it differs, the answer is not used and today's query runs; a scan that straddled a change is thrown away and that search keeps today's query for two minutes instead of scanning again and again during an import. A set is kept for 15 minutes.
- Used for a search of exactly one text with a special character, when no domain, breach, source file, host, e-mail domain or imported range narrows it (those make today's query cheap) and the substring plan could not help. More than `SEARCH_HIT_SET_MAX_HITS` hits (default 5,000, at most 15,000): today's query. A later page uses a set that is already there and never starts a scan.
- The scan is shared by the rows request and the totals request and by every later click of the same search, and it is ended on the server (`KILL QUERY`) once no request waits for it any more.
- The answering queries have a 20 s budget; over it, or on any error, today's query runs.
- `SEARCH_HIT_SET=0` (or `SEARCH_TOKEN_PLANS=0`) switches it off (no rebuild needed); `/api/credentials?...&hit_set=0` (or `&token_plans=0`) forces the original query for one request, and the response's `plan` says `hits` when the plan answered.
- Design and measurements: `docs/superpowers/specs/2026-10-26-slow-search-latency-design.md`.

### The next page (speed)

ClickHouse 26.3 does not use a tuple comparison to prune the primary key (`EXPLAIN indexes = 1`: `Condition: true`, every granule selected, even for a prefix of the key). The cursor was `(domain, email, imported_at, url, password) > (...)`, so every next page restarted at the first granule: page 3 of one rare search read 2.17 billion rows (160 GiB, 52 s). The cursor of the Domain A→Z, Domain Z→A and Oldest first sorts now carries a **scalar superset** (`domain > d OR (domain = d AND (email > e OR (email = e AND imported_at >= t)))`) in front of the exact tuple, which stays as the last condition: the rows, their order and the next cursor are the same, and the primary key (or, for Oldest first, the partition key) skips what lies before the cursor. Measured on the live table with the logged statements of one search that has 125,760 matches: page 3 went from 52.3 s and 2,169M rows to 25.3 s and 706M rows (19,275 of 34,299 granules); a page deep in the dense part from 51.3 s to 18.8 s. A live test (`CURSOR_PARITY=1 npx vitest run __tests__/cursor-pagination.live.test.ts`) follows pages through one big domain, resumes from cursors inside runs of equal keys and crosses from one domain into the next, and every page equals one ordered read; `scripts/e2e-cursor-pages.ts` does the same on the rehearsal stack with a table built to tie.

The Credentials list is **endless**: the next page is fetched when the end of the rows comes within 1,500 px of the bottom of the table, with the cursor of the last page and for the search that is on screen (not the filter bar), and it is appended, so the rows you are reading stay. A slow page shows the seconds it has taken and a Stop button; an error or a stop keeps the rows and offers a Retry (nothing retries by itself).

A rare text is still a scan under any cursor, because the data is in 15 parts and a part whose next match is far away must be read up to it (18.8 s is the floor of the plain query on the search above). Above 5,000 matches the hit-set plan (previous section) does not apply, so such a search stays at 19-25 s a page. Listing all the positions (125,760 here, 1.26 MB of SQL, `max_query_size` raised) measured 4-13 s a page; that is designed and not built. Design and measurements: `docs/superpowers/specs/2026-10-28-next-page-speed-design.md`.

### Abandoned searches are cancelled (speed)

When a newer search or filter click replaces a request, the browser drops the old one, but ClickHouse does not stop a statement because its client left (measured on 26.3: a query kept running for the 19 s the test watched after the connection closed, with and without `cancel_http_readonly_queries_on_client_close`; the Credentials queries need `http_wait_end_of_query=1`, so that a time limit arrives as an HTTP error instead of as garbled JSON). Searches the page had given up on kept scanning, and every click added two more: in one 14-minute stretch six of the twelve 150 GiB scans were for searches that had been replaced before they finished, and while they ran the default page took 21 s instead of 1 s and the related-records panel hit its 30 s limit. `/api/credentials` now runs its long queries under an id of their own and `KILL QUERY`s them when the request is aborted (the response is a quiet 499).

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
DEDUP_MIN_EXCESS=1000      # skip the (heavy) rewrite below this many excess rows (the 1.87B-row deployment uses 14000000, ~0.75% of the table)
DEDUP_STATS_MIN_FREE_BYTES=42949672960   # the daily duplicate count spills to disk (13.8 GiB at 1.84B rows); it skips itself with less free space than this (default 40 GiB)
```

The daily duplicate count (about 80 s, 11.5 GiB of memory at 1.84B rows) is skipped while the table's row count is unchanged, because duplicates can only appear through inserts. It is forced again after 7 days, and what the last count saw is kept in the app database, so a restart or a deploy does not cost another one.

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
# T3 countries kept anyway (two-letter codes of the first T3 signal; default = the 15 with GDP per capita (PPP) >= $40k:
# Saudi Arabia, Czechia, Slovenia, Lithuania, Poland, Estonia, Croatia, Romania, Slovakia, Russia, Türkiye, Latvia, Bulgaria, Panama, Kazakhstan):
INGEST_FILTER_HARD_KEEP_COUNTRIES=SA,CZ,SI,LT,PL,EE,HR,RO,SK,RU,TR,LV,BG,PA,KZ   # empty = drop all of T3
```

Evaluated noise-first → hard tier → keep → soft tier → suffix. Hard tiers are non-overridable: `INGEST_FILTER_KEEP_SUFFIXES` cannot rescue them, and a hard-keep country (`INGEST_FILTER_HARD_KEEP_COUNTRIES`) is the only exception. The stored `country_tier` column is unchanged (kept rows are still labelled T3). `DROP_NOISE` drops IP/`:port`/`.php`/`localhost`/single-label/non-web-scheme URLs at ingest regardless of country; `android://` is kept.

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

The purges select rows by the **stored** `country_tier` column, which is computed by ClickHouse from a SQL copy of `lib/country-tiers.ts`, and that copy had drifted. On 2026-10-01, 1,919,919 rows were stored as `T3` and the importer's own `classifyTier()` called none of the rows it was shown T3: the stored expression treated a login with no `@` as if it were an email domain, its provider lists were an older snapshot (`att.com` is T1 in the code), and ClickHouse's `topLevelDomain(url)` returns the wrong label for a URL that carries credentials (`https://user:pw@host.co.uk/` gives blank, `https://a.b.c.d:pw@host.com/` gives `d`). Across all rows 0.35% (about 4.9M) carried a label different from the importer's. The importer's T3 hard-drop was unaffected; only the stored label was wrong, so a purge on that label would have deleted mainstream sign-ins the importer accepts.

So `scripts/purge-existing-t3.sh` and `scripts/purge-existing-low-tier.sh` never delete on the label alone. Both first stream every candidate row through the importer's own decision (`shouldDropAtIngest()`, via `scripts/audit-purge-candidates.ts`, which needs `npm ci` for `tsx`), in the dry run as well as in apply mode. If the importer would have kept even one candidate, apply mode exits 3 without deleting and the dry run prints `BLOCKED`, with counts only and never row content. The audit stops reading after the first 1,000 disagreements. When it passes, the script re-counts the candidates just before deleting and refuses if they changed.

**The stored column was repaired on 2026-10-01.** DDL v26 swapped the column's expression (`buildCountryTierExpression()` now reads the stored `email_domain` column and derives the URL's top-level label exactly like the importer's `urlTldOf()`), and the supervised `scripts/materialize-country-tier.sh` rewrote the label on every existing row and rebuilt `proj_imported_desc`, which carries `country_tier` (`MATERIALIZE COLUMN` does not rebuild a projection, so a plain backfill leaves the browse view serving the old labels). Afterwards the stored label equals the expression on all 1.39B rows, in the base columns and in the projection, and the expression equals the importer on 6.96M rows of two deterministic samples. The table now holds no T3 row at all (untiered 1,230,571,484, T1 44,944,279, T2 117,933,788), which is what the importer's hard-drop should have produced. `npx tsx scripts/check-tier-parity.ts` repeats that comparison on a sample (counts only). The guard stays: the purges still audit every candidate and refuse if the importer would have kept one. If you change a provider list or suffix in `lib/country-tiers.ts`, existing rows keep their old label until a new DDL version swaps the column's expression and the backfill script is run again.

Tiers: **T1** = US/UK/CA/AU/NZ · **T2** = W.Europe/JP/KR/SG/IL/AE · **T3** = RU/CN/BR/LATAM/SEA.

---

## API

Authentication: `Authorization: Bearer <api-key>` header.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/search/credentials` | Search credentials by email, domain, URL, password, breach |
| `GET` | `/api/v1/search/domain` | Domain/keyword search with subdomain and path aggregation |
| `GET` | `/api/v1/lookup?email=` or `?domain=` | One address (any casing) or one domain, newest first, up to 100 rows. A domain may be a URL, a `www.` host or `host:port`: it is cleaned to the bare host that is stored, like the batch route below, and the answer carries `searched_as` when that differs from what was sent |
| `POST` | `/api/v1/lookup/batch` | Batch lookup of up to 100 emails and/or domains (`{"emails": [...], "domains": [...]}`); URLs, `www.` hosts, `<addr>` and `mailto:` are cleaned to what is stored |
| `POST` | `/api/v1/lookup/counts` | How many rows each of up to 100 sites has (`{"domains": [...]}`), without the rows: `count` = `host_count` (the host and its `www.` spelling) + `subdomain_count`, plus `subdomains` and the `top_subdomains`; a site is a host and every subdomain, a path is ignored, `error` marks an entry that is not a site or is too broad to count in the time allowed |
| `POST` | `/api/v1/lookup/associate` | Which e-mail (or username, or phone) belongs to the same account as a login, with a confidence and the evidence |
| `POST` | `/api/v1/lookup/password` | The logins that use exactly this password |
| `POST` | `/api/v1/upload` | Upload ULP file (admin keys only) |
| `GET` | `/api/check` | Public self-service breach check (no key required) |

Full interactive docs at `/docs` when the app is running.

### Login association and password lookup

A ULP line never pairs a username with an e-mail address, so `lookup/associate` **infers** the link from other rows. The strongest evidence is the account's own
password: the password a login has on a site identifies the person far better than the handle does. Signals: an e-mail with the same password on the same site (`site`, optional),
on any site (the fewer logins share the password, the stronger), an e-mail whose local part is the handle (strong only with the account's password), and a sign-in at a mail provider
(`accounts.google.com` implies `<handle>@gmail.com`). Each candidate is `high`, `medium` or `low` with the evidence in words; these are heuristics, not proof (a generic handle belongs
to many people, and the answer says `too_common`). On 122 handles the method gave 32 high, 28 medium, 53 low and 9 none, and random pairings share four or more letters 0.3% of the time
against 41-54% for the high and medium candidates.

```bash
curl -X POST "$BASE/api/v1/lookup/associate" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"items":[{"login":"somehandle","site":"example.com","password":"optional: a password the account is known to use"}]}'
# "want": "username" or "phone" looks for those instead of e-mail addresses, so the same call also answers "which handle goes with this address"
curl -X POST "$BASE/api/v1/lookup/password" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"password":"the password","type":"email","limit":100,"domain":"optional-site.com"}'
```

`associate` takes up to 10 logins per request (a few seconds each, three at a time; a very common handle such as `john` can take 15 s or more and a single letter 30 s, and is
marked `too_common`). `password` matches exactly and case-sensitively; a rare password answers in about a second, a very common one reads at most 100,000 matching rows and says
`partial` (narrow it with `domain`). Passwords travel in the POST body, are never logged and are never returned. Design and measurements:
`docs/superpowers/specs/2026-10-18-login-association-design.md`.

### Imported window (`imported_after` / `imported_before`)

"Only the rows added to the database in a time window", on every search and export surface. `imported_after` is **exclusive** and `imported_before` **inclusive**, both
UTC instants to the second, so windows chained as (previous `imported_before`, next `imported_before`] never overlap and never leave a gap. Accepted forms: a date
(`2026-10-05`, the whole UTC day on its own side), a UTC date-time (`2026-10-05 14:37:00`) or ISO-8601 with an offset (`2026-10-05T14:37:00-05:00`); anything else is a `400`
naming the parameter. It means *rows added after the cutoff*: a credential imported again later counts as added. The answer repeats the effective window.

| Where | How |
|---|---|
| `GET /api/v1/search/credentials`, `/search/domain`, `/lookup`, `/summary` | query string |
| `POST /api/v1/lookup/batch`, `/lookup/counts`, `/lookup/password`, `/lookup/associate` | JSON body (`associate`: once at the top; it limits where a *candidate* can come from, the login's own rows are always read from the whole table) |
| `POST /api/export` (every format), `GET /api/credentials` | the Credentials page's own routes |

`GET /api/v1/summary?imported_after=..[&imported_before=..]` returns the table-wide summary for a window (rows added, estimated distinct domains and addresses, files imported,
top 20 domains); it needs `imported_after` (an upper bound alone is the whole table), is computed on request and kept for 2 minutes (10 once the window is closed).

In the app the window is the **Imported** pill in the Credentials filter row (presets Today, Yesterday, Last 24 h, 7 days, 30 days and Since last export; your local time, with
the UTC instant shown under each field). It is kept in the page address (`/credentials?imported_after=..&imported_before=..`, plus `source_file=..`), so a window can be
bookmarked, and every finished import job on the Inbox and Upload pages has a **View what this added** link that opens it on exactly that job's rows. The Lookup and
Breaches pages use the same control. Design and measurements: `docs/superpowers/specs/2026-10-05-imported-after-filter-design.md` and
`docs/superpowers/specs/2026-10-18-imported-window-ux-design.md`.

---

## Performance

Reference deployment: 1.87 billion rows (156 GiB), one 32 GB laptop (cold timings, measured 2026-09/10 while the table grew from 1.39 to 1.87 billion rows):

| Metric | Value |
|---|---|
| Insert throughput | ~1–2M rows/min on laptop SSD (single-process) |
| Peak heap per 500K-row batch | ~100 MB (array in memory before insert) |
| Dedup Set cap (direct path only) | 2M entries → ~440 MB max (prevents OOM on huge files); novelty-aware ingest dedups in the stage table, exactly, for any file size |
| Exact domain / email lookup (an address matches in any letter case) | 0.03–1.3 s cold (bloom filters + primary key); a very popular value such as `admin@gmail.com` takes 7–23 s |
| Single-word search | totals 13-22 s before; 1-10 s now. Rows: 9-19 s before; 1.2-4.6 s for a rare word (at most 300 candidate domains and 300 rows behind its e-mail domains), otherwise unchanged. The response's `plan` says `words` |
| Substring search (one text with a special character, such as a path) | 35-42 s before; 0.4-11 s when a whole word of the text matches at most 50,000 rows, otherwise unchanged. The response's `plan` says `substring` |
| Browse / search, default sort (domain A-Z) | 5-14 s for the rows (read in primary-key order, stops after 200 matches); the total is a separate query (4-17 s) that arrives after the rows |
| "Newest first" | 0.1-1 s for a plain browse, a popular domain or word, a tier/password filter or a date range inside the newest import (it was 18-76 s); a rare term, a term with no match, or a date range older than the projection is answered by the plain scan, 14-27 s. Run as time windows on `proj_imported_desc`: `lib/newest-first.ts`, `docs/superpowers/specs/2026-10-01-newest-first-windows-design.md`. The response's `plan` says which one answered |
| Other sorts (email, password length) | 18-45 s: every matching row is read and sorted |
| Domain-monitor re-scan | ~5 s per tick for 17 domains (reversed-key projections + a single normalising pass over the legacy bucket) |
| Monitor re-scan tick | 15 minutes, in-process, no external queue |
| Inbox reconciliation | Every 30 s — catches any missed chokidar events |

---

## Operations

- **Disk space.** The app checks free space on the ClickHouse data disk every 10 minutes
  (`lib/disk-watch.ts`), logs a warning when it gets low, and shows it in the Ingest Health panel
  (Upload and Inbox pages) and, for admins, in a banner under the header of every page (amber when low, red when critical or
  when imports are paused). Optional: `DISK_ALERT_WEBHOOK_URL` also POSTs each alert to a
  Slack-compatible webhook; nothing is sent anywhere unless you set it. Heavy jobs (dedup, projection
  restores) refuse to start below the same floor. **Imports pause, and resume by themselves,** while free space is under
  `INGEST_MIN_FREE_BYTES` (default 50 GiB; they resume above 1.1x that); a paused import never fails and has no timeout, and
  `INGEST_DISK_GATE=off` switches the gate off (`lib/ingest-disk-gate.ts`).
- **Backups.** The app snapshots its own SQLite (users, API keys, monitors) into `./data/backups` daily.
  ClickHouse backups are taken with `./scripts/clickhouse-backup.sh` and need an S3-compatible
  destination (`S3_*` in `.env`); until one exists the panel says "No ClickHouse backup recorded".
  Read `docs/clickhouse-backup-runbook.md` first — it explains why local snapshots are guarded by a
  disk-space check.
- **The "Newest first" projection.** `proj_imported_desc` (DDL v27: it carries `is_noise` and `content_key_hash`) is what makes
  that sort fast. It is built for the newest partition only (~34 GiB). After a content-dedup swap the tick restores it; if the
  Credentials response says `"plan": "plain"` for `sort=imported_desc` long after one, run
  `bash scripts/rebuild-imported-desc-projection.sh` (dry run by default; `APPLY=1` builds, asynchronously and polled, with a
  free-disk floor), then `NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts` to confirm the windowed pages
  equal the plain query's. The projection scope cron never clears the newest partition.
- **First start, or a restored data directory.** Before it runs any DDL the app asks ClickHouse a real query for up to 45 s (a first start on an empty
  data directory sees the container "healthy" a moment before the real server listens). The DDL version is recorded only when no statement lost its
  connection, and every start then compares `ulp.credentials` with what the migrations own: a missing skip index is added (metadata only, and the log
  names the `MATERIALIZE INDEX` that existing parts still need), a missing column is reported and left alone. Look for `[ClickHouse migration]` lines
  in `docker logs ulpsuite_app` (`lib/clickhouse-migration-safety.ts`).
- **Durability.** Inserts and merges are fsynced (`fsync_after_insert`, and `min_rows_to_fsync_after_merge`
  from DDL v25).
- **Known data-quality gap.** About 6.3M rows (0.45%) imported by an earlier parser sit in the wrong
  columns, so an exact domain/email filter cannot see them; see the header of `lib/ulp-normalize.ts`.
  Two shapes. The 3.29M "scheme-split" rows (`url` = `https`, `email` = `//host/path`, `password` = `login|pass`) were
  repaired on 2026-10-01 by APPENDING corrected copies, never by rewriting a partition
  (`scripts/repair-scheme-split-rows.sh`: dry run by default, `APPLY=1` appends; it re-parses each original line under the
  importer's own ingest policy, skips a credential that already exists and any row the importer would drop, keeps the original
  `imported_at`/`source_file`, and a re-run appends nothing). That run appended 1,009,474 rows; the old rows are left in place
  (already hidden by Declutter). The other 3.16M ("Case D", blank `url`) are repaired for display by `NORM_COLS` only; fixing
  them in storage needs a backup first.

---

## Contributing

Issues, pull requests, and security reports are welcome. Please open an issue before submitting large changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
