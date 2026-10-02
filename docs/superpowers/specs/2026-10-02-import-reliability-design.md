# Import reliability — design (2026-10-02)

Status: **proposed, not implemented.** Sub-project 1 of the 2026-10-02 improvement plan; sub-project 2 is
`2026-10-02-novelty-aware-ingest-design.md` (build this one first: both touch `lib/upload-processor.ts`).
Everything marked *verified* was reproduced on an isolated stack (`docker-compose.rehearsal.yml`, the live app image, a fresh ClickHouse) on
2026-10-02; nothing was run against the live tables.

## What is wrong

`POST /api/upload` (and the Upload page that calls it) answers **before it has the file**: it returns `{jobId, streamUrl, queue_position}`
immediately and lets the request body trickle into the importer as the importer consumes it. The import then waits in the shared
`uploadQueue` (the inbox watcher uses the same queue) and reads the body only when its turn comes and only as fast as ClickHouse accepts rows.
That design fails in four ways, all *verified*:

| # | Trigger | What happens |
|---|---|---|
| D1 | The importer stops reading for 5 s or more: one slow insert, a memory-guard wait, a ClickHouse restart, the 04:00Z dedup scan | Node's `keepAliveTimeout` (5 s; Next standalone reads it only from env `KEEP_ALIVE_TIMEOUT`, unset in compose) kills the idle socket. The job never finishes and never fails, logs nothing, and **holds its queue slot until the app restarts**. 3 s freeze survived, 8 s hung. |
| D1b | An upload is submitted while every queue slot is busy (UPLOAD_CONCURRENCY is 2 live; the inbox shares the slots) | It is answered `queue_position 1`, but its body is not read, the server closes its connection after about 6.5 s (the client had managed to send 8 of 28 MB), and when its turn comes the job runs on a dead stream, imports 0 rows and **holds the slot** (still held 90 s after the first upload finished; only an app restart clears it). |
| D2 | The body takes more than 300 s to arrive (Node `requestTimeout`, not configurable from env in Next standalone) | The request is cut mid-file (300k of 350k rows imported at 329 s in a slow-client test) and the job hangs. The 10 GiB "max file size" setting is unreachable over HTTP. |
| D3 | The client disconnects mid-upload: tab closed, network drop, laptop sleep. Cut with FIN and with RST, 200k rows already imported | The job imports whatever was buffered (300,000 of 800,000 rows), then **hangs forever** with status `running`, nothing in the app log, and a following upload is not imported (slot held). |

One cause explains all four (an inference, consistent with the contrast below): once the early response has finished, Node no longer reports
a socket failure on that request's body stream, so the consumer waits forever instead of erroring.

