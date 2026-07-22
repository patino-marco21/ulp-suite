# Upload Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `UPLOAD_CONCURRENCY=2` for this deployment so the inbox watcher and HTTP upload route can process up to 2 files at once instead of 1, using an env var the code already supports but that's never been wired through `docker-compose.yml`.

**Architecture:** Pure configuration change. `lib/upload-queue.ts`'s `parseConcurrency()` already reads `process.env.UPLOAD_CONCURRENCY`; this plan only adds the missing forwarding line in `docker-compose.yml`, sets the value in `.env`, documents it in `.env.example`, and updates the README. No application code changes.

**Tech Stack:** Docker Compose, `.env` files, Markdown documentation.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-22-upload-concurrency-design.md`.
- No application code changes — `lib/upload-queue.ts` is correct as-is.
- The code's own hardcoded fallback default (`1`, in `parseConcurrency`) stays unchanged — only this deployment's `.env` overrides it, via `docker-compose.yml`'s `${UPLOAD_CONCURRENCY:-1}` forwarding.
- Known, accepted limitation (not fixed here): the Inbox Monitor's live progress display (`getCurrentJob()` in `lib/upload-queue.ts`, `getCurrentProgress()` in `lib/inbox-watcher.ts`) is a single global slot, not per-job — at concurrency > 1 a still-running file's progress can become invisible if a second concurrent file finishes first. Must be documented in the README, not fixed.

---

### Task 1: Wire `UPLOAD_CONCURRENCY` through config and document it

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** None — no code, no new exports, no new tests. `parseConcurrency` (`lib/upload-queue.ts:22-25`) is unchanged and already has test coverage for its parsing behavior.

- [ ] **Step 1: Forward the env var in `docker-compose.yml`**

In `docker-compose.yml`, the `app` service's `environment:` block currently reads (around line 118-124):

```yaml
      # Import filtering — optional, configured in .env. These must be forwarded
      # explicitly because Compose does not inject arbitrary .env keys.
      INGEST_FILTER_HARD_DROP_TIERS: ${INGEST_FILTER_HARD_DROP_TIERS:-T3}
      INGEST_FILTER_DROP_NOISE: ${INGEST_FILTER_DROP_NOISE:-}
      INGEST_FILTER_DROP_TIERS: ${INGEST_FILTER_DROP_TIERS:-}
      INGEST_FILTER_KEEP_SUFFIXES: ${INGEST_FILTER_KEEP_SUFFIXES:-}
      INGEST_FILTER_DROP_SUFFIXES: ${INGEST_FILTER_DROP_SUFFIXES:-}
```

Add immediately after that block (before the `# Exact-content dedup worker` comment that follows):

```yaml
      # Ingest concurrency — optional, configured in .env. Must be forwarded
      # explicitly (see comment above). Default 1 (sequential) is safe on any
      # hardware; raise only where memory headroom is confirmed — see
      # docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md
      # and docs/superpowers/specs/2026-07-22-upload-concurrency-design.md.
      UPLOAD_CONCURRENCY: ${UPLOAD_CONCURRENCY:-1}
```

- [ ] **Step 2: Set the value in `.env`**

In `.env`, append after the existing `ADMIN_PASSWORD=...` line (the file currently ends there):

```
# ─── Ingest performance ─────────────────────────────
# Files processed concurrently (inbox watcher + HTTP upload share this limit).
# Safe to raise above 1 on this host (32GB RAM) now that lib/clickhouse-memory-guard.ts
# paces batches on ClickHouse's own memory pressure signal. See
# docs/superpowers/specs/2026-07-22-upload-concurrency-design.md.
UPLOAD_CONCURRENCY=2
```

- [ ] **Step 3: Document the default in `.env.example`**

In `.env.example`, the ingest-filter block currently ends with (around line 104-106):

```
INGEST_FILTER_DROP_SUFFIXES=
INGEST_FILTER_KEEP_SUFFIXES=
INGEST_FILTER_DROP_NOISE=
```

Add immediately after:

```

# ─── Ingest performance ─────────────────────────────
# Files processed concurrently (inbox watcher + HTTP upload share this limit).
# Raising it multiplies peak memory — each concurrent file holds its own
# in-flight batch and its own dedup set. Safe to raise above 1 only where
# lib/clickhouse-memory-guard.ts's pacing is deployed and memory headroom is
# confirmed for your hardware.
UPLOAD_CONCURRENCY=1
```

(`UPLOAD_CONCURRENCY=1` here is the safe, generic default for anyone copying this file — not the `2` used in this specific deployment's real `.env`.)

- [ ] **Step 4: Update `README.md`'s "Import throughput tuning" section**

The section currently reads (around line 152-163):

```markdown
### Import throughput tuning

Imports overlap parsing with ClickHouse inserts (pipelining) to cut idle wait
without raising peak memory beyond one extra batch. Two environment knobs:

- `IMPORT_PIPELINE` — `off` disables pipelining and reverts to strictly
  sequential parse→insert (kill-switch / A-B testing). Default: on.
- `UPLOAD_CONCURRENCY` — number of files processed at once. Default `1`.
  Raising it multiplies peak memory (each file holds its own in-flight batch and
  its own dedup set), so only raise it on hardware with memory headroom.

Batch size stays a fixed 100,000 rows; inserts remain synchronous, in-order, and
```

Replace the `UPLOAD_CONCURRENCY` bullet and the text immediately after the knob list with:

```markdown
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
```

- [ ] **Step 5: Verify the compose file is still valid**

Run: `docker compose config --quiet`
Expected: no output, exit code 0 (confirms `docker-compose.yml` still parses and the new `${UPLOAD_CONCURRENCY:-1}` interpolation is valid syntax).

- [ ] **Step 6: Restart the app container to pick up the new env var**

Run: `docker compose up -d app`
Expected: `Container ulpsuite_app Recreated` (environment changed, so compose recreates it even without an image rebuild).

- [ ] **Step 7: Confirm the container actually received the new value**

Run: `docker exec ulpsuite_app printenv UPLOAD_CONCURRENCY`
Expected: `2`

- [ ] **Step 8: Confirm the app is healthy after restart**

Run: `docker compose ps`
Expected: `ulpsuite_app` shows `(healthy)` (should be fast this time — migrations are already fully applied, confirmed idempotent-skip behavior from the 2026-07-21 deploy).

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml .env.example README.md
git commit -m "feat(ingest): forward UPLOAD_CONCURRENCY, document raising it above 1"
```

Note: `.env` is gitignored and not committed — Step 2's change only exists on this host, which is correct (it's deployment-specific, not shared config).
