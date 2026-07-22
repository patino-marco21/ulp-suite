# Enable multi-file upload concurrency

- **Date:** 2026-07-22
- **Status:** Approved (design)
- **Scope:** Turn on `UPLOAD_CONCURRENCY` (already implemented in `lib/upload-queue.ts`, currently unused because it's never forwarded into the app container) for this deployment. Pure config change — no application code.

## Problem

Ingest currently processes one file at a time (`pLimit(1)` via `UPLOAD_CONCURRENCY` defaulting to 1). Real production evidence from the 2026-07-21 stuck-file recovery (see `docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md`) shows throughput dropping from a sustained ~35-45K rows/sec to ~26,600 rows/sec on the 7th file in a 10-file sequential run — consistent with single-file serialization losing ground as background merge pressure accumulates, something added concurrency would help smooth out.

`lib/upload-queue.ts` already supports this (`parseConcurrency(process.env.UPLOAD_CONCURRENCY)`, code comment: "Raise to 2–3 on machines with ≥16 GB RAM and multi-core CPUs"), but `UPLOAD_CONCURRENCY` is never forwarded through `docker-compose.yml`'s `environment:` block, so it's always unset in this deployment and silently falls back to 1 regardless of what's in `.env`. This host has 32GB RAM. The 2026-07-20 memory-backpressure feature (`lib/clickhouse-memory-guard.ts`) checks *global* ClickHouse memory pressure before every batch and file claim, not per-file — so it already governs concurrent files correctly, making it safe to raise this now in a way it wasn't before that feature shipped.

## Decisions made during brainstorming

- **Ship the documented default (2) and observe live, rather than standing up a benchmark environment first.** The benchmark script (`scripts/benchmark-import.ts`) needs ClickHouse reachable on localhost, which isn't available from the production container or host as currently configured — standing that up is more effort than it's worth for picking between 2 and 3. Real inbox throughput plus the existing memory guard's own pacing logs are sufficient signal to tune further later.
- **Known, accepted limitation: the Inbox Monitor's live progress display stays single-job.** `getCurrentJob()` (`lib/upload-queue.ts`) and `getCurrentProgress()` (`lib/inbox-watcher.ts`) are both single `globalThis` slots, not per-job — confirmed by reading both call sites. At concurrency > 1, if two files are running and one finishes, the other (still running) file's live progress can go from "shown" to invisible, not just "one of N" as the original code comment implied. Files still process and complete correctly regardless (every job still gets its own row in `processing_jobs` / the Inbox Monitor's history list) — this only affects the live in-progress indicator. Not fixed as part of this change; flagged in the README instead.

## Design

**`docker-compose.yml`** — add to the `app` service's `environment:` block, alongside the existing `INGEST_FILTER_*` forwarding lines:

```yaml
UPLOAD_CONCURRENCY: ${UPLOAD_CONCURRENCY:-1}
```

Default stays `1` here and in `parseConcurrency`'s own fallback — unset on any other/fresh deployment, so this only takes effect where explicitly configured.

**`.env`** — add:

```
UPLOAD_CONCURRENCY=2
```

**`.env.example`** — add a documented line, following the existing `INGEST_FILTER_HARD_DROP_TIERS` convention there (explanatory comment above, then an active, uncommented, safe-default value below): `UPLOAD_CONCURRENCY=1`.

**`README.md`** — the existing "Import throughput tuning" section already documents `IMPORT_PIPELINE` and `UPLOAD_CONCURRENCY` conceptually. Update it to:
- Note that concurrency > 1 is now reasonable given the memory guard (previously the section only warned about raising it).
- Document the progress-UI limitation from the "Decisions" section above, so it isn't a surprise later.

**Deploy** — restart `ulpsuite_app` only (pure env/config change, no image rebuild needed).

## Out of scope

- Any application code change — `parseConcurrency` and the queue already behave correctly; this only changes what value they receive.
- Fixing the single-job progress-display limitation (see Decisions above).
- Running `scripts/benchmark-import.ts` to empirically choose between 2 and 3 (see Decisions above) — ship 2, revisit with real data if needed.
- Raising `UPLOAD_CONCURRENCY`'s hardcoded fallback default in the code itself — stays 1 for safety on other deployments.