**The contrast that makes the fix obvious.** `.zip` uploads (and the v1 API's `.zip`) first write the body to a temp file, then queue.
*Verified:* an 8 s ClickHouse freeze is survived; a client disconnect (FIN and RST) logs `Upload error: aborted (ECONNRESET)`, removes the temp
file, leaves the queue free and imports nothing. The inbox path (a file on disk) survived a ClickHouse restart and a 20 s stop with exact counts.

Other findings:

- **The HTTP route is effectively untested in production.** The live `processing_jobs` has 880 inbox jobs and exactly 2 HTTP jobs, the last on
  2026-07-05, before the 2026-08-16 rewrite. The inbox is the path in real use; the risk is that one badly timed HTTP upload wedges the shared
  queue and stops the inbox too. A real browser (`fetch` with a `File` body, the Upload page's call) imports a 24 MB file correctly when a slot
  is free (*verified*: 300,000 rows, status `done`).
- **`isTransientClickHouseError` treats every numeric ClickHouse code as final** (`lib/clickhouse-retry.ts`, `hasSemanticClickHouseError`),
  so `TABLE_IS_READ_ONLY` (242), Keeper `Session expired` (999) and `TOO_MANY_PARTS` (252, also listed in `SEMANTIC_MESSAGES`) abort an import
  that a 1-second retry would complete. The live server logged Keeper session expiries on 2026-09-30 and 2026-10-01 (laptop suspend/resume,
  read-only window about 0.1 s). *Code and log evidence only; not reproduced* (`docker pause` is not equivalent to a suspend).
- **No attribution, no trace of a hung job.** `AuditAction` already defines `upload.start/complete/fail` and `upload.api.*`, but nothing
  emits them. `processing_jobs` is written at completion only and has no user column, so a hung job leaves no row. Inbox Retry is not audited.
- **Dedup window.** A failed file retried after more than 3600 s / 10000 blocks re-inserts the batches that already landed (sub-project 2
  removes this for good; until then a retry can leave duplicates for the cron).

## Goals

1. An upload can never wedge the queue: not by a stall, a queued wait, a disconnect or a timeout.
2. A cut upload imports **nothing** and records nothing (today it imports a partial file).
3. Every upload is attributed (who, what, how it ended) and a hung or stalled job is visible and ends in `failed` with a reason.
4. Transient Keeper/read-only/part-pressure errors are retried like other transient errors.
5. No change to the response JSON shape or to the v1 API's synchronous result.

## Approaches

| | Verdict |
|---|---|
| A. Set `KEEP_ALIVE_TIMEOUT=3600000` only | Verified to fix D1 (8 s and 20 s freezes survived). Leaves D1b past 300 s, D2 and D3, so rejected as the fix. Not needed once the early reply is gone. |
| **B. Receive the whole body into a spool file first, reply, then import from the file** | **Recommended.** The same shape as the ZIP and inbox paths that were verified robust; removes D1, D1b, D2's partial import and D3; the importer never touches the socket. |
| C. Make the HTTP route write into `inbox/` and let the watcher import | One path for everything, and the proven one. But it changes the response contract (no synchronous v1 result, SSE job mapping), loses `inbox` filename-collision safety, and adds the watcher's 2-33 s pickup latency. A possible later consolidation, not now. |

## Design (approach B)

### Receive, then reply (`lib/upload-spool.ts`)

`spoolRequestBody(body, { maxBytes, signal, expectedBytes? }) -> { path, bytes }`:

- Writes to `${UPLOAD_SPOOL_DIR:-/tmp/ulp-spool}/<uuid>.part` (the container's `/tmp` is on the host disk, not tmpfs, and the ZIP branch already uses it),
  then renames to `.upload` when the body ended normally. Any error, abort or short body deletes the file.
- Honours `request.signal` (Next aborts it when the client disconnects before the response finishes) and the existing `capWebStream` byte cap.
- When `Content-Length` is present, `bytes` must equal it, otherwise `400 incomplete upload`; a truncated body is never imported.
- Refuses before writing when free space (`fs.statfs`) minus the declared size would fall below `UPLOAD_SPOOL_MIN_FREE_BYTES` (default 20 GiB; the
  disk is shared with ClickHouse, whose own guard has a 50 GiB / 15% floor), and cuts a body without a length at the same floor (`507`).
- A janitor (`sweepSpool()`, called from `instrumentation.ts` at startup and hourly) deletes spool files that no running job in this process owns
  (all of them at startup: a new process owns none; files older than 1 h afterwards). Owned paths live in a `globalThis` registry, like the queue.

Routes, all three using the helper:

- `POST /api/upload` `.txt/.csv`: spool, then `createJob`, audit `upload.start`, enqueue, **then reply** with the same JSON
  (`success, jobId, streamUrl, queue_position`). Only the moment of the reply changes. The Upload page switches from `fetch` to
  `XMLHttpRequest` so it can show transfer progress (`upload.onprogress`) before the SSE import progress starts, shows "queued, position N", and
  on a network error for a large file says "use the inbox folder for files this large".
- `POST /api/upload` `.zip`: same helper instead of the hand-written pipeline; response contract unchanged (synchronous result).
- `POST /api/v1/upload`: spool first (it currently leaves the body unread while queued, so a wait over 300 s kills it), then queue and
  process from the file; the synchronous response is unchanged. (An `?async=1` mode is possible later.)

Processing becomes `processTextFile(path, filename, ...)`: `fs.createReadStream` -> `Readable.toWeb` -> the unchanged `processTextStream`, exactly how the inbox
feeds it, then `unlink` in a `finally`.

What stays: a body must arrive within Node's 300 s `requestTimeout`. With the spool this limit is **clean**: the cut upload leaves no job,
no rows and no file. Very large files are still better dropped in the inbox, and the page says so.

### Cancellation and a stall watchdog (`lib/import-runner.ts`)

`runImportJob({ label, signal?, work })` is the one wrapper used by the HTTP routes and the inbox watcher:

- An `AbortController` linked to any external signal; `work(signal, beat)` receives both.
- **A heartbeat watchdog.** `beat()` is called after every inserted batch, on every `withClickHouseRetry` retry event and on every
  memory-guard poll. If there is no beat for `IMPORT_STALL_TIMEOUT_MS` (default 20 min, above the guard's 10 min maximum wait) the runner aborts the
  signal and rejects with `ImportStalledError`. It measures time with `performance.now()`, **not `Date.now()`**: this laptop suspends, the
  monotonic clock does not advance during suspend, and a wall-clock watchdog would fail a healthy job the moment the lid reopens.
- **Slot release is independent of `work` finishing.** The queued task returns when `work` settles *or* the signal aborts (a race), so a wedged
  pipeline can never hold a slot again; the stuck promise is abandoned and logged.
- `streamCredentialsToTable`, `insertBatch` and `withClickHouseRetry` accept the signal: abort cancels the in-flight request and stops retrying.
  `processZipFile` takes the same signal and beat, so every entry of an archive counts as progress.
  The inbox moves the file to `failed/` with the stall/abort reason, as it does for any failure.

### Retry classification (`lib/clickhouse-retry.ts`)

A small, documented allow-list checked before the "numeric code means semantic" rule: code `242` (read-only table), `999` only when the message
matches `session expired` / `connection loss` / `operation timeout`, `252` (too many parts: wait for merges), `209`/`210` (network), and
`ENOTFOUND` in `TRANSIENT_CODES`. Unit tests use realistic messages and keep `bad query`, `syntax error` and per-query `memory limit` final.

### Attribution and visibility

`createAuditLog` (existing) gets `upload.start` / `upload.complete` / `upload.fail` for the HTTP route (user id and email from the session),
`upload.api.*` for v1 (API key id), and a new `inbox.retry` action for the Retry route. `processing_jobs` already records completion and failure;
a stalled or aborted job now ends in a `failed` row with the reason. No schema change.

## Verification plan

1. Unit tests: spool (complete, aborted, short body, cap exceeded, ENOSPC, free-space refusal, janitor ownership); runner (fake timers; monotonic
   clock; heartbeat sources; slot released while `work` never settles; abort during a retry sleep); the retry classification table; route tests
   (spool precedes the queue, the response follows the spool, abort leaves no job and no file, v1 and ZIP use the helper).
2. A committed e2e script, `scripts/e2e-upload-resilience.ts`, on the isolated stack (the scratch drivers from this investigation are the
   starting point): a browser-like client (raw socket) imports all rows; cut mid-body with FIN and with RST leaves no job, no rows, no spool file
   and a free slot; a second upload submitted while the first runs completes with all rows (the D1b case); ClickHouse frozen 8 s mid-import
   still completes; frozen 45 s, with the rehearsal stack's 30 s stall timeout, fails the job with the stall reason while ClickHouse is still
   frozen and the next upload works after the unfreeze;
   a ZIP cut mid-body leaves nothing; `--slow` (about 6 min) proves the 300 s cut is clean.
3. A real-browser check on the isolated stack through the Upload page (the in-app browser), including a cut (page closed mid-transfer).
4. The existing suite (1,864 tests) and the rehearsal e2e (36/36) stay green; `next build` already runs in the image build.

Rollout: build the image, run the e2e on the isolated stack, deploy to the local compose while idle (`docker compose build app` then `up -d app`,
anchored to the main checkout), keep the previous image tagged for rollback. The HTTP route has had 2 production uses, so the regression surface is small.

## Decisions for the owner (defaults in bold)

- **S1.** The reply moves to after the body is received (page shows transfer progress, then import progress). The JSON shape is unchanged.
- **S2.** v1 keeps its synchronous result; `?async=1` is a later option.
- **S3.** Spool in `/tmp/ulp-spool` with a 20 GiB free-space floor.
- **S4.** Stall timeout 20 minutes of awake time.
- **S5.** Do not set `KEEP_ALIVE_TIMEOUT` (not needed once nothing replies early).

## Deliberately NOT done

- Raising Node's `requestTimeout` (a preload shim could, but the clean cut plus the inbox covers it), resumable/chunked uploads, an async ZIP
  flow, a Cancel button, persisting queued jobs across an app restart (a restart still drops queued uploads; the page reports "job not found").
