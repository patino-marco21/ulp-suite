# Ingest pipeline: memory-aware backpressure to prevent ClickHouse OOM on large files

- **Date:** 2026-07-20
- **Status:** Approved (design)
- **Scope:** Prevent large-file imports (inbox watcher and HTTP upload — both share `lib/upload-processor.ts`) from getting killed by ClickHouse's `OvercommitTracker` under sustained memory pressure. Covers a new app-side backpressure guard, a ClickHouse memory-ceiling adjustment, and recovery of the 11 files currently stuck in `inbox/failed/`. Does not change file-size limits, batch size, the single-file (`pLimit(1)`) concurrency model, or any ClickHouse setting other than `max_server_memory_usage`.

## Problem

`inbox/done/` was found empty during an unrelated investigation into why no files appeared to have ever succeeded. Root cause of *that* was a separate, working-as-designed 7-day cleanup sweep (`cleanupOldFiles` in `lib/inbox-watcher.ts`) combined with 10 days of no new inbox activity — not a bug. But the same investigation surfaced a real one: `inbox/failed/` holds 11 files (35GB total), which `processing_jobs` (SQLite) breaks down into four distinct causes, matched by filename against the physical directory listing:

- **7 files** (all 3.7–4.2GB `DUMP ULP ... Base34` dumps): `(total) memory limit exceeded: would use ~14.05 GiB ... OvercommitTracker decision: Query was selected to stop ... While executing WaitForAsyncInsert.` — the target of this fix.
- **2 files** (also multi-GB dumps): `Timeout exceeded while reading from socket ... 30000 ms.` — also the target of this fix; a server under the same memory pressure can stall a socket read without the query itself being hung.
- **1 file** (`DUMP ULP 01.07.2026 Base34 3.txt`, 4.18GB): `Interrupted mid-import (app restart) — may be partially imported; review before re-adding.` A different immediate cause (the app container itself restarted mid-import, triggering `lib/inbox-watcher.ts`'s crash-recovery sweep), but same size profile as the other 9 — plausibly the same underlying pressure, and will benefit from the same fix on retry regardless of root cause.
- **1 file** (`🐊 TG @KURZL0GS_UP - 29.04.2026 - ULP PRIVATE.08`, 81MB): `Unsupported file extension ".08"`. Correctly rejected — this is working as designed and has nothing to do with memory pressure. Included here only because it happens to sit in the same directory; retrying it will just reproduce the same correct rejection.

All 11 failed with `imported: 0, skipped: 0` — none partially succeeded, none reached `recordSource()` (which only fires when `imported > 0`), so none are recorded in `ulp.sources`.

These are not fresh bugs. A prior session already hardened this exact area on 2026-06-27 (commit `8a93567`, "disable async_insert for bulk import batches; raise socket timeout") and again on 2026-07-07 (`max_execution_time` 60→3600 for mutations). `docker/clickhouse/config/ulp-performance.xml` carries a comment from that investigation explicitly flagging one open question it left unresolved: whether ClickHouse's caches (mark cache, uncompressed cache) count inside `max_server_memory_usage`'s 16GB budget or show up as extra RSS outside it — measured ceiling was ~14.05 GiB, 2GB below the 16GB config, and the comment declines to raise the setting without verifying which theory is correct.

**Verified live during this session:** `system.metrics` `MemoryTracking` (ClickHouse's own tracker — the exact figure `OvercommitTracker` compares against the ceiling) read 612MB at idle, while the container's actual cgroup RSS (`/sys/fs/cgroup/memory.current`) read 11GB. The ~10GB gap is not caches (mark_cache is capped at 256MB, uncompressed_cache at 512MB) — it's Linux page cache from reading/writing ClickHouse's data files, which cgroup v2 counts in `memory.current` but is reclaimable and not part of `MemoryTracking`. This resolves the open question: `MemoryTracking` vs `max_server_memory_usage` is a real, independent, allocator-level ceiling, not conflated with page cache. The ~14.05 GiB measured ceiling (vs 16GB configured) is a separate, smaller gap (connection overhead, buffers) — real headroom exists to raise the setting a controlled amount.

Host context confirmed live: 32GB total RAM, ClickHouse container capped at 20GB (`mem_limit`), app container at 8GB, ~26GB currently available system-wide. `docker stats` showed ClickHouse's container at 1.3GB of its 20GB budget at idle — a third measurement, distinct from both figures above: Docker's reported usage nets out most reclaimable page cache (closer to "working set" than raw `memory.current`), which is why it reads lower than the 11GB cgroup RSS figure while still being consistent with 612MB `MemoryTracking` plus some non-reclaimable overhead. All three numbers describe the same idle container from different vantage points; none of them contradict each other once attributed to the right layer. Two unrelated containers (`bronvault_clickhouse`, `bronvault_minio`, a different project sharing this host) run with no memory limit at all (`MemLimit=0`) — noted as a latent risk to overall host memory pressure, but out of scope here since it's a different project's infrastructure.

The application layer already does the right things: `lib/upload-processor.ts` streams in bounded 100K-row batches (`UPLOAD_BATCH_SIZE`), explicitly sets `async_insert: 0` on bulk batch inserts (the June 27 fix), and already retries `"(total) memory limit exceeded"` as a transient error via `withClickHouseRetry` (2-hour budget). None of that stops a *large* file — many sequential 100K-row batches fired back-to-back with no pacing — from pushing a server that's already busy with background merges/mutations over its ceiling. The empirical evidence backs this: the one batch of successful large imports (2026-07-09, 15 files, millions of rows each) were all pre-chunked into smaller files by whoever dropped them in; every file that failed was a single monolithic 2–4GB dump.

## Approaches considered

**A (chosen) — Memory-aware backpressure.** App polls ClickHouse's live memory tracker before each batch and before claiming a new file; pauses with backoff when the server is near its ceiling instead of firing an insert that gets killed. Paired with a modest, evidence-backed increase to `max_server_memory_usage`. Directly targets the confirmed mechanism (the same number `OvercommitTracker` itself checks), and covers every current and future large import automatically — no per-file operational step required.

**B — Tune-and-retry only.** Keep today's fire-then-retry model, just adjust the constants (bigger ceiling, smaller batch size, longer retry budget). Rejected as insufficient on its own: it still fails first and recovers after, which doesn't satisfy "don't OOM in the first place," and a persistently-busy server can exhaust even a long retry budget (some of the 11 failures ran 87+ minutes of retries before giving up).

**C — Auto-split large files into chunks at ingest.** Mirror the proven manual workaround by having the app transparently split any file over a size threshold into independent sub-units. Rejected as the primary mechanism: the app already streams and batches at 100K rows regardless of file size (confirmed constant peak memory per batch), so a 4GB file and a 40-chunk split of the same file submit *the same size* individual inserts either way — the actual difference is pacing (many batches with no gaps vs. natural breathing room between files), which (A) addresses directly without the added complexity of new partial-file success/failure tracking semantics.

## Design

### New module: `lib/clickhouse-memory-guard.ts`

Pure ClickHouse-query logic, no app singletons — unit-testable against a mocked client, following the pattern of `lib/clickhouse-retry.ts`.

```ts
export interface MemoryPressure {
  usedBytes:    number   // system.metrics.MemoryTracking
  ceilingBytes: number   // system.server_settings.max_server_memory_usage
  ratio:        number   // usedBytes / ceilingBytes
}

/** Live snapshot of ClickHouse's own memory tracker vs. its configured ceiling —
 *  the same two numbers OvercommitTracker itself compares before killing a query. */
export async function checkMemoryPressure(signal: AbortSignal): Promise<MemoryPressure>

/**
 * Polls checkMemoryPressure until usedBytes/ceilingBytes drops below
 * threshold, or maxWaitMs elapses — whichever comes first. Fail-open: any
 * error from checkMemoryPressure (or exceeding maxWaitMs while still above
 * threshold) resolves immediately rather than throwing or hanging — this is
 * a soft pacing layer, not a correctness dependency. The existing
 * withClickHouseRetry safety net (lib/clickhouse-retry.ts) still covers the
 * case where a batch fails despite backpressure.
 */
export async function waitForHeadroom(signal: AbortSignal, opts?: {
  thresholdRatio?: number   // default from MEMORY_GUARD_THRESHOLD_RATIO env, else 0.75
  maxWaitMs?:      number   // default from MEMORY_GUARD_MAX_WAIT_MS env, else 600_000 (10 min)
  pollIntervalMs?: number   // default 5_000
}): Promise<void>
```

`checkMemoryPressure` is one query:

```sql
SELECT
  (SELECT value FROM system.metrics WHERE metric = 'MemoryTracking')                AS used,
  (SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage') AS ceiling
```

Both tables/columns confirmed present and queryable on this ClickHouse version (26.3) during this session's live verification.

### Integration points

Both already shared by the inbox watcher and the HTTP upload route through the same pipeline, so the fix covers both sources without touching either caller's own code beyond these two call sites:

1. **`streamCredentialsToTable`**, batch loop in `lib/upload-processor.ts` — call `await waitForHeadroom(signal)` immediately before each `insertBatch(...)` call. This is what turns "many batches hammered back-to-back on a large file" into "pause when the server's getting tight, let background merges catch up, resume."
2. **`enqueueFile`**, `lib/inbox-watcher.ts` — call `await waitForHeadroom(signal)` before the claim (`claimFileForProcessing`), so a new file doesn't start while the server is already hot from the previous one.

Neither call site has an `AbortSignal` already in scope: `streamCredentialsToTable`'s loop calls `insertBatch(...)`, which creates its own signal internally via `withClickHouseRetry` — the loop itself has none — and `enqueueFile` has no signal either. Both integration points create a fresh, short-lived `AbortController` for the single pressure check, matching the pattern `sourceAlreadyImported`'s callers already use elsewhere in this file.

### Data flow

**Normal case** (server not under pressure — the common case): guard's single query shows ratio well under threshold, returns immediately. Overhead is one cheap metrics query per batch (milliseconds) — no observable behavior change from today.

**Pressured case** (large file, or server already busy from background work): guard logs one warning, polls every 5s until the ratio drops back under threshold, then proceeds. Applied both before claiming a file and between every batch within it, so a long file paces itself to the server's actual capacity instead of racing ahead of it.

### Config change: `docker/clickhouse/config/ulp-performance.xml`

`max_server_memory_usage`: 16GB → **18GB**. Comment updated to record the live verification from this session (612MB idle `MemoryTracking`, 11GB idle cgroup RSS mostly page cache, 20GB hard container `mem_limit`, 26GB host available) so the reasoning doesn't need re-deriving by a future session. 2GB margin kept under the container's hard 20GB `mem_limit` intentionally: if ClickHouse's own tracked usage ever did reach the ceiling, the alternative to `OvercommitTracker` gracefully killing one query is the kernel cgroup-OOM-killing the entire server process — the failure mode a prior (2026-06-07) incident was about. The 75% backpressure threshold means the guard starts pausing around ~13.5GB, well before the new 18GB ceiling is ever approached under normal operation.

### Recovering the 11 stuck files

No new tooling needed — `POST /api/inbox/retry` with `{ all: true }` (→ `lib/inbox-helpers.ts`'s `retryAllFailed()`) already exists and is wired to the Inbox Monitor UI's **Retry All** button. Since the pipeline is already single-file-at-a-time (`pLimit(1)`), it's safe to retry all 11 at once — they queue and process sequentially, each covered by the new guard. Expect 10 of the 11 to succeed; the `.08`-extension file will immediately bounce back to `failed/` with the same "unsupported extension" message as before — expected, not a regression. Sequence:

1. Deploy this fix (rebuild + restart `ulpsuite_app`, restart `ulpsuite_clickhouse` to pick up the config change).
2. Click **Retry All** in the Inbox Monitor (or `POST /api/inbox/retry {"all": true}` directly).
3. Watch `docker compose logs app` for the new pressure-check log lines and confirm the first file or two land cleanly in `inbox/done/` before assuming the rest will too.

### Testing

- `lib/clickhouse-memory-guard.ts` unit tests against a mocked ClickHouse client: resolves immediately when ratio is under threshold; polls and waits when over threshold until a subsequent check reports it's dropped; fail-open (resolves without throwing) when the query itself errors; fail-open after `maxWaitMs` elapses while still over threshold.
- `lib/upload-processor.ts` / `lib/inbox-watcher.ts`: a spy-based test confirming `waitForHeadroom` is called before each batch insert and before claiming a file.
- Manual, post-deploy: restore 1–2 of the 11 stuck files first (not all 11) via the UI's per-file retry, confirm a clean `done/` landing with no memory-limit error in `processing_jobs`, before retrying the rest.

## Out of scope

- Changing file-size limits, `UPLOAD_BATCH_SIZE`, or the single-file (`pLimit(1)`) concurrency model.
- Any ClickHouse setting other than `max_server_memory_usage` (mark/uncompressed cache sizes, background pool size, etc. were already tuned by prior sessions and are working).
- `bronvault_clickhouse` / `bronvault_minio`'s unbounded memory limits — a different project sharing this host, noted as a risk but not this design's to fix.
- Auto-splitting large files into chunks (Approach C) — superseded by backpressure per the reasoning above.
