# Inbox watcher: guard against reading files mid-write

- **Date:** 2026-07-05
- **Status:** Approved (design)
- **Scope:** Fix `lib/inbox-watcher.ts` so a file dropped into `./inbox/` via a non-atomic write (e.g. `cp` of a large file) is never claimed and read before it's fully written. Also recovers the specific files already lost to this bug. Does not change the auto-detection mechanism itself (already confirmed working) or the single-file processing concurrency model.

## Problem

A user-facing job log showed several large files (`@ARCEUSULP #89` through `#93`) completing in 5-7ms with **0 rows imported**, marked `done` (not `failed`) — no error surfaced. Filenames imply expected counts from 16,491 to 1,288,598 rows each; combined, roughly 2.7M rows of real data silently never made it into `ulp.credentials`.

Confirmed live: `mansory (1).txt`'s 0-row result is unrelated and correct — `ulp.sources` shows it was genuinely imported the day before (`2026-07-04 15:20:46`, 6.03M rows), so the existing durable re-upload guard (`lib/upload-processor.ts`'s `sourceAlreadyImported` check) correctly skipped a real re-drop of already-imported data. That guard is not the cause of the `@ARCEUSULP` files' 0-row results — none of them appear in `ulp.sources` at all.

Root cause reproduced directly: a file written slowly into `./inbox/` (20 lines, 0.5s apart, simulating what `cp` does for a large file) ended up fully-written and valid on disk in `inbox/done/`, but **zero rows** landed in ClickHouse. `lib/inbox-watcher.ts`'s `enqueueFile()` claims and reads a file as soon as it exists in `inbox/`, with no check that writing has finished. For a regular file, `fs.createReadStream` hits EOF based on the file's size *at read time*, not its eventual final size — so a file caught mid-write by chokidar's 2-second poll (or the independent 30-second `reconcile()` loop) is read only up to whatever had been flushed to disk at that instant, then silently "completes" with 0 or a handful of rows. No exception is thrown, since reaching EOF isn't an error.

Confirmed via a clarifying question: files are placed into `./inbox/` via plain `cp`/`mv` from elsewhere on the same machine — matching this project's own documented usage (`docs/superpowers/specs/2026-05-29-inbox-monitor-design.md`: `cp /path/to/dumps/*.txt ~/ulp-suite/inbox/`). `cp` writes incrementally for large files; this is the exact window the race exploits.

This is a separate finding from an earlier investigation in this same session, which confirmed the *auto-detection* mechanism (chokidar polling + reconcile) works correctly and needs no "Force Scan" — that finding stands. This bug is about what happens once a file *is* detected: it can be read before it's completely written.

## Approaches considered

**A — Chokidar's built-in `awaitWriteFinish` option alone.** Rejected: only delays chokidar's `'add'` event. The independent `reconcile()` loop (explicitly documented as "the reliability guarantee" — runs on its own 30s schedule regardless of chokidar) calls the same claiming logic directly via its own `fs.readdirSync` scan and would still race the same way.

**B (chosen) — A manual stability check inside the shared `enqueueFile()` function.** Both the chokidar handler and `reconcile()` already call this one function, making it the single, DRY point to enforce "don't claim until the file has stopped growing." Requires making `enqueueFile` async and having both callers avoid blocking on it, so multiple candidate files' checks run concurrently.

**C — Require atomic drops (temp name + rename convention).** Rejected as the primary fix: depends on remembering to do it differently every time, breaks the moment any other tool or workflow writes directly into `inbox/`, and leaves the actual code gap unfixed.

## Design

### New primitive: `lib/inbox-claim.ts`

This module is already documented as "Pure fs/path only — no app singletons — so they are unit-testable against a real temp directory," and already holds the other claim-related reliability primitive (`claimFileForProcessing`). The new function belongs here:

```ts
/**
 * Checks whether a file's size has stopped changing over `waitMs`, as a proxy
 * for "an external writer (e.g. cp of a large file) has finished." Returns
 * false (not stable) if the file vanishes between checks — treated the same
 * as "still changing," not as an error: the caller should skip this attempt,
 * not throw.
 */
export async function isFileSizeStable(filePath: string, waitMs: number): Promise<boolean> {
  let before: number
  try {
    before = fs.statSync(filePath).size
  } catch {
    return false
  }
  await new Promise(resolve => setTimeout(resolve, waitMs))
  try {
    const after = fs.statSync(filePath).size
    return after === before
  } catch {
    return false
  }
}
```

### Integration: `lib/inbox-watcher.ts`

`enqueueFile()` becomes `async function enqueueFile(filePath: string): Promise<void>`. Its existing fast synchronous checks stay in the same order and are unchanged: unsupported-extension handling, `inFlight.has()` dedup, and the done/failed/processing path-prefix guard all run first, exactly as today — there's no reason to stability-check a file being ignored for another reason.

Only after those checks pass does the new logic run:

```ts
if (!(await isFileSizeStable(filePath, STABILITY_CHECK_WAIT_MS))) {
  // Not stable yet (or vanished) — skip this attempt without marking inFlight.
  // The file is untouched in inbox/, so the next chokidar poll (~2s) or
  // reconcile pass (~30s) will check again with fresh stat calls. An
  // arbitrarily slow writer resolves correctly over time with no new
  // timeout/retry-count logic — this reuses the polling cadence that
  // already exists for exactly this kind of "catch what we missed" case.
  return
}
```

This runs *before* the existing `inFlight.add(filename)` / `pendingTasks.add(filename)` / `uploadQueue(...)` block, which is otherwise unchanged.

New constant, alongside the file's existing `RECONCILE_INTERVAL_MS`/`DONE_MAX_AGE_MS`:

```ts
const STABILITY_CHECK_WAIT_MS = 1_000   // gap between size checks before claiming a file
```

### Callers

- Chokidar's `.on('add', enqueueFile)` already doesn't await its listener's return value — an async `enqueueFile` requires no change here, and multiple 'add' events already fire independently.
- `reconcile()`'s `for` loop currently calls `enqueueFile(filePath)` synchronously per entry. Change to not await inside the loop (fire each call, let it resolve independently), so N candidate files' stability checks run concurrently rather than serially — only the actual heavy processing afterward should serialize, and it already does via the existing `uploadQueue` (`pLimit(1)`).

### Testing

- `lib/inbox-claim.ts`: new tests for `isFileSizeStable()` against a real temp directory (matching this module's existing test style, not mocks) — a file whose size is unchanged across the wait returns `true`; a file that grows during the wait (write more bytes mid-check) returns `false`; a file removed between checks returns `false` without throwing.
- `lib/inbox-watcher.ts` / its test file: confirm `enqueueFile` does not add an unstable file to `inFlight` and does proceed for a stable one.

### Data recovery (once the fix is verified)

The 5 files already affected (`@ARCEUSULP #89` through `#93`) sit in `inbox/done/` with 0 imported rows recorded. `POST /api/inbox/retry` only moves files from `inbox/failed/`, not `inbox/done/`, so recovery here is a manual, one-time step: move those 5 specific files from `inbox/done/` back into `inbox/` and let the (now-fixed) watcher reprocess them. Verify each imports a row count matching its filename (e.g. `#89 (16,491)` → 16,491 rows) before considering recovery complete.

## Out of scope

- Any change to the auto-detection mechanism itself (chokidar polling interval, 30s reconcile cadence) — already confirmed working correctly in this session's earlier investigation.
- Any change to the single-file (`pLimit(1)`) processing concurrency model.
- A permanent "retry from done/" UI feature — this recovery is a one-time operational step for 5 known files, not a recurring need.
