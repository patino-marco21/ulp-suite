# Inbox Status globalThis Singleton Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox watcher's live status (current job, queue depth, progress) and its shared upload concurrency limiter actually shared between `instrumentation.ts` (which runs the real watcher) and the API routes that read/use them, so the Inbox Monitor dashboard stops lying about "Idle" during real imports, and a manual web upload can no longer run concurrently with an inbox-dropped file.

**Architecture:** `lib/upload-queue.ts` and `lib/inbox-watcher.ts` currently hold shared state (`uploadQueue`, `_currentJob`, `inFlight`, `pendingTasks`, `_currentProgress`) in plain module-scope variables. Next.js's production (`output: 'standalone'`) build compiles `instrumentation.ts` and each API route handler as separate webpack bundles, so these variables silently become multiple independent instances instead of one shared instance. Anchoring each to `globalThis` under a unique key makes every bundle's copy of the code read and write the same true process-wide object, fixing the sharing without changing any function signature or any API route's code.

**Tech Stack:** TypeScript, Vitest, `p-limit`, Docker/docker-compose for the running app, `curl` for live HTTP verification against the real running container.

## Global Constraints

- No function signature changes in `lib/upload-queue.ts` or `lib/inbox-watcher.ts` — every existing caller (4 API routes) keeps working unmodified.
- `globalThis` keys use the `__ulp` prefix (`__ulpUploadQueue`, `__ulpCurrentJob`, `__ulpInFlight`, `__ulpPendingTasks`, `__ulpCurrentProgress`) — confirmed via grep to not collide with anything already in the codebase.
- TypeScript requires `var` (not `let`/`const`) inside `declare global { ... }` blocks — this is a language requirement, not a style choice.
- Test domains for live-verification tasks use the `.invalid` TLD (RFC 2606 reserved for exactly this purpose), matching this session's established convention (e.g. `stability-fix-verify.invalid`).
- Reference spec: `docs/superpowers/specs/2026-07-05-inbox-status-globalthis-singleton-design.md`.
- `started` (the idempotency flag in `startInboxWatcher()`) is explicitly NOT converted to `globalThis` — only `instrumentation.ts` ever calls `startInboxWatcher()` (confirmed via grep), so it never needs cross-bundle sharing.

---

### Task 1: `lib/upload-queue.ts` — globalThis-backed queue and current-job tracking

**Files:**
- Modify: `lib/upload-queue.ts`
- Modify: `__tests__/upload-queue.test.ts`

**Interfaces:**
- Produces: `uploadQueue`, `queueSize()`, `setCurrentJob(name: string | null): void`, `getCurrentJob(): string | null`, `parseConcurrency(raw?: string): number` — all unchanged signatures, now globalThis-backed internally.

