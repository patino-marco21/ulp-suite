# SQLite Test Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm test`/`npx vitest run` work cleanly in the main checkout without the manual `SQLITE_PATH=<path>` workaround, and eliminate the fresh-worktree first-boot admin-seed race, by giving every Vitest worker its own isolated SQLite database file instead of falling back to the real `./data/ulp.db`.

**Architecture:** A Vitest `globalSetup` module builds one template database (via `lib/sqlite.ts`'s existing, already race-safe `ensureDb()`) once per run, in the OS temp directory. A `setupFiles` module, running inside each worker before any test file, atomically copies that template to a worker-specific path and sets `process.env.SQLITE_PATH` before anything imports `lib/sqlite.ts`. `lib/sqlite.ts` itself is not modified — its production fallback to `./data/ulp.db` stays exactly as-is.

**Tech Stack:** Vitest 4 (`globalSetup`, `setupFiles`, `VITEST_POOL_ID`), better-sqlite3, Node `fs`/`os`/`path`.

## Global Constraints

- Do not modify `lib/sqlite.ts`'s `DB_PATH` fallback logic (line 7) — production behavior must be unchanged.
- The per-worker copy must be race-safe even if multiple workers end up computing the same destination path (e.g. if `VITEST_POOL_ID` is ever unavailable) — use an atomic copy-then-rename, not a check-then-copy.
- The copy must be idempotent within a worker's lifetime — if `setupFiles` re-executes for a later test file in the same worker, it must NOT overwrite an already-established per-worker database (that would silently reset state between test files in ways the current single-shared-path workaround never did).
- `globalSetup`'s teardown must remove the template and every worker-copy file (including `-wal`/`-shm` sidecars) — don't leave scratch files behind after a run.
- After this change, `.github/workflows/ci.yml`'s job-level `SQLITE_PATH: /tmp/ci-test.db` becomes redundant (every worker sets its own) — remove it so there's only one mechanism, not two.

---

### Task 1: Worker DB path helper (pure function, TDD)

**Files:**
- Create: `__tests__/setup/worker-db-path.ts`
- Test: `__tests__/setup/worker-db-path.test.ts`

**Interfaces:**
- Produces: `getWorkerDbPath(poolId: string | undefined, tmpDir: string): string` — used by Task 3's `setupFiles` module.

- [ ] **Step 1: Write the failing test**

Create `__tests__/setup/worker-db-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import path from 'path'
import { getWorkerDbPath } from './worker-db-path'

describe('getWorkerDbPath', () => {
  it('includes the pool id in the filename', () => {
    const p = getWorkerDbPath('3', '/tmp')
    expect(p).toBe(path.join('/tmp', 'ulp-suite-vitest-worker-3.db'))
  })

  it('produces different paths for different pool ids', () => {
    const a = getWorkerDbPath('1', '/tmp')
    const b = getWorkerDbPath('2', '/tmp')
    expect(a).not.toBe(b)
  })

  it('falls back to a fixed id when poolId is undefined', () => {
    const p = getWorkerDbPath(undefined, '/tmp')
    expect(p).toBe(path.join('/tmp', 'ulp-suite-vitest-worker-0.db'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/setup/worker-db-path.test.ts`
Expected: FAIL — `Cannot find module './worker-db-path'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `__tests__/setup/worker-db-path.ts`:

```ts
import path from 'path'

/**
 * Deterministic per-worker SQLite DB path. Falls back to a fixed id ('0')
 * if VITEST_POOL_ID isn't available, in which case every worker computes
 * the SAME path — the caller (sqlite-worker-setup.ts) is responsible for
 * making the copy-into-that-path step safe under that degraded case too.
 */
export function getWorkerDbPath(poolId: string | undefined, tmpDir: string): string {
  return path.join(tmpDir, `ulp-suite-vitest-worker-${poolId ?? '0'}.db`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/setup/worker-db-path.test.ts`
Expected: PASS, 3/3 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/setup/worker-db-path.ts __tests__/setup/worker-db-path.test.ts
git commit -m "test(vitest): add pure per-worker DB path helper"
```

---

### Task 2: Global setup — build the template database once

**Files:**
- Create: `__tests__/setup/sqlite-global-setup.ts`

**Interfaces:**
- Consumes: `lib/sqlite.ts`'s `ensureDb()` and `dbExec()` (both already exported).
- Produces: a template DB file at `path.join(os.tmpdir(), 'ulp-suite-vitest-template.db')` — this exact path is also hardcoded in Task 3's `sqlite-worker-setup.ts`, since `globalSetup` and `setupFiles` run in separate processes and can't pass data to each other except through an agreed-upon filesystem location.

- [ ] **Step 1: Write the global setup module**

Create `__tests__/setup/sqlite-global-setup.ts`:

```ts
import fs from 'fs'
import os from 'os'
import path from 'path'

export const TEMPLATE_DB_PATH = path.join(os.tmpdir(), 'ulp-suite-vitest-template.db')

export default async function setup() {
  // Must be set before lib/sqlite.ts is imported — it reads SQLITE_PATH
  // once, at module-evaluation time, into a top-level const.
  process.env.SQLITE_PATH = TEMPLATE_DB_PATH

  // Fresh template every run — don't accumulate state across separate
  // `npx vitest run` invocations.
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEMPLATE_DB_PATH + suffix, { force: true })
  }

  const { ensureDb, dbExec } = await import('../../lib/sqlite')
  ensureDb() // runs the full, already race-safe initSchema + seedDefaultAdmin

  // Merge WAL into the main file and empty it, so a plain single-file copy
  // in sqlite-worker-setup.ts captures complete state without also needing
  // to copy -wal/-shm sidecars for the template itself.
  dbExec('PRAGMA wal_checkpoint(TRUNCATE)')

  return async function teardown() {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(TEMPLATE_DB_PATH + suffix, { force: true })
    }
    // Clean up every per-worker copy Task 3 may have created, in case an
    // individual worker's own cleanup (if any) didn't run — e.g. a worker
    // that crashed mid-run.
    const tmpDir = os.tmpdir()
    for (const name of fs.readdirSync(tmpDir)) {
      if (name.startsWith('ulp-suite-vitest-worker-')) {
        fs.rmSync(path.join(tmpDir, name), { force: true })
      }
    }
  }
}
```

- [ ] **Step 2: Wire it into vitest.config.ts (temporarily, to test in isolation)**

This gets combined with Task 3's `setupFiles` wiring in Task 4's config edit — for now, verify this module alone works by running it directly:

```bash
npx tsx -e "
import('./__tests__/setup/sqlite-global-setup.ts').then(async (m) => {
  const teardown = await m.default()
  console.log('Template created:', require('fs').existsSync(m.TEMPLATE_DB_PATH))
  await teardown()
  console.log('Template removed:', !require('fs').existsSync(m.TEMPLATE_DB_PATH))
})
"
```

Expected: `Template created: true` then `Template removed: true`. (If `tsx` isn't available, run the equivalent via `node --loader ts-node/esm` or skip this standalone check and verify via Task 4's full-suite run instead — this step is a convenience check, not a hard requirement.)

- [ ] **Step 3: Commit**

```bash
git add __tests__/setup/sqlite-global-setup.ts
git commit -m "test(vitest): add global setup building one template SQLite DB per run"
```

---

### Task 3: Per-worker setup — atomic copy + env wiring

**Files:**
- Create: `__tests__/setup/sqlite-worker-setup.ts`

**Interfaces:**
- Consumes: `getWorkerDbPath` from Task 1, `TEMPLATE_DB_PATH` from Task 2.
- Produces: `process.env.SQLITE_PATH` set to a worker-specific path before any test file in this worker runs.

- [ ] **Step 1: Write the worker setup module**

Create `__tests__/setup/sqlite-worker-setup.ts`:

```ts
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { getWorkerDbPath } from './worker-db-path'
import { TEMPLATE_DB_PATH } from './sqlite-global-setup'

const workerDbPath = getWorkerDbPath(process.env.VITEST_POOL_ID, os.tmpdir())

if (!fs.existsSync(workerDbPath)) {
  // Copy to a uniquely-named temp file, then rename into place. rename() is
  // atomic on POSIX within the same filesystem, so even if two workers race
  // here (e.g. VITEST_POOL_ID unavailable and both compute the same path),
  // the loser's rename just overwrites with an equally-valid fresh copy of
  // the same template — never a half-written file.
  const scratch = `${workerDbPath}.tmp-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.copyFileSync(TEMPLATE_DB_PATH, scratch)
    fs.renameSync(scratch, workerDbPath)
  } catch (err) {
    fs.rmSync(scratch, { force: true })
    throw err
  }
}

// Idempotent to repeat across multiple test files in the same worker —
// intentionally does NOT re-copy if workerDbPath already exists, so state
// written by earlier test files in this worker persists for later ones,
// matching today's existing single-shared-path workaround's behavior.
process.env.SQLITE_PATH = workerDbPath
```

- [ ] **Step 2: Commit**

```bash
git add __tests__/setup/sqlite-worker-setup.ts
git commit -m "test(vitest): add per-worker atomic SQLite DB copy + SQLITE_PATH wiring"
```

(Verified together with Task 2 via Task 4's full-suite run — these two files only do something meaningful wired into `vitest.config.ts`.)

---

### Task 4: Wire into vitest.config.ts and verify end-to-end

**Files:**
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `sqlite-global-setup.ts` (Task 2), `sqlite-worker-setup.ts` (Task 3).

- [ ] **Step 1: Add globalSetup and setupFiles to vitest.config.ts**

Change `vitest.config.ts` from:

```ts
  test: {
    environment: 'node',
    globals: true,
    // Print a summary line even for passing tests
    reporter: ['verbose'],
    // Don't collect tests from nested git worktrees — the legacy manual-fallback
    // location (.worktrees/hard-drop-t3/) and the native EnterWorktree tool's
    // location (.claude/worktrees/<name>/) both nest a full checkout (including
    // __tests__/) inside this repo; their copies otherwise surface as duplicate
    // runs / false failures in the main suite.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/.claude/worktrees/**'],
```

to:

```ts
  test: {
    environment: 'node',
    globals: true,
    // Print a summary line even for passing tests
    reporter: ['verbose'],
    // Don't collect tests from nested git worktrees — the legacy manual-fallback
    // location (.worktrees/hard-drop-t3/) and the native EnterWorktree tool's
    // location (.claude/worktrees/<name>/) both nest a full checkout (including
    // __tests__/) inside this repo; their copies otherwise surface as duplicate
    // runs / false failures in the main suite.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/.claude/worktrees/**'],
    // Isolated per-worker SQLite DB — see docs/superpowers/specs/2026-09-24-scale-audit-followups-design.md.
    // Without this, tests fall back to ./data/ulp.db: unwritable in the main
    // checkout (SQLITE_READONLY), and racy on first-admin-seed in a fresh
    // writable checkout.
    globalSetup: ['./__tests__/setup/sqlite-global-setup.ts'],
    setupFiles: ['./__tests__/setup/sqlite-worker-setup.ts'],
```

- [ ] **Step 2: Run the full suite in the main checkout with NO manual SQLITE_PATH**

```bash
npx vitest run
```

Expected: all test files pass (73+ files, 1106+ tests — exact count may have grown since 2026-08-26), with **no** `SQLITE_READONLY` failures and **no** `UNIQUE constraint failed: users.email` failures, and critically, **without** prefixing the command with `SQLITE_PATH=...` for the first time since this symptom was first documented.

- [ ] **Step 3: Run it a second time immediately after, to check for leftover-state issues**

```bash
npx vitest run
```

Expected: same result as Step 2 — confirms the idempotent-copy logic and fresh-template-per-run logic in Task 2/3 don't leave the second run in a broken state.

- [ ] **Step 4: Simplify CI's now-redundant manual SQLITE_PATH**

In `.github/workflows/ci.yml`, remove the job-level env block:

```yaml
    env:
      SQLITE_PATH: /tmp/ci-test.db
```

(Every worker now sets its own `SQLITE_PATH` via `setupFiles`, so this manual override is no longer needed — and leaving it in place would just mean every worker's `setupFiles` sees a `SQLITE_PATH` already set by the job... which is harmless since `globalSetup` overwrites it before `ensureDb()` runs and each worker's `setupFiles` overwrites it again — but removing it keeps there being exactly one mechanism instead of two doing the same job.)

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts .github/workflows/ci.yml
git commit -m "fix(test): isolate SQLite test DB per Vitest worker

Fixes the two symptoms documented since 2026-08-16: SQLITE_READONLY in
the main checkout (tests no longer touch ./data/ulp.db at all) and the
first-admin-seed race in a fresh writable checkout (each worker gets
its own DB file, nothing concurrent). No more SQLITE_PATH=<path>
prefix needed for a clean local run.

Also drops CI's now-redundant job-level SQLITE_PATH override — every
worker sets its own via setupFiles."
```

- [ ] **Step 6: Push and confirm CI passes on the new mechanism**

```bash
git push origin main
gh run watch --exit-status
```

Expected: CI green, confirming the isolation mechanism works on GitHub-hosted runners too, not just locally.
