# Inbox Watcher Write-Stability Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the inbox watcher from claiming and reading a file before an external writer (e.g. `cp` of a large file) has finished writing it, which currently causes silent 0-row "successful" imports with no error — then recover the specific files already lost to this bug.

**Architecture:** A new `isFileSizeStable()` primitive in `lib/inbox-claim.ts` checks whether a file's size has stopped changing over a short wait. `enqueueFile()` in `lib/inbox-watcher.ts` — the single function both the chokidar `'add'` handler and the independent `reconcile()` loop call — is changed to call this check before claiming a file, so both paths are protected from the same shared enforcement point.

**Tech Stack:** TypeScript, Vitest (real temp directories for `lib/inbox-claim.ts`, matching its existing test style), Node.js `fs`, Docker/docker-compose for the running app.

## Global Constraints

- `ulp.credentials` must only be modified via the normal inbox-processing pipeline (dropping files, letting the watcher import them) — never via a manual `INSERT`/`ALTER`, including for the data-recovery task.
- The 5 already-affected files (`@ARCEUSULP #89` through `#93`) must not be re-queued until the live fix is verified working (Task 3) — re-queuing before that risks repeating the exact same silent failure.
- Named constants only for new tunables (matching this session's established convention) — no inline magic numbers.
- `lib/inbox-claim.ts` tests use a real temp directory (`fs.mkdtempSync`), not mocked `fs` — matching this file's existing test style in `__tests__/inbox-claim.test.ts`.
- Reference spec: `docs/superpowers/specs/2026-07-05-inbox-watcher-write-stability-design.md`.

---

### Task 1: `isFileSizeStable()` primitive

**Files:**
- Modify: `lib/inbox-claim.ts`
- Modify: `__tests__/inbox-claim.test.ts`

**Interfaces:**
- Produces: `isFileSizeStable(filePath: string, waitMs: number): Promise<boolean>` — exported from `lib/inbox-claim.ts`.

- [ ] **Step 1: Write the failing tests**

Add `isFileSizeStable` to the existing import at the top of `__tests__/inbox-claim.test.ts`:

```ts
import { claimFileForProcessing, sweepProcessingToFailed, isFileSizeStable } from '@/lib/inbox-claim'
```

Append this new `describe` block at the end of the file (after the existing `sweepProcessingToFailed` block, inside the same file, using the file's existing `tmp` variable from its `beforeEach`/`afterEach`):

```ts
describe('isFileSizeStable', () => {
  test('returns true when the file size is unchanged across the wait', async () => {
    const file = path.join(tmp, 'stable.txt')
    fs.writeFileSync(file, 'complete content')
    expect(await isFileSizeStable(file, 10)).toBe(true)
  })

  test('returns false when the file grows during the wait', async () => {
    const file = path.join(tmp, 'growing.txt')
    fs.writeFileSync(file, 'partial')
    setTimeout(() => fs.appendFileSync(file, ' more data'), 5)
    expect(await isFileSizeStable(file, 20)).toBe(false)
  })

  test('returns false when the file is removed during the wait', async () => {
    const file = path.join(tmp, 'vanishing.txt')
    fs.writeFileSync(file, 'data')
    setTimeout(() => fs.unlinkSync(file), 5)
    expect(await isFileSizeStable(file, 20)).toBe(false)
  })

  test('returns false when the file does not exist at all', async () => {
    expect(await isFileSizeStable(path.join(tmp, 'missing.txt'), 10)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/inbox-claim.test.ts`
Expected: FAIL — `isFileSizeStable` is not exported from `lib/inbox-claim.ts` yet (import error).

- [ ] **Step 3: Implement `isFileSizeStable`**

Append to `lib/inbox-claim.ts` (after `sweepProcessingToFailed`'s closing brace):

```ts
/**
 * Checks whether a file's size has stopped changing over `waitMs`, as a proxy
 * for "an external writer (e.g. cp of a large file) has finished." A file
 * still being written has a size that changes between the two checks; a
 * fully-written file's size stays the same. Returns false (not stable) if the
 * file vanishes between checks — treated the same as "still changing," not as
 * an error: the caller should skip this attempt, not throw.
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/inbox-claim.test.ts`
Expected: PASS — all tests in the file green, including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add lib/inbox-claim.ts __tests__/inbox-claim.test.ts
git commit -m "feat(inbox-claim): add isFileSizeStable to detect files still being written

A file still being written by an external process (e.g. cp of a large file)
has a size that keeps changing. This checks size, waits, checks again —
used by the inbox watcher before claiming a file, so it never reads one
mid-write."
```

---

### Task 2: Integrate the stability check into the watcher

**Files:**
- Modify: `lib/inbox-watcher.ts`

**Interfaces:**
- Consumes: `isFileSizeStable(filePath: string, waitMs: number): Promise<boolean>` from Task 1.
- Produces: `enqueueFile` becomes `async function enqueueFile(filePath: string): Promise<void>` (still not exported — same visibility as before).

- [ ] **Step 1: Write the failing test**

Create `__tests__/inbox-watcher-stability.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher — stability check wiring (mid-write read race)', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports isFileSizeStable from lib/inbox-claim', () => {
    expect(source).toContain('isFileSizeStable')
    expect(source).toMatch(/import\s*\{[^}]*isFileSizeStable[^}]*\}\s*from\s*['"]@\/lib\/inbox-claim['"]/)
  })

  test('defines a named wait-duration constant, not an inline magic number', () => {
    expect(source).toMatch(/const STABILITY_CHECK_WAIT_MS\s*=\s*1_000/)
  })

  test('enqueueFile is async and checks stability before marking a file inFlight', () => {
    const fnStart = source.indexOf('async function enqueueFile')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = source.indexOf('\n}', source.indexOf('uploadQueue(async'))
    const fn = source.slice(fnStart, fnEnd)

    const stabilityCallIdx = fn.indexOf('isFileSizeStable(')
    const inFlightAddIdx   = fn.indexOf('inFlight.add(filename)')
    expect(stabilityCallIdx).toBeGreaterThan(-1)
    expect(inFlightAddIdx).toBeGreaterThan(-1)
    expect(stabilityCallIdx).toBeLessThan(inFlightAddIdx)
  })

  test('reconcile() and forceReconcile() do not block on enqueueFile — fire-and-forget with void', () => {
    const reconcileFn = source.slice(source.indexOf('function reconcile('), source.indexOf('function reconcile(') + 700)
    const forceReconcileFn = source.slice(source.indexOf('export function forceReconcile'), source.indexOf('export function forceReconcile') + 700)
    expect(reconcileFn).toContain('void enqueueFile(filePath)')
    expect(forceReconcileFn).toContain('void enqueueFile(filePath)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/inbox-watcher-stability.test.ts`
Expected: FAIL — `isFileSizeStable` is not imported yet, `STABILITY_CHECK_WAIT_MS` doesn't exist, `enqueueFile` is not yet `async`, and neither `reconcile()` nor `forceReconcile()` call `void enqueueFile(...)` yet.

- [ ] **Step 3: Implement the changes in `lib/inbox-watcher.ts`**

Change the import line:

```ts
import { claimFileForProcessing, sweepProcessingToFailed } from '@/lib/inbox-claim'
```

to:

```ts
import { claimFileForProcessing, sweepProcessingToFailed, isFileSizeStable } from '@/lib/inbox-claim'
```

Change:

```ts
const DONE_MAX_AGE_MS       = 7 * 24 * 60 * 60 * 1_000   // 7 days
const RECONCILE_INTERVAL_MS = 30_000                       // scan for missed files every 30 s
```

to:

```ts
const DONE_MAX_AGE_MS         = 7 * 24 * 60 * 60 * 1_000   // 7 days
const RECONCILE_INTERVAL_MS   = 30_000                       // scan for missed files every 30 s
const STABILITY_CHECK_WAIT_MS = 1_000                        // gap between size checks before claiming a file
```

Change:

```ts
function enqueueFile(filePath: string): void {
```

to:

```ts
async function enqueueFile(filePath: string): Promise<void> {
```

Change:

```ts
  if (inFlight.has(filename))       return   // already queued or processing
  // Use path separator guards so 'done_batch.txt' is NOT excluded:
  if (filePath.startsWith(DONE_PREFIX) || filePath.startsWith(FAIL_PREFIX) || filePath.startsWith(PROC_PREFIX)) return

  inFlight.add(filename)
```

to:

```ts
  if (inFlight.has(filename))       return   // already queued or processing
  // Use path separator guards so 'done_batch.txt' is NOT excluded:
  if (filePath.startsWith(DONE_PREFIX) || filePath.startsWith(FAIL_PREFIX) || filePath.startsWith(PROC_PREFIX)) return

  // Guard against claiming a file an external process (e.g. `cp` of a large
  // file) is still writing. fs.createReadStream hits EOF at the file's
  // CURRENT size, not its eventual size, so reading a partially-written file
  // silently "succeeds" with 0 or a handful of rows and no error. If the size
  // is still changing, skip this attempt without marking inFlight — the file
  // stays untouched in inbox/, so the next chokidar poll (~2s) or reconcile
  // pass (~30s) checks again with fresh stat calls. An arbitrarily slow
  // writer resolves correctly over time; no new timeout/retry-count logic
  // needed, since this reuses the existing polling cadence.
  if (!(await isFileSizeStable(filePath, STABILITY_CHECK_WAIT_MS))) return

  inFlight.add(filename)
```

In `reconcile()`, change:

```ts
      if (!inFlight.has(entry.name)) {
        enqueueFile(filePath)
        queued++
      }
```

to:

```ts
      if (!inFlight.has(entry.name)) {
        void enqueueFile(filePath)
        queued++
      }
```

In `forceReconcile()`, change the identical pattern:

```ts
      if (!inFlight.has(entry.name)) {
        enqueueFile(filePath)
        queued++
      }
```

to:

```ts
      if (!inFlight.has(entry.name)) {
        void enqueueFile(filePath)
        queued++
      }
```

The chokidar `.on('add', enqueueFile)` line needs **no change** — an `EventEmitter` listener's return value is never awaited by the emitter regardless of whether the listener is async, so this is already fire-and-forget.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/inbox-watcher-stability.test.ts`
Expected: PASS — all four tests green.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: same pass count as before plus the four new tests; no new failures (this repo has a pre-existing intermittent SQLite `users.email` ownership failure in `upload-processor.test.ts`/`upload-skip-imported.test.ts` unrelated to this change).

Run: `npx tsc --noEmit`
Expected: exit code 0, no output.

- [ ] **Step 6: Commit**

```bash
git add lib/inbox-watcher.ts __tests__/inbox-watcher-stability.test.ts
git commit -m "fix(inbox-watcher): don't claim a file until its size has stopped changing

enqueueFile() claimed and read files the instant they existed in inbox/,
with no check that an external writer (e.g. cp of a large file) had
finished. fs.createReadStream hits EOF at the file's current size, so a
file caught mid-write silently 'succeeds' with 0 rows and no error.

Adds a stability check (isFileSizeStable) before claiming, enforced once
in enqueueFile() so both the chokidar 'add' handler and the independent
reconcile() loop are protected from the same shared point. reconcile()
and forceReconcile() no longer block on enqueueFile so multiple files'
checks run concurrently."
```

---

### Task 3: Rebuild, deploy, and live-verify the fix

**Files:** none (operational task — rebuilds the running app container)

**Interfaces:**
- Consumes: the committed code from Tasks 1-2.

This task deploys the fix to the actually-running app and proves it works against a real slow write, the same way the bug was originally confirmed — not just via unit tests.

- [ ] **Step 1: Rebuild and restart the app container**

Run: `cd /home/cole/ulp-suite && docker compose build app && docker compose up -d app`
Expected: build succeeds; container restarts. ClickHouse is a separate container and is not affected.

- [ ] **Step 2: Confirm the app is back up**

Run: `docker ps --format '{{.Names}}\t{{.Status}}' | grep ulpsuite_app`
Expected: `ulpsuite_app` shows `Up ... (healthy)` (allow a few seconds after Step 1 if it initially shows `starting`).

- [ ] **Step 3: Reproduce the original race live — confirm it's now fixed**

Write a file into the live inbox slowly, the same way the bug was originally confirmed, then wait for it to be claimed:

```bash
(
  for i in $(seq 1 20); do
    printf 'http://stability-fix-verify-%d.invalid/login:verifyuser%d@stability-fix-verify.invalid:VerifyPass%d\n' "$i" "$i" "$i"
    sleep 0.5
  done
) > /home/cole/ulp-suite/inbox/zzz-stability-fix-verify.txt
```

- [ ] **Step 4: Wait for it to be claimed and processed, then verify the row count**

```bash
until [ ! -f /home/cole/ulp-suite/inbox/zzz-stability-fix-verify.txt ]; do sleep 1; done
find /home/cole/ulp-suite/inbox -iname "*stability-fix-verify*"
```

Expected: the file appears in `inbox/done/zzz-stability-fix-verify.txt` (not claimed and completed within the first second or two this time — the stability check should make it wait until the write is actually finished before claiming).

```bash
echo "SELECT count() FROM ulp.credentials WHERE domain = 'stability-fix-verify.invalid'" | docker exec -i ulpsuite_clickhouse clickhouse-client
```

Expected: `20` — all 20 lines imported, not 0. This is the direct confirmation the fix works: before the fix, an identical test (`zzz-race-condition-test.txt`, same shape, same timing) produced `0`.

- [ ] **Step 5: Clean up the verification test row and file**

```bash
echo "ALTER TABLE ulp.credentials DELETE WHERE domain = 'stability-fix-verify.invalid' SETTINGS mutations_sync = 1" | docker exec -i ulpsuite_clickhouse clickhouse-client
rm -f /home/cole/ulp-suite/inbox/done/zzz-stability-fix-verify.txt
```

If Step 4's count is not `20`, STOP — do not proceed to Task 4. Return to Task 1/2 and re-investigate rather than recovering real data on top of an unconfirmed fix.

---

### Task 4: Recover the 5 affected files

**Files:** none (operational task — moves specific files, verifies against ClickHouse)

**Interfaces:**
- Consumes: a confirmed-working fix from Task 3. Do not start this task if Task 3's Step 4 count was not `20`.

- [ ] **Step 1: Confirm the affected files are exactly where expected**

```bash
docker exec ulpsuite_app sh -c "ls -la /app/inbox/done/ | grep ARCEUSULP"
```

Expected: `@ARCEUSULP #89 (16,491) .txt`, `#90 (716,229)`, `#91 (1,288,598)`, `#92 (465,679)`, `#93 (244,967)` all present in `done/`.

- [ ] **Step 2: Confirm current (pre-recovery) row counts for these files are 0**

```bash
docker exec -i ulpsuite_clickhouse clickhouse-client --query "
SELECT filename, line_count FROM ulp.sources
WHERE filename IN ('@ARCEUSULP #89 (16,491) .txt', '@ARCEUSULP #90 (716,229) .txt', '@ARCEUSULP #91 (1,288,598) .txt', '@ARCEUSULP #92 (465,679) .txt', '@ARCEUSULP #93 (244,967) .txt')"
```

Expected: no rows returned (these filenames should not be in `ulp.sources` at all yet, since the 0-row "import" never actually recorded a source — confirming they're safe to reprocess without tripping the durable re-upload guard).

- [ ] **Step 3: Move the 5 files back into inbox/ one at a time, waiting for each to finish before starting the next**

Moving all 5 at once would queue them together, which is fine functionally (they process one at a time regardless, via the existing `pLimit(1)` queue) but makes it harder to attribute a wrong row count to a specific file if something goes wrong. Do them one at a time:

These are real breach files with heterogeneous domains, not a single test domain, so verify each one's actual imported row count via `processing_jobs` (not a domain filter):

```bash
docker exec ulpsuite_app sh -c "mv '/app/inbox/done/@ARCEUSULP #89 (16,491) .txt' '/app/inbox/@ARCEUSULP #89 (16,491) .txt'"
until [ "$(docker exec ulpsuite_app sh -c "ls /app/inbox/ 2>/dev/null | grep -c 'ARCEUSULP #89'")" = "0" ]; do sleep 2; done
docker exec ulpsuite_app sh -c "sqlite3 /app/data/ulp.db \"SELECT filename, imported, skipped, duration_ms FROM processing_jobs WHERE filename LIKE '%ARCEUSULP #89%' ORDER BY id DESC LIMIT 1\""
```

Expected: `imported` is close to `16,491` (the count in the filename; exact match isn't guaranteed if the file legitimately contains a few malformed/rejected lines, but it should be in the same range, not `0`).

Repeat the same move-wait-verify sequence for `#90`, `#91`, `#92`, and `#93`, substituting each filename and its expected count (`716,229`, `1,288,598`, `465,679`, `244,967` respectively) in the `processing_jobs` check.

- [ ] **Step 4: Final confirmation**

```bash
docker exec ulpsuite_app sh -c "sqlite3 /app/data/ulp.db \"SELECT filename, imported, skipped FROM processing_jobs WHERE filename LIKE '%ARCEUSULP #8%' OR filename LIKE '%ARCEUSULP #9%' ORDER BY id DESC LIMIT 10\""
```

Expected: all 5 files show `imported` counts in the same range as their filenames' implied counts, none showing `0`.

No commit for this task — it's a data-recovery action, not a code change.