This task has a subtlety: `__tests__/upload-queue.test.ts` already has two tests (`'honours UPLOAD_CONCURRENCY when building the limiter'` and `'defaults the limiter to concurrency 1'`) that call `vi.resetModules()` then re-import `@/lib/upload-queue`, expecting a **brand new** `pLimit` instance reflecting a freshly-read env var. Once `uploadQueue` is globalThis-backed, `vi.resetModules()` alone no longer produces a fresh instance — `globalThis` survives module-registry resets by design (that's the whole point of the fix). Both tests must also delete the cached global key to keep simulating "a fresh process reads a new env value," which is what they actually intend to test.

- [ ] **Step 1: Write the failing tests for the new globalThis-backed behavior**

Add this new `describe` block to the end of `__tests__/upload-queue.test.ts` (after the existing `describe('uploadQueue concurrency from env', ...)` block). Do NOT add a `declare global` block here — `lib/upload-queue.ts` declares `__ulpUploadQueue`/`__ulpCurrentJob` globally as part of Step 4 below, and TypeScript's ambient declarations apply program-wide once that file exists (it's already included in the project's compilation regardless of what imports it). A second, separate `declare global` for the same keys in this test file would risk a "subsequent declarations must have the same type" error if its type expression isn't textually identical to the lib file's:

```ts
describe('globalThis-backed singleton (survives cross-chunk duplication)', () => {
  test('the exported uploadQueue is the same object stored on globalThis', () => {
    expect(globalThis.__ulpUploadQueue).toBe(uploadQueue)
  })

  test('setCurrentJob/getCurrentJob read and write through globalThis', async () => {
    const { setCurrentJob, getCurrentJob } = await import('@/lib/upload-queue')
    setCurrentJob('probe-globalthis-job.txt')
    expect(globalThis.__ulpCurrentJob).toBe('probe-globalthis-job.txt')
    expect(getCurrentJob()).toBe('probe-globalthis-job.txt')
    setCurrentJob(null)
    expect(globalThis.__ulpCurrentJob).toBeNull()
    expect(getCurrentJob()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run __tests__/upload-queue.test.ts`
Expected: FAIL — `globalThis.__ulpUploadQueue` is `undefined` (property doesn't exist yet on the current module), so `toBe(uploadQueue)` fails.

- [ ] **Step 3: Fix the two existing tests that assume `vi.resetModules()` alone creates a fresh queue**

Replace this block:

```ts
describe('uploadQueue concurrency from env', () => {
  const original = process.env.UPLOAD_CONCURRENCY
  afterEach(() => {
    if (original === undefined) delete process.env.UPLOAD_CONCURRENCY
    else process.env.UPLOAD_CONCURRENCY = original
    vi.resetModules()
  })

  it('honours UPLOAD_CONCURRENCY when building the limiter', async () => {
    process.env.UPLOAD_CONCURRENCY = '3'
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(3)
  })

  it('defaults the limiter to concurrency 1', async () => {
    delete process.env.UPLOAD_CONCURRENCY
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(1)
  })
})
```

with:

```ts
describe('uploadQueue concurrency from env', () => {
  const original = process.env.UPLOAD_CONCURRENCY
  afterEach(() => {
    if (original === undefined) delete process.env.UPLOAD_CONCURRENCY
    else process.env.UPLOAD_CONCURRENCY = original
    // The queue is now a globalThis-backed singleton (lib/upload-queue.ts) so
    // it survives vi.resetModules() by design -- that IS the fix under test
    // elsewhere in this file. These two tests specifically simulate a fresh
    // process picking up a new env value, so they must also clear the cached
    // global, not just reset the module registry.
    delete globalThis.__ulpUploadQueue
    vi.resetModules()
  })

  it('honours UPLOAD_CONCURRENCY when building the limiter', async () => {
    process.env.UPLOAD_CONCURRENCY = '3'
    delete globalThis.__ulpUploadQueue
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(3)
  })

  it('defaults the limiter to concurrency 1', async () => {
    delete process.env.UPLOAD_CONCURRENCY
    delete globalThis.__ulpUploadQueue
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(1)
  })
})
```

- [ ] **Step 4: Implement the globalThis-backed singleton**

Replace the full contents of `lib/upload-queue.ts` with:

```ts
/**
 * Global upload concurrency limiter.
 *
 * pLimit(1) = one file processed at a time; all others wait in FIFO order.
 * Both the HTTP upload route and the inbox watcher share this queue so they
 * never compete for memory.
 *
 * Raise to 2–3 on machines with ≥16 GB RAM and multi-core CPUs if throughput
 * matters more than peak-memory predictability.
 */
import pLimit from 'p-limit'

/**
 * Parse UPLOAD_CONCURRENCY into a safe limiter size.
 * Invalid, empty, zero, or negative values fall back to 1.
 *
 * NB: raising this multiplies peak heap — each concurrent file holds its own
 * in-flight batch(es) AND its own ~440 MB-capped dedup Set. Only raise on
 * hardware with memory headroom. getCurrentJob() becomes best-effort ("one of
 * N") when concurrency > 1.
 */
export function parseConcurrency(raw?: string): number {
  const n = parseInt(raw ?? '1', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

// globalThis-backed singletons -----------------------------------------------
//
// instrumentation.ts (which starts the inbox watcher) and the API routes that
// read/use this queue are compiled into SEPARATE webpack chunks in this app's
// production (output: 'standalone') build -- confirmed by inspecting the
// compiled .next/server/ output, where this file's code appeared duplicated
// across multiple chunk files. A plain module-scope `const`/`let` here would
// silently become multiple independent instances: one that the real watcher
// updates, and others -- always empty -- that routes read. globalThis is one
// true object per OS process regardless of which chunk loaded this file, so
// anchoring state to it is what makes it actually shared. See
// docs/superpowers/specs/2026-07-05-inbox-status-globalthis-singleton-design.md
declare global {
  // eslint-disable-next-line no-var
  var __ulpUploadQueue: ReturnType<typeof pLimit> | undefined
  // eslint-disable-next-line no-var
  var __ulpCurrentJob: string | null | undefined
}

export const uploadQueue =
  globalThis.__ulpUploadQueue ??
  (globalThis.__ulpUploadQueue = pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY)))

/** Total number of uploads currently running + waiting. */
export function queueSize(): number {
  return uploadQueue.activeCount + uploadQueue.pendingCount
}

// ── Current job tracking ──────────────────────────────────────────────────────

/** Set the filename of the job currently being processed. Pass null when done. */
export function setCurrentJob(name: string | null): void {
  globalThis.__ulpCurrentJob = name
}

/** Returns the filename currently being processed, or null if the queue is idle. */
export function getCurrentJob(): string | null {
  return globalThis.__ulpCurrentJob ?? null
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/upload-queue.test.ts`
Expected: PASS — all tests in the file, including the two fixed ones and the two new ones.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full test suite to confirm no other regressions**

Run: `npx vitest run`
Expected: all test files pass (832+ tests — the exact count will be a few higher than before this task, from the new tests added).

- [ ] **Step 8: Commit**

```bash
git add lib/upload-queue.ts __tests__/upload-queue.test.ts
git commit -m "fix(upload-queue): anchor shared queue/current-job state to globalThis

instrumentation.ts and the API routes that read this state are compiled
into separate webpack chunks in production, so the plain module-scope
variables here were silently two independent instances instead of one
shared queue."
```

---

### Task 2: `lib/inbox-watcher.ts` — globalThis-backed inFlight/pendingTasks/progress

**Files:**
- Modify: `lib/inbox-watcher.ts`
- Test: `__tests__/inbox-watcher-globalthis.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new from Task 1 (this task's changes are independent of Task 1's files).
- Produces: `getInboxJobProgress(): InboxJobProgress | null`, `getInFlightCount(): number` — unchanged signatures, now globalThis-backed internally. `InboxJobProgress` interface unchanged.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/inbox-watcher-globalthis.test.ts`. Do NOT add a `declare global` block here — `lib/inbox-watcher.ts` declares `__ulpInFlight`/`__ulpPendingTasks`/`__ulpCurrentProgress` globally as part of Step 3 below, and that declaration applies program-wide once the file exists. A second, separate `declare global` for the same keys in this test file would risk a "subsequent declarations must have the same type" error from `tsc` if its type expression isn't textually identical to the lib file's:

```ts
import { describe, test, expect, afterEach } from 'vitest'
import { getInFlightCount, getInboxJobProgress } from '@/lib/inbox-watcher'

describe('inbox-watcher globalThis-backed state (survives cross-chunk duplication)', () => {
  afterEach(() => {
    globalThis.__ulpInFlight?.delete('probe-globalthis-inflight.txt')
    globalThis.__ulpCurrentProgress = null
  })

  test('getInFlightCount reads from the globalThis-backed Set', () => {
    const before = getInFlightCount()
    expect(globalThis.__ulpInFlight).toBeInstanceOf(Set)
    globalThis.__ulpInFlight!.add('probe-globalthis-inflight.txt')
    expect(getInFlightCount()).toBe(before + 1)
    globalThis.__ulpInFlight!.delete('probe-globalthis-inflight.txt')
    expect(getInFlightCount()).toBe(before)
  })

  test('pendingTasks is also globalThis-backed', () => {
    expect(globalThis.__ulpPendingTasks).toBeInstanceOf(Set)
  })

  test('getInboxJobProgress reads from the globalThis-backed value', () => {
    expect(getInboxJobProgress()).toBeNull()
    globalThis.__ulpCurrentProgress = {
      filename: 'probe.txt', started_at: Date.now(), rows_imported: 5, file_size_bytes: 100,
    }
    expect(getInboxJobProgress()).toEqual({
      filename: 'probe.txt', started_at: expect.any(Number), rows_imported: 5, file_size_bytes: 100,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/inbox-watcher-globalthis.test.ts`
Expected: FAIL — `globalThis.__ulpInFlight` is `undefined` (the module hasn't been changed yet), so `toBeInstanceOf(Set)` fails.

- [ ] **Step 3: Implement the globalThis-backed singletons**

In `lib/inbox-watcher.ts`, replace:

```ts
let started = false

const DONE_MAX_AGE_MS         = 7 * 24 * 60 * 60 * 1_000   // 7 days
const RECONCILE_INTERVAL_MS   = 30_000                       // scan for missed files every 30 s
const STABILITY_CHECK_WAIT_MS = 1_000                        // gap between size checks before claiming a file

/**
 * Filenames that have been submitted to uploadQueue (both pending and active).
 * Entries are added in enqueueFile() and removed in the task's finally block.
 *
 * This is the source of truth for "is this file already in pLimit?".
 * inFlight mirrors pendingTasks but is also used by reconcile() as a fast guard.
 *
 * The distinction matters for clearStaleInFlight():
 *   inFlight = filenames added by enqueueFile (may include true orphans)
 *   pendingTasks = filenames with live pLimit tasks (active OR queued)
 *
 * An entry in inFlight but NOT in pendingTasks is a true orphan
 * (enqueueFile was called but the task's finally never ran — should never
 * happen in normal operation but guards against future bugs).
 */
const inFlight    = new Set<string>()
const pendingTasks = new Set<string>()  // subset of inFlight — has live pLimit task

/** Live progress for the file currently being processed. */
export interface InboxJobProgress {
  filename:        string
  started_at:      number   // Date.now() when processing began
  rows_imported:   number   // rows successfully inserted so far
  file_size_bytes: number   // from fs.statSync before processing
}

let _currentProgress: InboxJobProgress | null = null

/** Returns live progress for the inbox file currently being processed, or null if idle. */
export function getInboxJobProgress(): InboxJobProgress | null {
  return _currentProgress
}

/** Number of filenames currently marked as queued or in-progress. */
export function getInFlightCount(): number {
  return inFlight.size
}
```

with:

```ts
let started = false

const DONE_MAX_AGE_MS         = 7 * 24 * 60 * 60 * 1_000   // 7 days
const RECONCILE_INTERVAL_MS   = 30_000                       // scan for missed files every 30 s
const STABILITY_CHECK_WAIT_MS = 1_000                        // gap between size checks before claiming a file

/** Live progress for the file currently being processed. */
export interface InboxJobProgress {
  filename:        string
  started_at:      number   // Date.now() when processing began
  rows_imported:   number   // rows successfully inserted so far
  file_size_bytes: number   // from fs.statSync before processing
}

// globalThis-backed singletons -----------------------------------------------
//
// instrumentation.ts (which calls startInboxWatcher()) and the API routes
// that read this state (app/api/inbox/status, app/api/inbox/scan) are
// compiled into SEPARATE webpack chunks in this app's production
// (output: 'standalone') build. A plain module-scope `const`/`let` here
// would silently become multiple independent instances: one the real
// watcher updates, and others -- always empty -- that routes read.
// globalThis is one true object per OS process regardless of which chunk
// loaded this file. See
// docs/superpowers/specs/2026-07-05-inbox-status-globalthis-singleton-design.md
declare global {
  // eslint-disable-next-line no-var
  var __ulpInFlight: Set<string> | undefined
  // eslint-disable-next-line no-var
  var __ulpPendingTasks: Set<string> | undefined
  // eslint-disable-next-line no-var
  var __ulpCurrentProgress: InboxJobProgress | null | undefined
}

/**
 * Filenames that have been submitted to uploadQueue (both pending and active).
 * Entries are added in enqueueFile() and removed in the task's finally block.
 *
 * This is the source of truth for "is this file already in pLimit?".
 * inFlight mirrors pendingTasks but is also used by reconcile() as a fast guard.
 *
 * The distinction matters for clearStaleInFlight():
 *   inFlight = filenames added by enqueueFile (may include true orphans)
 *   pendingTasks = filenames with live pLimit tasks (active OR queued)
 *
 * An entry in inFlight but NOT in pendingTasks is a true orphan
 * (enqueueFile was called but the task's finally never ran — should never
 * happen in normal operation but guards against future bugs).
 */
const inFlight     = globalThis.__ulpInFlight     ?? (globalThis.__ulpInFlight     = new Set<string>())
const pendingTasks = globalThis.__ulpPendingTasks ?? (globalThis.__ulpPendingTasks = new Set<string>())  // subset of inFlight — has live pLimit task

function getCurrentProgress(): InboxJobProgress | null {
  return globalThis.__ulpCurrentProgress ?? null
}

function setCurrentProgress(progress: InboxJobProgress | null): void {
  globalThis.__ulpCurrentProgress = progress
}

/** Returns live progress for the inbox file currently being processed, or null if idle. */
export function getInboxJobProgress(): InboxJobProgress | null {
  return getCurrentProgress()
}

/** Number of filenames currently marked as queued or in-progress. */
export function getInFlightCount(): number {
  return inFlight.size
}
```

- [ ] **Step 4: Update the remaining `_currentProgress` call sites**

In `clearStaleInFlight()`, replace:

```ts
export function clearStaleInFlight(): number {
  const current = _currentProgress?.filename ?? null
```

with:

```ts
export function clearStaleInFlight(): number {
  const current = getCurrentProgress()?.filename ?? null
```

In `enqueueFile()`'s `uploadQueue(async () => { ... })` callback, replace:

```ts
      console.log(`[inbox-watcher] processing: ${filename}`)
      // Capture file size (from the claimed path) for ETA in the status API.
      const fileSizeBytes = (() => { try { return fs.statSync(procPath!).size } catch { return 0 } })()
      _currentProgress = { filename, started_at: startAt, rows_imported: 0, file_size_bytes: fileSizeBytes }

      if (ext === '.zip') {
        await processZipFile(procPath, result => {
          imported += result.imported
          skipped  += result.skipped
          if (_currentProgress) _currentProgress.rows_imported = imported
          if (result.imported > 0) {
```

with:

```ts
      console.log(`[inbox-watcher] processing: ${filename}`)
      // Capture file size (from the claimed path) for ETA in the status API.
      const fileSizeBytes = (() => { try { return fs.statSync(procPath!).size } catch { return 0 } })()
      setCurrentProgress({ filename, started_at: startAt, rows_imported: 0, file_size_bytes: fileSizeBytes })

      if (ext === '.zip') {
        await processZipFile(procPath, result => {
          imported += result.imported
          skipped  += result.skipped
          const cp = getCurrentProgress()
          if (cp) cp.rows_imported = imported
          if (result.imported > 0) {
```

Then replace:

```ts
        const result     = await processTextStream(webStream, filename, undefined, n => {
          // onBatch: update live progress after each 500 K-row batch
          if (_currentProgress) _currentProgress.rows_imported = n
        })
```

with:

```ts
        const result     = await processTextStream(webStream, filename, undefined, n => {
          // onBatch: update live progress after each 500 K-row batch
          const cp = getCurrentProgress()
          if (cp) cp.rows_imported = n
        })
```

Then replace:

```ts
    } finally {
      _currentProgress = null
      pendingTasks.delete(filename)   // task is done (success or fail)
      inFlight.delete(filename)
      setCurrentJob(null)
    }
```

with:

```ts
    } finally {
      setCurrentProgress(null)
      pendingTasks.delete(filename)   // task is done (success or fail)
      inFlight.delete(filename)
      setCurrentJob(null)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/inbox-watcher-globalthis.test.ts __tests__/inbox-watcher-stability.test.ts __tests__/inbox-claim.test.ts`
Expected: PASS — all tests in all three files.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full test suite to confirm no other regressions**

Run: `npx vitest run`
Expected: all test files pass.

- [ ] **Step 8: Commit**

```bash
git add lib/inbox-watcher.ts __tests__/inbox-watcher-globalthis.test.ts
git commit -m "fix(inbox-watcher): anchor inFlight/pendingTasks/progress state to globalThis

Same root cause and fix as lib/upload-queue.ts: instrumentation.ts and the
API routes that read this state end up with independent module instances
in production, so the real watcher's progress was invisible to every route."
```

---

### Task 3: Rebuild, deploy, and live-verify the dashboard reports true state

**Files:** none (operational task — rebuilds the running app container)

**Interfaces:**
- Consumes: the committed code from Tasks 1-2.

This task proves the fix works against the actually-running app, the same way the bug was originally confirmed — a passing unit test cannot, by itself, prove cross-chunk sharing works, since Node's module cache doesn't reproduce webpack's bundle-splitting.

- [ ] **Step 1: Rebuild and restart the app container**

Run: `cd /home/cole/ulp-suite && docker compose build app && docker compose up -d app`
Expected: build succeeds; container restarts. ClickHouse is a separate container and is not affected.

- [ ] **Step 2: Confirm the app is back up**

Run: `docker ps --format '{{.Names}}\t{{.Status}}' | grep ulpsuite_app`
Expected: `ulpsuite_app` shows `Up ... (healthy)` (allow a few seconds after Step 1 if it initially shows `starting`).

- [ ] **Step 3: Authenticate and save a session cookie**

```bash
mkdir -p /tmp/ulp-verify-globalthis-singleton
ADMIN_EMAIL=$(grep -E '^ADMIN_EMAIL=' /home/cole/ulp-suite/.env | cut -d= -f2-)
ADMIN_PASSWORD=$(grep -E '^ADMIN_PASSWORD=' /home/cole/ulp-suite/.env | cut -d= -f2-)
curl -s -c /tmp/ulp-verify-globalthis-singleton/cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  -w "\nHTTP_STATUS:%{http_code}\n"
```

Expected: `"success":true` and `HTTP_STATUS:200`.

- [ ] **Step 4: Generate a synthetic file large enough to guarantee a multi-second processing window**

A tiny file imports in well under a second, too fast to reliably poll. Generate 500,000 unique rows (unique per-line domain/email/password so nothing collides with real or previous test data, and cleanup can target one exact domain suffix):

```bash
awk 'BEGIN{
  for (i = 1; i <= 500000; i++)
    print "http://globalthis-verify.invalid/login:verifyuser" i "@globalthis-verify.invalid:VerifyPass" i
}' > /home/cole/ulp-suite/inbox/zzz-globalthis-verify.txt
```

- [ ] **Step 5: Poll `/api/inbox/status` while the file is processing and confirm it reports true state**

```bash
FOUND=0
for i in $(seq 1 60); do
  RESP=$(curl -s -b /tmp/ulp-verify-globalthis-singleton/cookies.txt http://localhost:3000/api/inbox/status)
  CURRENT=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('current_file'))")
  if [ "$CURRENT" = "zzz-globalthis-verify.txt" ]; then
    echo "$RESP" | python3 -m json.tool
    FOUND=1
    break
  fi
  sleep 0.5
done
echo "FOUND=$FOUND"
```

Expected: `FOUND=1`, and the printed response shows `"watcher_active": true`, `"current_file": "zzz-globalthis-verify.txt"`, `"queue_depth"` >= 1, and `"current_progress"` is a populated object (not `null`) with `"filename": "zzz-globalthis-verify.txt"`.

If `FOUND=0` (timed out after 30s without ever seeing the file as current), STOP — the fix did not work. Do not proceed to Step 6 or Task 4; return to Task 1/2 and re-investigate (check the container logs for `[inbox-watcher]` lines, and re-check that the rebuilt image actually contains the Task 1/2 commits).

- [ ] **Step 6: Wait for completion and verify the exact imported count**

```bash
until [ ! -f /home/cole/ulp-suite/inbox/zzz-globalthis-verify.txt ]; do sleep 1; done
docker exec ulpsuite_app node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/ulp.db', { readonly: true });
console.log(JSON.stringify(db.prepare(\"SELECT filename, imported, skipped FROM processing_jobs WHERE filename = 'zzz-globalthis-verify.txt' ORDER BY id DESC LIMIT 1\").all()));
"
```

Expected: `imported: 500000, skipped: 0`.

- [ ] **Step 7: Confirm the dashboard is idle again now that nothing is processing**

```bash
curl -s -b /tmp/ulp-verify-globalthis-singleton/cookies.txt http://localhost:3000/api/inbox/status | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('watcher_active:', d['watcher_active'], 'current_file:', d['current_file'], 'queue_depth:', d['queue_depth'])
"
```

Expected: `watcher_active: False current_file: None queue_depth: 0` — confirming the fix correctly reports BOTH states (busy while processing, idle once done), not just permanently "active."

- [ ] **Step 8: Clean up the verification test row and file**

```bash
echo "ALTER TABLE ulp.credentials DELETE WHERE domain = 'globalthis-verify.invalid' SETTINGS mutations_sync = 1" | docker exec -i ulpsuite_clickhouse clickhouse-client
rm -f /home/cole/ulp-suite/inbox/done/zzz-globalthis-verify.txt
```

If Step 6's count was not exactly `500000, skipped: 0`, STOP — do not proceed to Task 4. Re-investigate rather than continuing to build on an unconfirmed fix.

---

### Task 4: Verify the manual upload path and inbox watcher now share one true queue

**Files:** none (operational task — exercises the running app's HTTP upload endpoint)

**Interfaces:**
- Consumes: a confirmed-working Task 3. Do not start this task if Task 3's Step 5 `FOUND` was `0` or Step 6's count was wrong.

This closes the higher-severity concern from the design doc: before this fix, `app/api/upload/route.ts` and the inbox watcher may have been running through two independent `pLimit(1)` queues instead of one shared queue, meaning a manual upload could run concurrently with an inbox-dropped file — the exact memory-competition scenario the shared queue exists to prevent.

- [ ] **Step 1: Generate a second large synthetic file (different domain, so cleanup stays precise) and drop it into the inbox**

```bash
awk 'BEGIN{
  for (i = 1; i <= 500000; i++)
    print "http://globalthis-verify-b.invalid/login:verifyuserb" i "@globalthis-verify-b.invalid:VerifyPassB" i
}' > /home/cole/ulp-suite/inbox/zzz-globalthis-verify-b.txt
```

- [ ] **Step 2: Wait until it is confirmed actively processing**

```bash
for i in $(seq 1 60); do
  CURRENT=$(curl -s -b /tmp/ulp-verify-globalthis-singleton/cookies.txt http://localhost:3000/api/inbox/status | python3 -c "import json,sys; print(json.load(sys.stdin).get('current_file'))")
  [ "$CURRENT" = "zzz-globalthis-verify-b.txt" ] && break
  sleep 0.5
done
echo "current before manual upload: $CURRENT"
```

Expected: `current before manual upload: zzz-globalthis-verify-b.txt`. If this doesn't match, STOP and re-investigate before continuing — the rest of this task depends on file B being genuinely in-flight.

- [ ] **Step 3: While file B is processing, submit a small manual upload via the HTTP endpoint and record its ClickHouse-visible start time**

```bash
printf 'http://globalthis-verify-manual.invalid/login:verifyusermanual1@globalthis-verify-manual.invalid:VerifyPassManual1\n' \
  > /tmp/ulp-verify-globalthis-singleton/zzz-globalthis-verify-manual.txt

date +%s.%N > /tmp/ulp-verify-globalthis-singleton/manual-upload-start.txt
curl -s -b /tmp/ulp-verify-globalthis-singleton/cookies.txt \
  -F "file=@/tmp/ulp-verify-globalthis-singleton/zzz-globalthis-verify-manual.txt;filename=zzz-globalthis-verify-manual.txt" \
  http://localhost:3000/api/upload -w "\nHTTP_STATUS:%{http_code}\n"
date +%s.%N > /tmp/ulp-verify-globalthis-singleton/manual-upload-end.txt
```

Expected: `HTTP_STATUS:200` (the upload request itself completes — `uploadQueue` internally awaits its turn before this response returns, so a long wait here is itself a signal, not a failure).

- [ ] **Step 4: Confirm the two imports never ran concurrently**

While Step 3 was running, file B (500,000 rows) should still have been mid-import if the queue is correctly shared — meaning the manual upload's own request had to wait for file B to finish before its single row could be inserted and the request could return. Confirm this via ClickHouse's query log, checking that the manual upload's insert started only after file B's job finished:

```bash
docker exec ulpsuite_app node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/ulp.db', { readonly: true });
console.log(JSON.stringify(db.prepare(\"SELECT filename, imported, skipped, created_at FROM processing_jobs WHERE filename IN ('zzz-globalthis-verify-b.txt', 'zzz-globalthis-verify-manual.txt') ORDER BY id ASC\").all()));
"
```

Expected: two rows. `zzz-globalthis-verify-b.txt` shows `imported: 500000, skipped: 0`. `zzz-globalthis-verify-manual.txt` shows `imported: 1, skipped: 0`, with a `created_at` at or after file B's — confirming it was queued behind file B, not run concurrently. (If the manual upload's `created_at` is well before file B finished, or if `HTTP_STATUS` in Step 3 returned near-instantly while file B was still mid-import per Step 2's polling, that indicates the two are still on separate queues — STOP and re-investigate Task 1 rather than proceeding.)

- [ ] **Step 5: Clean up all verification data**

```bash
docker exec -i ulpsuite_clickhouse clickhouse-client --query "ALTER TABLE ulp.credentials DELETE WHERE domain IN ('globalthis-verify-b.invalid', 'globalthis-verify-manual.invalid') SETTINGS mutations_sync = 1"
rm -f /home/cole/ulp-suite/inbox/done/zzz-globalthis-verify-b.txt
rm -f /tmp/ulp-verify-globalthis-singleton/zzz-globalthis-verify-manual.txt
rm -rf /tmp/ulp-verify-globalthis-singleton
```

Note: the manually-uploaded file is not written to `inbox/done/` at all — the HTTP upload route processes directly from the request body and never touches the `inbox/` directory, so there's no leftover file for it beyond the temp copy already cleaned up above.
