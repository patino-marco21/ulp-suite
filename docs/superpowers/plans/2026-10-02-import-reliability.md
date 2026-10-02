# Import Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An upload can never wedge the import queue. The HTTP routes receive the whole file to disk before answering and import from that file; every import runs under a stall watchdog that frees its queue slot; transient ClickHouse errors that abort an import today are retried; every upload is attributed in the audit log.

**Architecture:** A new `lib/upload-spool.ts` writes a request body to a spool file (honouring the client's disconnect, the size cap, a Content-Length cross-check and a free-space floor). A new `lib/import-runner.ts` wraps every import job (HTTP, v1 API, inbox) in an abort controller plus a heartbeat watchdog on the monotonic clock, and releases the queue slot even if the work never settles. The importer (`lib/upload-processor.ts`) takes an abort signal and a heartbeat callback and gains `processTextFile`, the one way a file on disk is imported (the inbox already did this by hand). The two upload routes and the inbox watcher are rewired onto these pieces; the Upload page switches to `XMLHttpRequest` so it can show transfer progress before the import starts.

**Tech Stack:** Next.js 15.5 route handlers (Node runtime), Node 24 streams, p-limit queue, `@clickhouse/client`, better-sqlite3 audit log, Vitest 4 (`environment: 'node'`), tsx e2e scripts against the isolated rehearsal stack (`docker-compose.rehearsal.yml`).

**Spec:** `docs/superpowers/specs/2026-10-02-import-reliability-design.md`. It holds the evidence (four reproduced defects) and the decisions behind everything below; read it first.

## Global Constraints

These come from the spec and the repository's conventions; every task's requirements include them.

- No new npm dependencies.
- The response JSON of `POST /api/upload` (text/CSV) stays `{ success, jobId, streamUrl, queue_position }`; only the moment of the reply changes (after the body is on disk). The ZIP response of `/api/upload` and the whole response of `POST /api/v1/upload` (synchronous result) are unchanged.
- Spool directory: `UPLOAD_SPOOL_DIR`, default `/tmp/ulp-spool`. Free-space floor: `UPLOAD_SPOOL_MIN_FREE_BYTES`, default 20 GiB (`21474836480`).
- Stall timeout: `IMPORT_STALL_TIMEOUT_MS`, default 20 minutes (`1200000`), **measured with `performance.now()`, never `Date.now()`** (this laptop suspends; the monotonic clock does not advance during suspend).
- Do **not** set `KEEP_ALIVE_TIMEOUT`; Node's 300 s `requestTimeout` stays and a cut upload must leave no job, no rows and no spool file.
- Retry allow-list for numeric ClickHouse codes: `242`, `252`, `209`, `210`, and `999` only when the message contains `session expired`, `connection loss` or `operation timeout`; `ENOTFOUND` joins the transient transport codes. `bad query`, `syntax error` and per-query `memory limit` stay final.
- Spool-failure HTTP statuses: `413` (over the size cap), `400` (incomplete body or client disconnect), `507` (not enough free disk).
- Module-level state shared between a route and `instrumentation.ts` must hang off `globalThis` (webpack duplicates modules across chunks; see `lib/upload-queue.ts`).
- Background jobs are started from `instrumentation.ts` in the `NODE_ENV === 'production'` block only; new environment variables are forwarded explicitly in `docker-compose.yml` as `${NAME:-}` and documented in `.env.example` and `README.md` (`__tests__/compose-hardening.test.ts` enforces the pattern for existing ones).
- Code style: TypeScript strict, no semicolons, single quotes, two-space indent, `@/` import alias, comments explain why not what, matching the neighbouring files.
- Verification commands: `npx vitest run <file>` for one file, `npm test` for the suite, `npx tsc --noEmit`, `npm run lint`.
- Work happens on the branch `feat/import-reliability` created from `main` in the main checkout (no worktree: the worktree hazards recorded in the project notes do not apply to a plain branch).

---

## File structure

| File | Responsibility | New / changed |
|---|---|---|
| `lib/clickhouse-retry.ts` | Retry loop: abort signal, transient allow-list for numeric codes | changed |
| `lib/import-runner.ts` | `runImportJob`: abort controller, heartbeat watchdog, slot release; `ImportContext`, `ImportHooks`, `ImportStalledError`, `parseStallMs` | new |
| `lib/upload-spool.ts` | `spoolRequestBody`, `discardSpool`, `sweepSpool`, `startSpoolJanitor`, `describeSpoolError`, spool errors, config getters | new |
| `lib/clickhouse-memory-guard.ts` | `waitForHeadroom` gains `onPoll` and stops on an aborted signal | changed |
| `lib/upload-processor.ts` | signal + heartbeat threaded through the pipeline; `processTextFile`; abortable ZIP processing | changed |
| `lib/audit-log.ts` | `logUploadAction` and the `inbox.retry` action | changed |
| `app/api/upload/route.ts` | Browser upload: spool, reply, import from the spool file under the runner | rewritten |
| `app/api/v1/upload/route.ts` | API upload: spool, import under the runner, synchronous result | changed |
| `lib/inbox-watcher.ts` | Import under the runner via `processTextFile` / `processZipFile` | changed |
| `app/api/inbox/retry/route.ts` | Audit the Retry action | changed |
| `instrumentation.ts` | Start the spool janitor | changed |
| `lib/upload-client.ts` | Browser helper: `postFileWithProgress`, `uploadErrorMessage`, `transferPercent` | new |
| `app/upload/page.tsx` | Transfer progress, queue position, clearer errors | changed |
| `scripts/e2e-upload-resilience.ts` | End-to-end resilience scenarios on the rehearsal stack | new |
| `docker-compose.yml`, `docker-compose.rehearsal.yml`, `.env.example`, `README.md` | New settings forwarded and documented | changed |
| `__tests__/*` | One test file per new module, plus rewritten route tests | new / changed |

---

### Task 1: Retry classification and abort support

**Files:**
- Modify: `lib/clickhouse-retry.ts`
- Test: `__tests__/clickhouse-retry.test.ts` (append)

**Interfaces:**
- Produces: `ClickHouseRetryOptions.signal?: AbortSignal` (aborting it rejects `withClickHouseRetry` with `signal.reason`, aborts the attempt in flight, and is never retried); `isTransientClickHouseError` returns `true` for the allow-list in the Global Constraints.

- [x] **Step 0: Create the branch**

```bash
cd /home/cole/ulp-suite && git switch -c feat/import-reliability && git status --short
```
Expected: `Switched to a new branch 'feat/import-reliability'`; only `?? .claude/` (and the plan file once it exists) listed.

- [x] **Step 1: Write the failing tests**

Append to `__tests__/clickhouse-retry.test.ts` (the imports at the top already provide `describe`, `expect`, `it`, `vi`, `isTransientClickHouseError`, `withClickHouseRetry`):

```ts
describe('isTransientClickHouseError: server errors that clear on their own', () => {
  it('retries a read-only replica, a lost Keeper session, part pressure and network errors despite their numeric codes', () => {
    expect(isTransientClickHouseError({
      code: '242',
      message: 'Table is in readonly mode (replica path: /clickhouse/tables/01/ulp/credentials/replicas/r1)',
    })).toBe(true)
    expect(isTransientClickHouseError({
      code: '999',
      message: 'Session expired (Session expired): while reading from ZooKeeper',
    })).toBe(true)
    expect(isTransientClickHouseError({
      code: '999',
      message: 'Coordination::Exception: Connection loss',
    })).toBe(true)
    expect(isTransientClickHouseError({
      code: '252',
      message: "Too many parts (1001 with average size of 4.56 MiB) in table 'ulp.credentials'. Merges are processing significantly slower than inserts",
    })).toBe(true)
    expect(isTransientClickHouseError({ code: '210', message: 'Connection refused (peer: 10.0.0.2:9000)' })).toBe(true)
    expect(isTransientClickHouseError({ code: '209', message: 'Timeout exceeded while reading from socket' })).toBe(true)
  })

  it('also looks through the error cause', () => {
    expect(isTransientClickHouseError({
      message: 'insert failed',
      cause: { code: '242', message: 'Table is in readonly mode' },
    })).toBe(true)
  })

  it('treats a DNS blip as a transport failure', () => {
    expect(isTransientClickHouseError(Object.assign(new Error('getaddrinfo ENOTFOUND clickhouse'), { code: 'ENOTFOUND' }))).toBe(true)
  })

  it('keeps Keeper errors that a retry cannot fix final', () => {
    expect(isTransientClickHouseError({ code: '999', message: 'Coordination::Exception: No node, path: /clickhouse/tables/x' })).toBe(false)
    expect(isTransientClickHouseError({ code: '999', message: 'Coordination::Exception: Node exists' })).toBe(false)
  })

  it('keeps a syntax error final even though it carries a numeric code', () => {
    expect(isTransientClickHouseError({ code: '62', message: 'Syntax error: failed at position 1' })).toBe(false)
  })
})

describe('withClickHouseRetry: abort signal', () => {
  it('throws the reason at once, without calling the operation, when the signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before start')
    controller.abort(reason)
    const operation = vi.fn(async () => 'never')

    await expect(withClickHouseRetry(operation, { signal: controller.signal })).rejects.toBe(reason)
    expect(operation).not.toHaveBeenCalled()
  })

  it('aborts the attempt in flight, does not retry, and rejects with the reason', async () => {
    const controller = new AbortController()
    const reason = new Error('stalled')
    let attempts = 0
    let seen: AbortSignal | undefined

    const promise = withClickHouseRetry(
      signal => {
        attempts += 1
        seen = signal
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), { once: true })
        })
      },
      { signal: controller.signal, sleep: async () => undefined }
    )
    controller.abort(reason)

    await expect(promise).rejects.toBe(reason)
    expect(attempts).toBe(1)
    expect(seen?.aborted).toBe(true)
  })

  it('stops waiting between attempts when aborted during the backoff sleep', async () => {
    const controller = new AbortController()
    let attempts = 0

    const promise = withClickHouseRetry(
      async () => {
        attempts += 1
        throw Object.assign(new Error('transient'), { code: 'ECONNRESET' })
      },
      {
        signal: controller.signal,
        sleep: () => new Promise<void>(() => { /* never wakes: only the abort can end this wait */ }),
        onRetry: () => controller.abort(new Error('cancelled during backoff')),
      }
    )

    await expect(promise).rejects.toThrow('cancelled during backoff')
    expect(attempts).toBe(1)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/clickhouse-retry.test.ts`
Expected: FAIL. The classification cases fail (`242`/`252`/`999` return `false` today; `ENOTFOUND` returns `false`) and the three abort cases fail because `signal` is not an option yet (the already-aborted case calls the operation, the others never settle or time out).

- [x] **Step 3: Implement**

In `lib/clickhouse-retry.ts` make these edits.

3a. Add `ENOTFOUND` to the transport codes and drop `too many parts` from the semantic list (it is now transient):

```ts
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])
```

```ts
const SEMANTIC_MESSAGES = [
  'bad query',
  'memory limit',
  'syntax error',
  'sql error',
  'parse error',
]
```

3b. Directly after the `TRANSIENT_OVERLOAD_MESSAGES` constant, add:

```ts
/**
 * Server-side errors that carry a numeric ClickHouse code (so the semantic rule below would call them final) but clear on
 * their own within seconds. Checked before that rule.
 *
 *   242  TABLE_IS_READ_ONLY   a replica loses its Keeper session for about 0.1 s after a laptop suspend/resume
 *   252  TOO_MANY_PARTS       insert pressure; background merges catch up
 *   209  SOCKET_TIMEOUT, 210 NETWORK_ERROR   the server could not reach a peer or the client
 *   999  KEEPER_EXCEPTION     only the session/connection flavours; "No node", "Node exists" and the like stay final
 */
const TRANSIENT_SERVER_CODES = new Set(['242', '252', '209', '210'])
const TRANSIENT_SERVER_PHRASES = ['table is in readonly mode', 'table is in read-only mode', 'too many parts']
const TRANSIENT_KEEPER_PHRASES = ['session expired', 'connection loss', 'operation timeout']
```

3c. Add the option to `ClickHouseRetryOptions`:

```ts
export interface ClickHouseRetryOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  maxElapsedMs?: number
  sleep?: (delayMs: number) => Promise<void>
  now?: () => number
  onRetry?: (event: { attempt: number; delayMs: number; error: unknown }) => void
  /**
   * Ends the loop at once when it fires: the attempt in flight is aborted, no further attempt starts, and the promise
   * rejects with `signal.reason`. An abort is never retried.
   */
  signal?: AbortSignal
}
```

3d. Add the signal check helper next to `hasTransientOverloadMessage`:

```ts
function hasTransientServerSignal(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const code = String(getCode(error) ?? '')
  const message = getMessage(error).toLowerCase()

  if (TRANSIENT_SERVER_CODES.has(code)) return true
  if (TRANSIENT_SERVER_PHRASES.some(phrase => message.includes(phrase))) return true
  return code === '999' && TRANSIENT_KEEPER_PHRASES.some(phrase => message.includes(phrase))
}
```

3e. In `isTransientClickHouseError`, directly after the existing `hasTransientOverloadMessage` block and before `if (hasSemanticClickHouseError(error))`, add:

```ts
  if (
    hasTransientServerSignal(error) ||
    hasTransientServerSignal((error as { cause?: unknown }).cause)
  ) {
    return true
  }
```

3f. Replace `withClickHouseRetry` entirely with:

```ts
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export async function withClickHouseRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ClickHouseRetryOptions = {}
): Promise<T> {
  const {
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
    sleep = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)),
    now = () => Date.now(),
    onRetry,
    signal,
  } = options

  const startedAt = now()
  let attempts = 0
  let lastError: unknown
  let activeController: AbortController | undefined
  let rejectDeadline!: (error: ClickHouseRetryExhaustedError) => void
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const deadlineTimer = setTimeout(() => {
    const deadlineCause = lastError ?? new Error('Timeout error.')
    rejectDeadline(new ClickHouseRetryExhaustedError(attempts, deadlineCause))
    activeController?.abort(deadlineCause)
  }, Math.max(0, maxElapsedMs))

  // An external abort (the import was cancelled or stalled) ends the loop at once; it is never retried.
  let rejectAbort!: (reason: unknown) => void
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  abortPromise.catch(() => {}) // the loop may finish first: that must not become an unhandled rejection
  const onAbort = () => {
    if (!signal) return
    rejectAbort(abortReason(signal))
    activeController?.abort(signal.reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal?.aborted) throw abortReason(signal)

    while (true) {
      attempts += 1
      activeController = new AbortController()

      try {
        const result = await Promise.race([
          operation(activeController.signal),
          deadlinePromise,
          abortPromise,
        ])
        activeController = undefined
        return result
      } catch (error) {
        activeController = undefined
        if (error instanceof ClickHouseRetryExhaustedError) throw error
        if (signal?.aborted) throw abortReason(signal)
        lastError = error

        if (!isTransientClickHouseError(error)) {
          throw error
        }

        const delayMs = delayForAttempt(attempts, initialDelayMs, maxDelayMs)
        const deadline = startedAt + maxElapsedMs

        if (now() + delayMs > deadline) {
          throw new ClickHouseRetryExhaustedError(attempts, error)
        }

        onRetry?.({ attempt: attempts, delayMs, error })
        await Promise.race([sleep(delayMs), deadlinePromise, abortPromise])
      }
    }
  } finally {
    clearTimeout(deadlineTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/clickhouse-retry.test.ts`
Expected: PASS, every existing test in the file still green.

- [x] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && git add lib/clickhouse-retry.ts __tests__/clickhouse-retry.test.ts docs/superpowers/plans/2026-10-02-import-reliability.md && git commit -m "$(cat <<'EOF'
fix(retry): retry Keeper/read-only/part-pressure errors and honour an abort signal

Numeric ClickHouse codes were all treated as final, so a ~0.1 s Keeper session
expiry after a laptop resume (TABLE_IS_READ_ONLY 242) or TOO_MANY_PARTS (252)
aborted a whole import. An allow-list now retries 242, 252, 209, 210 and the
session/connection flavours of 999; ENOTFOUND joins the transport codes.
withClickHouseRetry also takes an AbortSignal that ends the loop and the attempt
in flight at once, which the import watchdog needs.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: typecheck exits 0; one commit created.

---

### Task 2: Import runner with a stall watchdog

**Files:**
- Create: `lib/import-runner.ts`
- Create: `__tests__/import-runner.test.ts`
- Create: `__tests__/upload-reliability-config.test.ts`
- Modify: `docker-compose.yml` (forward `IMPORT_STALL_TIMEOUT_MS`), `.env.example`, `README.md`

**Interfaces:**
- Produces (in `lib/import-runner.ts`):
  - `interface ImportContext { signal: AbortSignal; beat: () => void }`
  - `type ImportHooks = Partial<ImportContext>`
  - `class ImportStalledError extends Error { label: string; idleMs: number }`
  - `function parseStallMs(raw: string | undefined): number` (default `1_200_000`)
  - `function runImportJob<T>(opts: { label: string; work: (ctx: ImportContext) => Promise<T>; signal?: AbortSignal; stallMs?: number; now?: () => number }): Promise<T>`

- [x] **Step 1: Write the failing tests**

Create `__tests__/import-runner.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import pLimit from 'p-limit'
import { ImportStalledError, parseStallMs, runImportJob } from '@/lib/import-runner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('parseStallMs', () => {
  it('defaults to 20 minutes for an unset, empty or invalid value', () => {
    for (const raw of [undefined, '', '   ', 'abc', '0', '-5']) {
      expect(parseStallMs(raw)).toBe(1_200_000)
    }
  })

  it('accepts a positive number of milliseconds', () => {
    expect(parseStallMs('30000')).toBe(30_000)
  })
})

describe('runImportJob', () => {
  it('returns the work result and hands the work a live signal and a beat', async () => {
    let received: { aborted: boolean; beatIsFunction: boolean } | undefined
    const result = await runImportJob({
      label: 'a.txt',
      work: async ctx => {
        received = { aborted: ctx.signal.aborted, beatIsFunction: typeof ctx.beat === 'function' }
        return 42
      },
    })

    expect(result).toBe(42)
    expect(received).toEqual({ aborted: false, beatIsFunction: true })
  })

  it('propagates the work error unchanged', async () => {
    const boom = new Error('boom')
    await expect(runImportJob({ label: 'a.txt', work: async () => { throw boom } })).rejects.toBe(boom)
  })

  it('fails with ImportStalledError, and aborts the signal, when no beat arrives within stallMs', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 0
    let seen!: AbortSignal

    const promise = runImportJob({
      label: 'wedged.txt',
      stallMs: 1_000,
      now: () => clock,
      work: ({ signal }) => {
        seen = signal
        return new Promise<never>(() => { /* never settles */ })
      },
    })
    const rejection = expect(promise).rejects.toBeInstanceOf(ImportStalledError)

    clock = 1_500
    await vi.advanceTimersByTimeAsync(1_500)

    await rejection
    expect(seen.aborted).toBe(true)
    await expect(promise).rejects.toThrow(/wedged\.txt.*stalled/)
  })

  it('a beat restarts the stall window', async () => {
    vi.useFakeTimers()
    let clock = 0
    let beat!: () => void
    let finish!: (value: string) => void

    const promise = runImportJob({
      label: 'steady.txt',
      stallMs: 1_000,
      now: () => clock,
      work: ctx => {
        beat = ctx.beat
        return new Promise<string>(resolve => { finish = resolve })
      },
    })

    clock = 800
    await vi.advanceTimersByTimeAsync(800) // idle 800 < 1000: still alive
    beat() // last progress at 800
    clock = 1_600
    await vi.advanceTimersByTimeAsync(800) // idle 800 since the beat: still alive
    finish('done')

    await expect(promise).resolves.toBe('done')
  })

  it('frees a queue slot even though the work never settles', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 0
    const queue = pLimit(1)

    const first = queue(() => runImportJob({
      label: 'wedged.txt',
      stallMs: 1_000,
      now: () => clock,
      work: () => new Promise<never>(() => { /* never settles */ }),
    }))
    const firstRejection = expect(first).rejects.toBeInstanceOf(ImportStalledError)
    let secondRan = false
    const second = queue(async () => { secondRan = true })

    await vi.advanceTimersByTimeAsync(0) // let the queue start the first job (and its watchdog) before time moves
    clock = 1_500
    await vi.advanceTimersByTimeAsync(1_500)

    await firstRejection
    await second
    expect(secondRan).toBe(true)
  })

  it('aborts the work and rejects with the reason when an external signal fires', async () => {
    const external = new AbortController()
    const reason = new Error('operator cancelled')
    let seen!: AbortSignal

    const promise = runImportJob({
      label: 'a.txt',
      signal: external.signal,
      work: ({ signal }) => {
        seen = signal
        return new Promise<never>(() => { /* waits for the abort */ })
      },
    })
    external.abort(reason)

    await expect(promise).rejects.toBe(reason)
    expect(seen.aborted).toBe(true)
  })

  it('rejects at once when the external signal is already aborted', async () => {
    const external = new AbortController()
    const reason = new Error('already cancelled')
    external.abort(reason)

    await expect(runImportJob({ label: 'a.txt', signal: external.signal, work: async () => 1 })).rejects.toBe(reason)
  })

  it('leaves no timer running after the work finishes', async () => {
    vi.useFakeTimers()
    await runImportJob({ label: 'a.txt', work: async () => 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('measures idle time on the monotonic clock: a wall-clock jump (a laptop suspend) does not fail a healthy job', async () => {
    let finish!: () => void
    const promise = runImportJob({
      label: 'healthy.txt',
      stallMs: 400, // the watchdog checks every 100 ms
      work: () => new Promise<void>(resolve => { finish = resolve }),
    })

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000) // the lid reopens a day later
    await new Promise(resolve => setTimeout(resolve, 250)) // two watchdog checks, well under stallMs of real time
    finish()

    await expect(promise).resolves.toBeUndefined()
  })
})
```

Create `__tests__/upload-reliability-config.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

/** The `app:` service block (up to the next top-level service). */
const appService = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  # ─── clickhouse-backup'))

describe('import watchdog setting reaches the container', () => {
  test('IMPORT_STALL_TIMEOUT_MS is forwarded with an empty default (so the code default applies) and documented', () => {
    expect(appService).toContain('IMPORT_STALL_TIMEOUT_MS: ${IMPORT_STALL_TIMEOUT_MS:-}')
    expect(envExample).toContain('IMPORT_STALL_TIMEOUT_MS')
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/import-runner.test.ts __tests__/upload-reliability-config.test.ts`
Expected: FAIL: `Cannot find module '@/lib/import-runner'` and the config assertion fails (`IMPORT_STALL_TIMEOUT_MS` is not in the compose file).

- [x] **Step 3: Implement the runner**

Create `lib/import-runner.ts`:

```ts
/**
 * One wrapper for every import job: an HTTP upload, a v1 API upload and an inbox file all run through `runImportJob`.
 *
 * It gives the job an AbortSignal and a heartbeat, and fails the job (and frees its queue slot) when the heartbeat stops.
 * The slot is released when the work settles OR when the signal aborts, whichever comes first: before this existed, one
 * wedged pipeline held a slot of the shared `uploadQueue` until the app restarted, which also stopped the inbox.
 *
 * Idle time is measured with performance.now(), never Date.now(). This laptop suspends; the monotonic clock does not
 * advance while it sleeps, so a wall-clock watchdog would fail a healthy job the moment the lid reopens.
 */
import { performance } from 'node:perf_hooks'

const DEFAULT_STALL_MS = 20 * 60_000

/** Reads IMPORT_STALL_TIMEOUT_MS. An unset, empty, non-numeric or non-positive value falls back to 20 minutes. */
export function parseStallMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MS
}

export class ImportStalledError extends Error {
  readonly label: string
  readonly idleMs: number

  constructor(label: string, idleMs: number) {
    super(`import of ${label} stalled: no progress for ${Math.round(idleMs / 1000)} s`)
    this.name = 'ImportStalledError'
    this.label = label
    this.idleMs = idleMs
  }
}

export interface ImportContext {
  /** Aborted when the job is cancelled or stalls. Pass it to every awaited operation that accepts one. */
  signal: AbortSignal
  /** Call whenever the job makes progress: a batch inserted, a retry attempted, a memory-guard poll. */
  beat: () => void
}

/** What the pipeline functions accept: both parts optional, so existing callers and tests need no change. */
export type ImportHooks = Partial<ImportContext>

export interface RunImportOptions<T> {
  label: string
  work: (ctx: ImportContext) => Promise<T>
  /** An external cancel (a future Cancel button). */
  signal?: AbortSignal
  stallMs?: number
  /** Monotonic clock in ms; tests replace it. */
  now?: () => number
}

export async function runImportJob<T>(opts: RunImportOptions<T>): Promise<T> {
  // Already cancelled: do not even start the work.
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('import aborted')

  const stallMs = opts.stallMs ?? parseStallMs(process.env.IMPORT_STALL_TIMEOUT_MS)
  const now = opts.now ?? (() => performance.now())

  const controller = new AbortController()
  const onExternalAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true })

  let lastBeat = now()
  const beat = () => { lastBeat = now() }

  // Check often enough that a stall is reported within a quarter of the window, but never more than every 30 s.
  const watchdog = setInterval(() => {
    if (controller.signal.aborted) return
    const idleMs = now() - lastBeat
    if (idleMs > stallMs) {
      console.warn(`[import-runner] ${opts.label}: no progress for ${Math.round(idleMs / 1000)} s; failing the job and releasing its queue slot`)
      controller.abort(new ImportStalledError(opts.label, idleMs))
    }
  }, Math.min(30_000, Math.max(10, Math.floor(stallMs / 4))))
  watchdog.unref?.()

  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(controller.signal.reason ?? new Error('import aborted'))
    if (controller.signal.aborted) fail()
    else controller.signal.addEventListener('abort', fail, { once: true })
  })
  aborted.catch(() => {}) // the work may win the race: that must not become an unhandled rejection

  let work: Promise<T> | undefined
  try {
    work = opts.work({ signal: controller.signal, beat })
    return await Promise.race([work, aborted])
  } finally {
    clearInterval(watchdog)
    opts.signal?.removeEventListener('abort', onExternalAbort)
    // If we left because of an abort, the work may still settle later; its rejection is already accounted for.
    work?.catch(() => {})
  }
}
```

- [x] **Step 4: Forward and document the setting**

In `docker-compose.yml`, directly after the `UPLOAD_CONCURRENCY: ${UPLOAD_CONCURRENCY:-1}` line, add:

```yaml
      # Import watchdog (lib/import-runner.ts) -- optional; forwarded explicitly (see above). An import with no progress for this
      # long (no batch inserted, no retry, no memory-guard poll) is failed and its queue slot freed. Empty = 20 minutes.
      IMPORT_STALL_TIMEOUT_MS: ${IMPORT_STALL_TIMEOUT_MS:-}
```

In `.env.example`, append after the `UPLOAD_CONCURRENCY=1` line:

```bash

# ─── Import watchdog ────────────────────────────────
# An import that makes no progress (no batch inserted, no retry, no memory-guard poll) for this many milliseconds is failed
# and its queue slot freed, so one wedged job can no longer block the inbox. Measured in awake time: a laptop suspend does
# not count. Leave unset for the default, 1200000 (20 minutes).
# IMPORT_STALL_TIMEOUT_MS=1200000
```

In `README.md`, after the `UPLOAD_CONCURRENCY` bullet (the one ending `indicator.`) and before the paragraph `Batch size stays a fixed 100,000 rows;`, add:

```markdown
- `IMPORT_STALL_TIMEOUT_MS` — an import that makes no progress for this long (no
  batch inserted, no retry, no memory-guard poll) is failed and its queue slot
  freed. Time is measured while the machine is awake, so a laptop suspend does
  not trip it. Default `1200000` (20 minutes).
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/import-runner.test.ts __tests__/upload-reliability-config.test.ts __tests__/compose-hardening.test.ts`
Expected: PASS (all three files).

- [x] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit && git add lib/import-runner.ts __tests__/import-runner.test.ts __tests__/upload-reliability-config.test.ts docker-compose.yml .env.example README.md && git commit -m "$(cat <<'EOF'
feat(import): one runner for every import job, with a stall watchdog

runImportJob gives a job an AbortSignal and a heartbeat and fails it with
ImportStalledError when the heartbeat stops for IMPORT_STALL_TIMEOUT_MS (default
20 minutes). It releases the queue slot when the work settles OR the signal
aborts, so a wedged pipeline can no longer hold a slot of the shared queue until
an app restart. Idle time uses performance.now(): this laptop suspends and the
monotonic clock does not advance while asleep.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: typecheck exits 0; one commit created.

---

### Task 3: The upload spool

**Files:**
- Create: `lib/upload-spool.ts`
- Create: `__tests__/upload-spool.test.ts`
- Modify: `__tests__/upload-reliability-config.test.ts` (append), `instrumentation.ts`, `docker-compose.yml`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: `capWebStream` and `MaxBytesExceededError` from `lib/size-capped-stream.ts`; `formatBytes` from `lib/utils.ts`.
- Produces (in `lib/upload-spool.ts`):
  - `spoolDir(): string`, `spoolMinFreeBytes(): number`
  - `class SpoolIncompleteError { received: number; expected: number }`, `class SpoolInsufficientStorageError { freeBytes: number; neededBytes: number }`
  - `spoolRequestBody(body: ReadableStream<Uint8Array>, opts: SpoolOptions): Promise<{ path: string; bytes: number }>` where `SpoolOptions = { maxBytes: number; signal?: AbortSignal; expectedBytes?: number; dir?: string; statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>; minFreeBytes?: number }`
  - `discardSpool(path: string): Promise<void>` (idempotent)
  - `sweepSpool(opts: { dir?: string; maxAgeMs: number; now?: () => number }): Promise<string[]>`
  - `startSpoolJanitor(): () => void` (returns a stop function; starting twice returns the same one)
  - `describeSpoolError(error: unknown): { status: number; message: string } | null`

- [x] **Step 1: Write the failing tests**

Create `__tests__/upload-spool.test.ts`:

```ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaxBytesExceededError } from '@/lib/size-capped-stream'
import {
  SpoolIncompleteError,
  SpoolInsufficientStorageError,
  describeSpoolError,
  discardSpool,
  spoolDir,
  spoolMinFreeBytes,
  spoolRequestBody,
  startSpoolJanitor,
  sweepSpool,
} from '@/lib/upload-spool'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-spool-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const bytes = (s: string) => new TextEncoder().encode(s)
const bodyOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const s of chunks) controller.enqueue(bytes(s))
      controller.close()
    },
  })
/** A body that delivers one chunk and then never ends, like a client that went away. */
const hangingBody = (first: string) =>
  new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes(first)) } })
/** Plenty of free space and no reserve, so only the behaviour under test matters. */
const roomy = { statfs: async () => ({ bavail: 1_000_000, bsize: 1_000_000 }), minFreeBytes: 0 }
const names = () => fs.readdirSync(dir)

describe('spoolRequestBody', () => {
  it('writes the whole body to a .upload file and reports its size', async () => {
    const result = await spoolRequestBody(bodyOf('abc', 'def'), { maxBytes: 100, dir, ...roomy })

    expect(result.bytes).toBe(6)
    expect(result.path.endsWith('.upload')).toBe(true)
    expect(path.dirname(result.path)).toBe(dir)
    expect(fs.readFileSync(result.path, 'utf8')).toBe('abcdef')
    expect(names()).toEqual([path.basename(result.path)]) // no .part left behind
  })

  it('accepts a body whose length matches the declared Content-Length', async () => {
    const result = await spoolRequestBody(bodyOf('abcdef'), { maxBytes: 100, dir, expectedBytes: 6, ...roomy })
    expect(result.bytes).toBe(6)
  })

  it('rejects a short body with SpoolIncompleteError and leaves nothing behind', async () => {
    await expect(
      spoolRequestBody(bodyOf('abc'), { maxBytes: 100, dir, expectedBytes: 100, ...roomy })
    ).rejects.toBeInstanceOf(SpoolIncompleteError)
    expect(names()).toEqual([])
  })

  it('enforces the size cap with MaxBytesExceededError and leaves nothing behind', async () => {
    await expect(
      spoolRequestBody(bodyOf('abcdef'), { maxBytes: 4, dir, ...roomy })
    ).rejects.toBeInstanceOf(MaxBytesExceededError)
    expect(names()).toEqual([])
  })

  it('cleans up and rejects with the abort reason when the client disconnects mid-body', async () => {
    const controller = new AbortController()
    const pending = spoolRequestBody(hangingBody('abc'), { maxBytes: 100, dir, signal: controller.signal, ...roomy })
    const rejection = expect(pending).rejects.toHaveProperty('name', 'AbortError')

    await new Promise(resolve => setTimeout(resolve, 20)) // let the first chunk reach the file
    controller.abort()

    await rejection
    expect(names()).toEqual([])
  })

  it('refuses an upload that would leave less than the free-space floor, before writing anything', async () => {
    await expect(
      spoolRequestBody(bodyOf('abc'), {
        maxBytes: 100,
        dir,
        expectedBytes: 5,
        statfs: async () => ({ bavail: 10, bsize: 1 }),
        minFreeBytes: 100,
      })
    ).rejects.toBeInstanceOf(SpoolInsufficientStorageError)
    expect(names()).toEqual([])
  })

  it('cuts a body of undeclared length when it reaches the free-space floor', async () => {
    await expect(
      spoolRequestBody(bodyOf('x'.repeat(60), 'y'.repeat(60)), {
        maxBytes: 1_000,
        dir,
        statfs: async () => ({ bavail: 1_000, bsize: 1 }),
        minFreeBytes: 900, // 100 bytes of budget
      })
    ).rejects.toBeInstanceOf(SpoolInsufficientStorageError)
    expect(names()).toEqual([])
  })
})

describe('discardSpool', () => {
  it('removes the file and is idempotent', async () => {
    const { path: file } = await spoolRequestBody(bodyOf('abc'), { maxBytes: 100, dir, ...roomy })

    await discardSpool(file)
    expect(fs.existsSync(file)).toBe(false)
    await expect(discardSpool(file)).resolves.toBeUndefined()
  })
})

describe('sweepSpool', () => {
  it('removes spool files nobody owns once they are old enough, and keeps owned and young ones', async () => {
    const owned = (await spoolRequestBody(bodyOf('keep'), { maxBytes: 100, dir, ...roomy })).path
    const orphanOld = path.join(dir, 'orphan-old.upload')
    const orphanYoung = path.join(dir, 'orphan-young.part')
    fs.writeFileSync(orphanOld, 'x')
    fs.writeFileSync(orphanYoung, 'x')
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000
    fs.utimesSync(orphanOld, twoHoursAgo, twoHoursAgo)
    fs.utimesSync(owned, twoHoursAgo, twoHoursAgo)

    const removed = await sweepSpool({ dir, maxAgeMs: 3_600_000 })

    expect(removed).toEqual(['orphan-old.upload'])
    expect(fs.existsSync(owned)).toBe(true)
    expect(fs.existsSync(orphanYoung)).toBe(true)
  })

  it('with maxAgeMs 0 removes every file nobody owns (at startup a new process owns none)', async () => {
    fs.writeFileSync(path.join(dir, 'a.upload'), 'x')
    fs.writeFileSync(path.join(dir, 'b.part'), 'x')

    const removed = await sweepSpool({ dir, maxAgeMs: 0 })

    expect(removed.sort()).toEqual(['a.upload', 'b.part'])
    expect(names()).toEqual([])
  })

  it('returns an empty list when the directory does not exist', async () => {
    await expect(sweepSpool({ dir: path.join(dir, 'missing'), maxAgeMs: 0 })).resolves.toEqual([])
  })
})

describe('startSpoolJanitor', () => {
  it('removes leftovers at startup and can be stopped', async () => {
    vi.stubEnv('UPLOAD_SPOOL_DIR', dir)
    const leftover = path.join(dir, 'leftover.upload')
    fs.writeFileSync(leftover, 'x')

    const stop = startSpoolJanitor()
    try {
      await vi.waitFor(() => expect(fs.existsSync(leftover)).toBe(false))
      expect(startSpoolJanitor()).toBe(stop) // a second start is a no-op that returns the same stop
    } finally {
      stop()
    }
  })
})

describe('configuration', () => {
  it('spoolDir defaults to /tmp/ulp-spool and honours UPLOAD_SPOOL_DIR', () => {
    vi.stubEnv('UPLOAD_SPOOL_DIR', '')
    expect(spoolDir()).toBe('/tmp/ulp-spool')
    vi.stubEnv('UPLOAD_SPOOL_DIR', '/data/spool')
    expect(spoolDir()).toBe('/data/spool')
  })

  it('spoolMinFreeBytes defaults to 20 GiB and ignores nonsense', () => {
    vi.stubEnv('UPLOAD_SPOOL_MIN_FREE_BYTES', '')
    expect(spoolMinFreeBytes()).toBe(20 * 1024 ** 3)
    vi.stubEnv('UPLOAD_SPOOL_MIN_FREE_BYTES', 'lots')
    expect(spoolMinFreeBytes()).toBe(20 * 1024 ** 3)
    vi.stubEnv('UPLOAD_SPOOL_MIN_FREE_BYTES', '1048576')
    expect(spoolMinFreeBytes()).toBe(1_048_576)
  })
})

describe('describeSpoolError', () => {
  it('maps the spool failures to an HTTP status and a message, and ignores everything else', () => {
    expect(describeSpoolError(new MaxBytesExceededError(10))).toEqual({ status: 413, message: 'File too large (max 10 Bytes)' })
    expect(describeSpoolError(new SpoolIncompleteError(5, 100))).toEqual({
      status: 400,
      message: 'Upload incomplete: 5 of 100 bytes arrived. Nothing was imported.',
    })
    expect(describeSpoolError(new SpoolInsufficientStorageError(1, 2))).toEqual({
      status: 507,
      message: 'Not enough free disk space to accept this upload.',
    })
    expect(describeSpoolError(new Error('something else'))).toBeNull()
  })
})
```

Append to `__tests__/upload-reliability-config.test.ts`:

```ts
const instrumentation = readFileSync(new URL('../instrumentation.ts', import.meta.url), 'utf8')

describe('upload spool settings reach the container', () => {
  test.each(['UPLOAD_SPOOL_DIR', 'UPLOAD_SPOOL_MIN_FREE_BYTES'])(
    '%s is forwarded with an empty default (so the code default applies) and documented',
    name => {
      expect(appService).toContain(`${name}: \${${name}:-}`)
      expect(envExample).toContain(name)
    },
  )

  test('the spool janitor is started from instrumentation in production only', () => {
    const prod = instrumentation.slice(instrumentation.indexOf("process.env.NODE_ENV === 'production'"))
    expect(prod).toContain("import('./lib/upload-spool')")
    expect(prod).toContain('startSpoolJanitor()')
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/upload-spool.test.ts __tests__/upload-reliability-config.test.ts`
Expected: FAIL: `Cannot find module '@/lib/upload-spool'`, and the config assertions fail.

- [x] **Step 3: Implement the spool**

Create `lib/upload-spool.ts`:

```ts
/**
 * Upload spool.
 *
 * The HTTP upload routes used to answer BEFORE they had the file and let the request body trickle into the importer at the
 * importer's pace. Four ways that went wrong were reproduced on 2026-10-02 (a 5 s consumer stall, an upload queued behind a
 * busy slot, the 300 s request timeout, a client disconnect): each left a job that never finished and held its slot of the
 * shared queue, which also stopped the inbox. The ZIP branch and the inbox, which read from a file, were immune. This module
 * gives the text routes the same property: receive the whole body into a file first, then import from the file.
 * See docs/superpowers/specs/2026-10-02-import-reliability-design.md.
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { capWebStream, MaxBytesExceededError } from '@/lib/size-capped-stream'
import { formatBytes } from '@/lib/utils'

const GIB = 1024 ** 3
const HOUR_MS = 60 * 60_000

export function spoolDir(): string {
  return process.env.UPLOAD_SPOOL_DIR?.trim() || '/tmp/ulp-spool'
}

/** The upload is refused when it would leave less than this free. The disk is shared with ClickHouse. */
export function spoolMinFreeBytes(): number {
  const raw = process.env.UPLOAD_SPOOL_MIN_FREE_BYTES
  if (raw === undefined || raw.trim() === '') return 20 * GIB
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 20 * GIB
}

export class SpoolIncompleteError extends Error {
  readonly received: number
  readonly expected: number

  constructor(received: number, expected: number) {
    super(`upload incomplete: received ${received} of ${expected} bytes`)
    this.name = 'SpoolIncompleteError'
    this.received = received
    this.expected = expected
  }
}

export class SpoolInsufficientStorageError extends Error {
  readonly freeBytes: number
  readonly neededBytes: number

  constructor(freeBytes: number, neededBytes: number) {
    super(`not enough free disk space for this upload (free ${freeBytes} bytes, need ${neededBytes} including the reserve)`)
    this.name = 'SpoolInsufficientStorageError'
    this.freeBytes = freeBytes
    this.neededBytes = neededBytes
  }
}

// globalThis-backed: the routes and instrumentation.ts are compiled into separate webpack chunks (see lib/upload-queue.ts).
declare global {
  // eslint-disable-next-line no-var
  var __ulpSpoolOwned: Set<string> | undefined
  // eslint-disable-next-line no-var
  var __ulpSpoolJanitorStop: (() => void) | undefined
}

/** Spool files a job in this process owns; the janitor never touches them. */
const owned = globalThis.__ulpSpoolOwned ?? (globalThis.__ulpSpoolOwned = new Set<string>())

export interface SpoolOptions {
  /** Hard cap on the bytes accepted (the admin-configured max file size). */
  maxBytes: number
  /** Aborts the receive (Next aborts `request.signal` when the client disconnects before the response finishes). */
  signal?: AbortSignal
  /** The client's Content-Length, when it sent one: the body must be exactly this long. */
  expectedBytes?: number
  /** Tests only. */
  dir?: string
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>
  minFreeBytes?: number
}

export interface SpoolResult {
  path: string
  bytes: number
}

async function freeBytesOf(dir: string, statfs: SpoolOptions['statfs']): Promise<number> {
  const st = await (statfs ?? fs.promises.statfs)(dir)
  return Number(st.bavail) * Number(st.bsize)
}

/**
 * Receive `body` into a new file in the spool directory.
 *
 * The file is written as `<uuid>.part` and renamed to `<uuid>.upload` only when the body ended normally and matches the
 * declared length, so a cut upload can never be mistaken for a whole one. Any failure, abort or short body deletes the file.
 * Resolves with the path of the finished file, which the caller owns until `discardSpool`.
 */
export async function spoolRequestBody(body: ReadableStream<Uint8Array>, opts: SpoolOptions): Promise<SpoolResult> {
  const dir = opts.dir ?? spoolDir()
  const minFree = opts.minFreeBytes ?? spoolMinFreeBytes()
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })

  const free = await freeBytesOf(dir, opts.statfs)
  const declared = opts.expectedBytes ?? 0
  if (free - declared < minFree) throw new SpoolInsufficientStorageError(free, declared + minFree)
  // A body with no declared length (chunked) can only be held to the same floor while it streams.
  const budget = Math.max(0, free - minFree)

  const base = path.join(dir, randomUUID())
  const partPath = `${base}.part`
  const finalPath = `${base}.upload`
  let bytes = 0

  const counted = capWebStream(body, opts.maxBytes).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > budget) {
          controller.error(new SpoolInsufficientStorageError(free, bytes + minFree))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )

  try {
    await pipeline(
      Readable.fromWeb(counted as import('stream/web').ReadableStream<Uint8Array>),
      fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 }),
      { signal: opts.signal },
    )
    if (opts.expectedBytes !== undefined && bytes !== opts.expectedBytes) {
      throw new SpoolIncompleteError(bytes, opts.expectedBytes)
    }
    await fs.promises.rename(partPath, finalPath)
  } catch (err) {
    await fs.promises.rm(partPath, { force: true }).catch(() => {})
    if (opts.signal?.aborted) throw opts.signal.reason ?? err
    throw err
  }

  owned.add(finalPath)
  return { path: finalPath, bytes }
}

/** Delete a spool file and stop protecting it from the janitor. Safe to call twice. */
export async function discardSpool(filePath: string): Promise<void> {
  owned.delete(filePath)
  await fs.promises.rm(filePath, { force: true }).catch(() => {})
}

/**
 * Delete spool files that no running job in this process owns and that are at least `maxAgeMs` old. Returns their names.
 * At startup call it with 0: a new process owns nothing, so everything left in the directory is an orphan of the last run.
 * An in-flight `.part` is never older than the 5 minutes Node allows a request to take, so an hourly sweep cannot hit one.
 */
export async function sweepSpool(opts: { dir?: string; maxAgeMs: number; now?: () => number }): Promise<string[]> {
  const dir = opts.dir ?? spoolDir()
  const now = (opts.now ?? Date.now)()
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    if (owned.has(full)) continue
    try {
      const { mtimeMs } = await fs.promises.stat(full)
      // Clamp: a file written in this very millisecond has an mtime a fraction ahead of Date.now(), i.e. a negative age.
      if (Math.max(0, now - mtimeMs) >= opts.maxAgeMs) {
        await fs.promises.rm(full, { force: true })
        removed.push(entry.name)
      }
    } catch {
      /* already gone */
    }
  }
  return removed
}

/**
 * Clean the spool at startup, then hourly. Called from instrumentation.ts (production only). Returns a stop function;
 * a second call while one is running returns the same stop and does nothing else.
 */
export function startSpoolJanitor(): () => void {
  if (globalThis.__ulpSpoolJanitorStop) return globalThis.__ulpSpoolJanitorStop

  sweepSpool({ maxAgeMs: 0 })
    .then(removed => {
      if (removed.length > 0) console.warn(`[upload-spool] removed ${removed.length} leftover spool file(s) from a previous run`)
    })
    .catch(err => console.error('[upload-spool] startup sweep failed:', err))

  const timer = setInterval(() => {
    sweepSpool({ maxAgeMs: HOUR_MS }).catch(err => console.error('[upload-spool] hourly sweep failed:', err))
  }, HOUR_MS)
  timer.unref?.()

  const stop = () => {
    clearInterval(timer)
    globalThis.__ulpSpoolJanitorStop = undefined
  }
  globalThis.__ulpSpoolJanitorStop = stop
  return stop
}

/** The HTTP status and message for a spool failure, or null when the error is something else. */
export function describeSpoolError(error: unknown): { status: number; message: string } | null {
  if (error instanceof MaxBytesExceededError) {
    return { status: 413, message: `File too large (max ${formatBytes(error.limitBytes)})` }
  }
  if (error instanceof SpoolIncompleteError) {
    return { status: 400, message: `Upload incomplete: ${error.received} of ${error.expected} bytes arrived. Nothing was imported.` }
  }
  if (error instanceof SpoolInsufficientStorageError) {
    return { status: 507, message: 'Not enough free disk space to accept this upload.' }
  }
  return null
}
```

- [x] **Step 4: Start the janitor, forward and document the settings**

In `instrumentation.ts`, directly after the inbox watcher block

```ts
      try {
        const { startInboxWatcher } = await import('./lib/inbox-watcher')
        startInboxWatcher()
      } catch (err) {
        console.error('[instrumentation] Inbox watcher failed to start:', err)
      }
```

add:

```ts

      // Delete spooled uploads a previous process left behind, then hourly any that no running job owns.
      try {
        const { startSpoolJanitor } = await import('./lib/upload-spool')
        startSpoolJanitor()
      } catch (err) {
        console.error('[instrumentation] Upload spool janitor failed to start:', err)
      }
```

In `docker-compose.yml`, directly after the `IMPORT_STALL_TIMEOUT_MS` line added in Task 2:

```yaml
      # Upload spool (lib/upload-spool.ts) -- optional; forwarded explicitly (see above). HTTP uploads are received into this
      # directory first and imported from the file. Empty = /tmp/ulp-spool and a 20 GiB free-space floor.
      UPLOAD_SPOOL_DIR: ${UPLOAD_SPOOL_DIR:-}
      UPLOAD_SPOOL_MIN_FREE_BYTES: ${UPLOAD_SPOOL_MIN_FREE_BYTES:-}
```

In `.env.example`, after the `IMPORT_STALL_TIMEOUT_MS` block from Task 2:

```bash

# ─── Upload spool ───────────────────────────────────
# Uploads over HTTP (the Upload page, /api/upload, /api/v1/upload) are received into this directory first and imported
# from the file, so a dropped connection or a busy queue can never leave a half-read import. The default is inside the
# container. An upload is refused when it would leave less than UPLOAD_SPOOL_MIN_FREE_BYTES free (default 20 GiB; the
# disk is shared with ClickHouse).
# UPLOAD_SPOOL_DIR=/tmp/ulp-spool
# UPLOAD_SPOOL_MIN_FREE_BYTES=21474836480
```

In `README.md`, insert this new subsection immediately before the line `### Import throughput tuning`:

```markdown
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

```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/upload-spool.test.ts __tests__/upload-reliability-config.test.ts __tests__/compose-hardening.test.ts`
Expected: PASS (all three files).

- [x] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit && git add lib/upload-spool.ts __tests__/upload-spool.test.ts __tests__/upload-reliability-config.test.ts instrumentation.ts docker-compose.yml .env.example README.md && git commit -m "$(cat <<'EOF'
feat(upload): spool an HTTP upload body to disk before answering

spoolRequestBody receives the whole body into <uuid>.part, renames it to
<uuid>.upload only when it ended normally and matches Content-Length, and deletes
it on any error, short body or client disconnect. It enforces the size cap and a
free-space floor (default 20 GiB) and keeps a registry on globalThis so the
janitor (startup + hourly) never removes a file a running job owns. This is the
property the ZIP branch and the inbox already had, and it removes the hangs the
early-reply design caused.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: typecheck exits 0; one commit created.

---

### Task 4: Thread abort and heartbeat through the import pipeline

**Files:**
- Modify: `lib/clickhouse-memory-guard.ts`, `lib/upload-processor.ts`
- Test: `__tests__/clickhouse-memory-guard.test.ts` (append), `__tests__/upload-processor.test.ts` (append, plus three import lines)

**Interfaces:**
- Consumes: `ImportHooks` from `lib/import-runner.ts` (Task 2); `ClickHouseRetryOptions.signal` (Task 1).
- Produces:
  - `waitForHeadroom(signal, opts)` where `opts.onPoll?: () => void` is called on every poll and an aborted `signal` makes it throw `signal.reason`.
  - `StreamToTableOptions.signal?: AbortSignal` and `.onBeat?: () => void`.
  - `sourceAlreadyImported(filename, hooks?)`, `recordSource(filename, lineCount, hooks?)`, `processTextStream(stream, filename, jobId?, onBatch?, hooks?)`, `processZipEntries(zipfile, onEntry, hooks?)`, `processZipBuffer(buffer, onEntry, hooks?)`, `processZipFile(filepath, onEntry, hooks?)`, all with `hooks: ImportHooks = {}`.
  - `processTextFile(filePath: string, filename: string, jobId?: string, onBatch?: (imported: number) => void, hooks?: ImportHooks): Promise<ProcessResult>`.

- [x] **Step 1: Write the failing tests**

Append to `__tests__/clickhouse-memory-guard.test.ts` (it already provides `h`, `describe`, `it`, `expect`, `vi`):

```ts
describe('waitForHeadroom: watchdog and abort hooks', () => {
  it('reports every poll through onPoll', async () => {
    vi.useFakeTimers()
    h.query
      .mockResolvedValueOnce({ json: async () => [{ used: '16000000000', ceiling: '18000000000' }] }) // ~0.89, wait
      .mockResolvedValueOnce({ json: async () => [{ used: '9000000000', ceiling: '18000000000' }] }) // 0.5, go
    const onPoll = vi.fn()

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')
      const promise = waitForHeadroom(new AbortController().signal, {
        thresholdRatio: 0.75, pollIntervalMs: 5_000, maxWaitMs: 60_000, onPoll,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await promise

      expect(onPoll).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws the signal reason, without querying, once the signal is aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('import stalled')
    controller.abort(reason)
    const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')

    await expect(waitForHeadroom(controller.signal)).rejects.toBe(reason)
    expect(h.query).not.toHaveBeenCalled()
  })
})
```

In `__tests__/upload-processor.test.ts`, change the first line `import { readFileSync } from 'fs'` to the following three lines:

```ts
import fs, { readFileSync } from 'fs'
import os from 'os'
import path from 'path'
```

and append at the end of the file:

```ts
describe('import hooks: abort signal and heartbeat', () => {
  const oneLine = () =>
    Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>

  it('rejects with the reason and imports nothing when the signal is already aborted', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    const controller = new AbortController()
    const reason = new Error('stalled before start')
    controller.abort(reason)

    await expect(
      processTextStream(oneLine(), 'aborted.txt', undefined, undefined, { signal: controller.signal })
    ).rejects.toBe(reason)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('beats after the source check and after each inserted batch', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    const beat = vi.fn()

    await processTextStream(oneLine(), 'beats.txt', undefined, undefined, { beat })

    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('cancels an insert in flight when the signal aborts, and rejects with the reason', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    const controller = new AbortController()
    const reason = new Error('import stalled')
    h.insert.mockImplementationOnce(({ abort_signal }: { abort_signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        abort_signal.addEventListener('abort', () => reject(new Error('insert aborted')), { once: true })
      })
    )

    const promise = processTextStream(oneLine(), 'hang.txt', undefined, undefined, { signal: controller.signal })
    const rejection = expect(promise).rejects.toBe(reason)
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledTimes(1))
    controller.abort(reason)

    await rejection
  })
})

describe('processTextFile', () => {
  it('imports a file on disk through the same pipeline as a stream', async () => {
    const { processTextFile } = await import('@/lib/upload-processor')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-textfile-'))
    const file = path.join(dir, 'a.upload')
    fs.writeFileSync(file, 'https://example.com/login:user@example.com:mypassword\n')

    try {
      const result = await processTextFile(file, 'a.txt')

      expect(result.imported).toBe(1)
      expect(result.filename).toBe('a.txt')
      expect(h.insert).toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('processZipFile: abort', () => {
  it('stops at the next entry and rejects with the reason when the signal aborts', async () => {
    const yauzl = (await import('yauzl')).default
    const { processZipFile } = await import('@/lib/upload-processor')
    const controller = new AbortController()
    const reason = new Error('import stalled')
    const fake = new FakeZipFile([
      { fileName: 'one.txt', contentOrError: 'https://example.com/login:one@example.com:mypassword\n' },
      { fileName: 'two.txt', contentOrError: 'https://example.com/login:two@example.com:mypassword\n' },
    ])
    ;(yauzl.open as any).mockImplementation(
      (_path: string, _opts: unknown, cb: (err: Error | null, zipfile: yauzl.ZipFile) => void) => {
        cb(null, fake as unknown as yauzl.ZipFile)
      }
    )

    const seen: string[] = []
    const promise = processZipFile('/spool/x.upload', result => {
      seen.push(result.filename)
      controller.abort(reason) // cancel right after the first entry
    }, { signal: controller.signal })

    await expect(promise).rejects.toBe(reason)
    expect(seen).toEqual(['one.txt'])
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/clickhouse-memory-guard.test.ts __tests__/upload-processor.test.ts`
Expected: FAIL: `onPoll` is never called, the aborted guard resolves instead of throwing, `processTextStream` ignores the fifth argument, `processTextFile` is not exported, and the ZIP abort test imports both entries.

- [x] **Step 3: Implement the memory-guard hooks**

In `lib/clickhouse-memory-guard.ts`, replace the `waitForHeadroom` signature and the top of its loop. Old:

```ts
export async function waitForHeadroom(
  signal: AbortSignal,
  opts: { thresholdRatio?: number; maxWaitMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
```

New:

```ts
export async function waitForHeadroom(
  signal: AbortSignal,
  opts: { thresholdRatio?: number; maxWaitMs?: number; pollIntervalMs?: number; onPoll?: () => void } = {},
): Promise<void> {
```

and old:

```ts
  while (true) {
    let pressure: MemoryPressure
    try {
```

new:

```ts
  while (true) {
    // Each poll is progress as far as a stall watchdog is concerned (a waiting job is not a wedged one), and an aborted
    // import must stop waiting instead of polling on.
    opts.onPoll?.()
    signal.throwIfAborted()

    let pressure: MemoryPressure
    try {
```

Also extend the doc comment above `waitForHeadroom` with one sentence: `Reports each poll through opts.onPoll, and throws the signal's reason once the signal is aborted.`

- [x] **Step 4: Implement the pipeline changes**

In `lib/upload-processor.ts`:

4a. Imports. Add `import fs from 'fs'` as the first import (above `import { Readable } from 'stream'`) and add after `import { startIngest, recordBatch, finishIngest } from '@/lib/ingest-metrics'`:

```ts
import type { ImportHooks } from '@/lib/import-runner'
```

4b. Replace `sourceAlreadyImported`:

```ts
export async function sourceAlreadyImported(filename: string, hooks: ImportHooks = {}): Promise<boolean> {
  const rows = await withClickHouseRetry(
    async signal => querySourceAlreadyImported(filename, signal),
    { signal: hooks.signal, onRetry: makeRetryLogger('source check', filename, () => hooks.beat?.()) }
  )
  return rows
}
```

4c. In `recordSource`, change the signature line to
`export async function recordSource(filename: string, lineCount: number, hooks: ImportHooks = {}): Promise<void> {`
and the last argument of its `withClickHouseRetry` call from `{ onRetry: makeRetryLogger('source record', filename) }` to:

```ts
    { signal: hooks.signal, onRetry: makeRetryLogger('source record', filename, () => hooks.beat?.()) }
```

4d. In `StreamToTableOptions`, after the `onBatchCredentials` member add:

```ts
  /** Aborts the import: no further batch is parsed or inserted, and the insert in flight is cancelled. */
  signal?: AbortSignal
  /** Progress heartbeat for the stall watchdog (lib/import-runner.ts): after each batch, on each retry, on each memory-guard poll. */
  onBeat?: () => void
```

4e. In `streamCredentialsToTable`, change the top of the loop. Old:

```ts
    while (true) {
      const tParse = performance.now()
```

New:

```ts
    while (true) {
      options.signal?.throwIfAborted()
      const tParse = performance.now()
```

and replace

```ts
      const guardController = new AbortController()
      await waitForHeadroom(guardController.signal)

      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
```

with

```ts
      await waitForHeadroom(options.signal ?? new AbortController().signal, { onPoll: options.onBeat })

      const tInsert = performance.now()
      await insertBatch(creds, breach_name, { signal: options.signal, onRetry: () => options.onBeat?.() }, { table })
      options.onBeat?.()
      const batchInsertMs = performance.now() - tInsert
```

4f. In `processTextStream`: add the parameter after `onBatch`:

```ts
  /** Called after each 100K-row batch with the cumulative imported count. */
  onBatch?: (imported: number) => void,
  /** Abort signal and progress heartbeat from lib/import-runner.ts; both optional. */
  hooks: ImportHooks = {},
): Promise<ProcessResult> {
```

change `if (await sourceAlreadyImported(filename)) {` to `if (await sourceAlreadyImported(filename, hooks)) {`, add `hooks.beat?.()` on its own line directly after that `if` block (before `let imported = 0`), add `signal: hooks.signal,` and `onBeat: hooks.beat,` after the `shouldHardDrop,` line inside the options object passed to `streamCredentialsToTable`, and change `await recordSource(filename, imported)` to `await recordSource(filename, imported, hooks)`.

4g. Add `processTextFile` directly after `processTextStream` (before the `// ─── ZIP processor` comment):

```ts
/**
 * Import a text file that is already on disk (an inbox file or a spooled upload) through the same pipeline as a stream.
 * This is the one place a file is turned into a stream, so the inbox and the HTTP routes cannot drift apart.
 */
export async function processTextFile(
  filePath: string,
  filename: string,
  jobId?: string,
  onBatch?: (imported: number) => void,
  hooks: ImportHooks = {},
): Promise<ProcessResult> {
  const nodeStream = fs.createReadStream(filePath)
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
  try {
    return await processTextStream(webStream, filename, jobId, onBatch, hooks)
  } finally {
    nodeStream.destroy()
  }
}
```

4h. ZIP functions. Change the signature of `processZipEntries` to

```ts
export function processZipEntries(
  zipfile: yauzl.ZipFile,
  onEntry: (result: ProcessResult) => void,
  hooks: ImportHooks = {},
): Promise<void> {
```

Replace the start of its Promise executor (from `return new Promise<void>((resolve, reject) => {` through `zipfile.readEntry()` — the first call, before the `'entry'` handler) with:

```ts
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let entriesSeen = 0
    const onAbort = () => rejectArchive(hooks.signal?.reason ?? new Error('ZIP import aborted'))
    const rejectArchive = (error: unknown) => {
      if (settled) return
      settled = true
      hooks.signal?.removeEventListener('abort', onAbort)
      ;(zipfile as yauzl.ZipFile & { close?: () => void }).close?.()
      reject(error)
    }

    if (hooks.signal?.aborted) {
      onAbort()
      return
    }
    hooks.signal?.addEventListener('abort', onAbort, { once: true })

    zipfile.readEntry()
```

At the very start of the `zipfile.on('entry', (entry: yauzl.Entry) => {` handler add:

```ts
      if (settled) return // aborted or failed meanwhile: do not open another entry
      hooks.beat?.()
```

Change `processTextStream(webStream, entryName)` to `processTextStream(webStream, entryName, undefined, undefined, hooks)` and its `.then(result => { onEntry(result); zipfile.readEntry() })` to:

```ts
          .then(result => { onEntry(result); hooks.beat?.(); zipfile.readEntry() })
```

Replace the `'end'` handler:

```ts
    zipfile.on('end', () => {
      if (settled) return
      settled = true
      hooks.signal?.removeEventListener('abort', onAbort)
      resolve()
    })
```

Finally add `hooks: ImportHooks = {}` as a third parameter to `processZipBuffer` and `processZipFile` and pass it on: `processZipEntries(zipfile, onEntry, hooks).then(resolve, reject)`.

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/clickhouse-memory-guard.test.ts __tests__/upload-processor.test.ts __tests__/insert-batch-dedup.test.ts __tests__/upload-skip-imported.test.ts`
Expected: PASS (all four files; the existing wiring tests are unchanged and still green).

- [x] **Step 6: Run the whole suite, typecheck, commit**

```bash
npm test 2>&1 | tail -8 && npx tsc --noEmit && git add lib/clickhouse-memory-guard.ts lib/upload-processor.ts __tests__/clickhouse-memory-guard.test.ts __tests__/upload-processor.test.ts && git commit -m "$(cat <<'EOF'
feat(import): thread an abort signal and a heartbeat through the import pipeline

streamCredentialsToTable, processTextStream and the ZIP processors take an
AbortSignal and a beat callback: an abort cancels the insert in flight and stops
parsing, a beat marks progress after each batch, retry and memory-guard poll.
waitForHeadroom reports polls and throws once aborted. processTextFile is the one
way a file on disk is imported (the inbox did it by hand), so the inbox and the
HTTP routes share it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: the suite's last lines show every test file passing with 0 failures; typecheck exits 0; one commit created.

---

### Task 5: Audit actions for uploads and inbox retries

**Files:**
- Modify: `lib/audit-log.ts`
- Create: `__tests__/upload-audit.test.ts`

**Interfaces:**
- Produces: `logUploadAction(action, performedBy, resourceId, details, request?)` where `action` is `'upload.start' | 'upload.complete' | 'upload.fail' | 'upload.api.start' | 'upload.api.complete' | 'upload.api.fail' | 'inbox.retry'`, `performedBy: { id: number | null; email: string | null }`, `resourceId: string | null`, `details: Record<string, unknown>`, `request?: Request`; resolves with the new audit row id (`-1` if the insert failed, as `createAuditLog` does). `AuditAction` gains `'inbox.retry'`.

- [x] **Step 1: Write the failing test**

Create `__tests__/upload-audit.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbRun: vi.fn().mockReturnValue({ lastId: 7 }),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(undefined),
}))

import { dbRun } from '@/lib/sqlite'
import { logUploadAction } from '@/lib/audit-log'

const mockDbRun = dbRun as ReturnType<typeof vi.fn>

beforeEach(() => mockDbRun.mockClear())

describe('logUploadAction', () => {
  it('records an upload start with the acting user, the job id and the client details', async () => {
    const request = new Request('http://localhost/api/upload', { headers: { 'user-agent': 'vitest-agent' } })

    const id = await logUploadAction(
      'upload.start',
      { id: 3, email: 'admin@example.com' },
      'job-1',
      { filename: 'a.txt', bytes: 10 },
      request,
    )

    expect(id).toBe(7)
    const [sql, params] = mockDbRun.mock.calls[0]
    expect(sql).toContain('INSERT INTO audit_logs')
    expect(params[0]).toBe(3)
    expect(params[1]).toBe('admin@example.com')
    expect(params[2]).toBe('upload.start')
    expect(params[3]).toBe('upload')
    expect(params[4]).toBe('job-1')
    expect(JSON.parse(params[5])).toEqual({ filename: 'a.txt', bytes: 10 })
    expect(params[7]).toBe('vitest-agent')
  })

  it('files an inbox retry under the inbox resource type and works without a request', async () => {
    await logUploadAction('inbox.retry', { id: 3, email: null }, null, { moved: ['a.txt'], mode: 'one' })

    const [, params] = mockDbRun.mock.calls[0]
    expect(params[2]).toBe('inbox.retry')
    expect(params[3]).toBe('inbox')
    expect(params[4]).toBeNull()
    expect(params[6]).toBeNull() // ip address
    expect(params[7]).toBeNull() // user agent
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/upload-audit.test.ts`
Expected: FAIL: `logUploadAction` is not exported from `@/lib/audit-log`.

- [x] **Step 3: Implement**

In `lib/audit-log.ts` add `'inbox.retry'` to the union (the `upload.*` members already exist and are currently emitted nowhere):

```ts
export type AuditAction =
  | 'upload.start' | 'upload.complete' | 'upload.fail'
  | 'upload.api.start' | 'upload.api.complete' | 'upload.api.fail'
  | 'inbox.retry'
  | 'user.create' | 'user.update' | 'user.delete'
  | 'user.login' | 'user.logout' | 'user.login.fail'
  | 'user.password.change' | 'user.totp.enable' | 'user.totp.disable'
  | 'apikey.create' | 'apikey.update' | 'apikey.delete' | 'apikey.revoke'
  | 'settings.update' | 'data.export'
```

and append after `logSettingsAction`:

```ts
/**
 * Upload pipeline events: who started an upload, how it ended, and who pressed Retry on an inbox file. The upload.* actions
 * were defined from the start but nothing emitted them, so a hung job left no trace and no user was ever attributed.
 */
export async function logUploadAction(
  action: 'upload.start' | 'upload.complete' | 'upload.fail'
        | 'upload.api.start' | 'upload.api.complete' | 'upload.api.fail'
        | 'inbox.retry',
  performedBy: { id: number | null; email: string | null },
  resourceId: string | null,
  details: Record<string, unknown>,
  request?: Request
): Promise<number> {
  const clientInfo = request ? getClientInfo(request) : { ip: null, userAgent: null }
  return createAuditLog({
    user_id: performedBy.id,
    user_email: performedBy.email,
    action,
    resource_type: action === 'inbox.retry' ? 'inbox' : 'upload',
    resource_id: resourceId,
    details,
    ip_address: clientInfo.ip,
    user_agent: clientInfo.userAgent,
  })
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/upload-audit.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && git add lib/audit-log.ts __tests__/upload-audit.test.ts && git commit -m "$(cat <<'EOF'
feat(audit): record uploads and inbox retries with the acting user

The upload.* audit actions were defined but never emitted, and Inbox Retry was
not audited at all, so no import was ever attributed to anyone. logUploadAction
writes them through the existing audit log.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: typecheck exits 0; one commit created.

---

### Task 6: The browser upload route receives first, then replies

**Files:**
- Rewrite: `app/api/upload/route.ts`
- Create: `__tests__/upload-route-spool.test.ts`
- Modify: `__tests__/upload-route-raw-stream.test.ts` (remove its `/api/upload` describe block; the v1 block stays until Task 7)

**Interfaces:**
- Consumes: `spoolRequestBody`, `discardSpool`, `describeSpoolError`, `SpoolResult` (Task 3); `runImportJob` (Task 2); `processTextFile`, `processZipFile` with `hooks` (Task 4); `logUploadAction` (Task 5).
- Produces: the same HTTP contract as before for text/CSV (`{ success, jobId, streamUrl, queue_position }`), but sent only after the body is on disk; failures during the receive answer 413 / 400 / 507 with `{ success: false, error }` and create no job; ZIP response unchanged.

- [x] **Step 1: Write the failing tests**

Create `__tests__/upload-route-spool.test.ts`:

```ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/clickhouse-migrations', () => ({
  runClickHouseMigrations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/processing-log', () => ({ logJob: vi.fn() }))
vi.mock('@/lib/breach-matcher', () => ({ matchBreach: vi.fn().mockReturnValue('test-breach') }))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/settings', () => ({
  settingsManager: { getMaxUploadFileSizeBytes: vi.fn().mockResolvedValue(10 * 1024 ** 3) },
}))

const captured = vi.hoisted(() => ({ text: '', path: '' }))

vi.mock('@/lib/upload-processor', () => ({
  processTextFile: vi.fn(async (filePath: string, filename: string) => {
    const { readFileSync } = await import('node:fs')
    captured.text = readFileSync(filePath, 'utf8')
    captured.path = filePath
    return {
      imported: 1, skipped: 0, errors: 0, filename, breach_name: 'test',
      rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
    }
  }),
  processZipFile: vi.fn().mockResolvedValue(undefined),
}))

import { settingsManager } from '@/lib/settings'
import { logJob } from '@/lib/processing-log'
import { logUploadAction } from '@/lib/audit-log'
import { processTextFile, processZipFile } from '@/lib/upload-processor'
import { POST } from '@/app/api/upload/route'

const mockProcessTextFile = processTextFile as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>
const mockGetMax = settingsManager.getMaxUploadFileSizeBytes as ReturnType<typeof vi.fn>
const mockLogJob = logJob as ReturnType<typeof vi.fn>
const mockAudit = logUploadAction as ReturnType<typeof vi.fn>

const admin = { id: 1, email: 'admin@example.com' }
let spoolRoot: string

beforeAll(() => {
  spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-route-spool-'))
  process.env.UPLOAD_SPOOL_DIR = spoolRoot
  process.env.UPLOAD_SPOOL_MIN_FREE_BYTES = '0'
})

afterAll(() => {
  fs.rmSync(spoolRoot, { recursive: true, force: true })
  delete process.env.UPLOAD_SPOOL_DIR
  delete process.env.UPLOAD_SPOOL_MIN_FREE_BYTES
})

beforeEach(() => {
  mockProcessTextFile.mockClear()
  mockProcessZipFile.mockReset()
  mockProcessZipFile.mockResolvedValue(undefined)
  mockLogJob.mockClear()
  mockAudit.mockClear()
  captured.text = ''
  captured.path = ''
})

const spoolFiles = () => fs.readdirSync(spoolRoot)
const post = (name: string, body: string, headers: Record<string, string> = {}) =>
  POST(new NextRequest(`http://localhost/api/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', body, headers }))

describe('POST /api/upload: receive first, then reply', () => {
  it('rejects a request with no filename query param', async () => {
    const res = await POST(new NextRequest('http://localhost/api/upload', { method: 'POST', body: 'x' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No filename provided' })
  })

  it('rejects an unsupported file extension without spooling anything', async () => {
    const res = await post('dump.exe', 'irrelevant')

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Unsupported file type')
    expect(spoolFiles()).toEqual([])
  })

  it('receives the whole body, replies with the job, then imports from the spool file and removes it', async () => {
    const body = 'https://a.com:user@a.com:pass\n'

    const res = await post('dump.txt', body)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      success: true,
      jobId: expect.any(String),
      streamUrl: `/api/upload/progress/${json.jobId}`,
      queue_position: expect.any(Number),
    })

    await vi.waitFor(() => expect(mockProcessTextFile).toHaveBeenCalledTimes(1))
    const [filePath, filename, jobId, onBatch, hooks] = mockProcessTextFile.mock.calls[0]
    expect(path.dirname(filePath)).toBe(spoolRoot)
    expect(filePath.endsWith('.upload')).toBe(true)
    expect(filename).toBe('dump.txt')
    expect(jobId).toBe(json.jobId)
    expect(onBatch).toBeUndefined()
    expect(hooks).toEqual({ signal: expect.any(AbortSignal), beat: expect.any(Function) })
    await vi.waitFor(() => expect(captured.text).toBe(body)) // the mock reads the spool file after it is called

    await vi.waitFor(() => expect(spoolFiles()).toEqual([])) // deleted once the import has finished
    expect(mockAudit).toHaveBeenCalledWith(
      'upload.start', admin, json.jobId,
      expect.objectContaining({ filename: 'dump.txt', bytes: Buffer.byteLength(body) }),
      expect.anything(),
    )
    await vi.waitFor(() => expect(mockAudit).toHaveBeenCalledWith(
      'upload.complete', admin, json.jobId, expect.objectContaining({ filename: 'dump.txt', imported: 1 }),
    ))
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', status: 'done', imported: 1 }))
  })

  it('preserves the original filename casing for processing while matching extensions case-insensitively', async () => {
    const res = await post('Mixed-Case-Dump.TXT', 'https://a.com:user@a.com:pass\n')

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(mockProcessTextFile).toHaveBeenCalledTimes(1))
    expect(mockProcessTextFile.mock.calls[0][1]).toBe('Mixed-Case-Dump.TXT')
  })

  it('answers 413 and creates no job when the body exceeds the admin-configured cap', async () => {
    mockGetMax.mockResolvedValueOnce(10) // 10 bytes, for this call only

    const res = await post('dump.txt', 'this body is well over 10 bytes long')

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ success: false, error: 'File too large (max 10 Bytes)' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })

  it('answers 400 and imports nothing when the body is shorter than its Content-Length', async () => {
    const res = await post('dump.txt', 'only ten b', { 'content-length': '100' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Upload incomplete')
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })

  it('answers 400 "Upload cancelled", creates no job and leaves no spool file when the client disconnects mid-body', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('https://a.com:user@a.com:pass\n')) }, // and never ends
    })
    const request = new NextRequest('http://localhost/api/upload?filename=cut.txt', {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' })

    const pending = POST(request)
    await new Promise(resolve => setTimeout(resolve, 30)) // the first chunk reaches the spool file
    controller.abort()
    const res = await pending

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Upload cancelled' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })
})

describe('POST /api/upload: zip archives', () => {
  const entry = (filename: string, imported: number, extra: Record<string, unknown> = {}) => ({
    imported, skipped: 0, errors: 0, filename, breach_name: 'test',
    rejection_breakdown: {}, alreadyImported: false, tierDropped: 0, ...extra,
  })

  it('spools the archive, imports it from the file under the runner and removes the file', async () => {
    mockProcessZipFile.mockImplementationOnce(async (filePath: string, onEntry: (r: unknown) => void) => {
      captured.path = filePath
      onEntry(entry('inner.txt', 2))
    })

    const res = await post('archive.zip', 'pretend zip bytes')

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.imported).toBe(2)
    expect(json.files).toEqual([{ filename: 'inner.txt', breach_name: 'test', imported: 2 }])
    expect(path.dirname(captured.path)).toBe(spoolRoot)
    expect(mockProcessZipFile.mock.calls[0][2]).toEqual({ signal: expect.any(AbortSignal), beat: expect.any(Function) })
    expect(spoolFiles()).toEqual([])
  })

  it("surfaces a skipped zip entry's actual reason in the response, not just its filename", async () => {
    mockProcessZipFile.mockImplementationOnce(async (_path: string, onEntry: (r: unknown) => void) => {
      onEntry(entry('bomb.txt', 0, {
        errors: 1,
        error_reason: 'entry uncompressed size 999999999999 exceeds 53687091200-byte cap',
      }))
    })

    const res = await post('archive.zip', 'irrelevant: processZipFile is mocked')

    expect(res.status).toBe(200)
    expect((await res.json()).errors).toBe(1)
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({
      error_message: expect.stringContaining('bomb.txt (entry uncompressed size 999999999999 exceeds 53687091200-byte cap)'),
    }))
  })

  it('answers 500, audits the failure and removes the spool file when the archive cannot be imported', async () => {
    mockProcessZipFile.mockRejectedValueOnce(new Error('bad archive'))

    const res = await post('archive.zip', 'not really a zip')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'bad archive' })
    expect(mockAudit).toHaveBeenCalledWith('upload.fail', admin, null, expect.objectContaining({ error: 'bad archive' }))
    expect(spoolFiles()).toEqual([])
  })
})
```

In `__tests__/upload-route-raw-stream.test.ts`, delete the whole block `describe('POST /api/upload — raw-stream body', () => { ... })` (from that `describe` line through its closing `})`, the line before the blank line that precedes `describe('POST /api/v1/upload — raw-stream body'`), delete the line `import { POST } from '@/app/api/upload/route'`, and delete the constant `mockLogJob` and its `logJob` import if nothing left in the file uses them.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/upload-route-spool.test.ts`
Expected: FAIL: the route still streams into `processTextStream` (so `processTextFile` is never called, nothing is spooled, `413`/`400` cases answer `200`).

- [x] **Step 3: Rewrite the route**

Replace the whole of `app/api/upload/route.ts` with:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole, type JWTPayload } from '@/lib/auth'
import { makeRejectionMap, type RejectionReason } from '@/lib/ulp-parser'
import { matchBreach } from '@/lib/breach-matcher'
import { runClickHouseMigrations } from '@/lib/clickhouse-migrations'
import { createJob, getJob, updateJob, pushEvent } from '@/lib/upload-jobs'
import { uploadQueue, setCurrentJob } from '@/lib/upload-queue'
import { processTextFile, processZipFile, type ProcessResult } from '@/lib/upload-processor'
import { checkLimit, getClientIP } from '@/lib/rate-limiter'
import { logJob } from '@/lib/processing-log'
import { settingsManager } from '@/lib/settings'
import { formatBytes } from '@/lib/utils'
import { runImportJob } from '@/lib/import-runner'
import { spoolRequestBody, discardSpool, describeSpoolError, type SpoolResult } from '@/lib/upload-spool'
import { logUploadAction } from '@/lib/audit-log'

// 60 uploads per IP per 5 minutes — permits batch multi-file uploads while
// still blocking runaway automation.  Admin-only endpoint; session auth is the
// primary gate.  Previously 5/5 min which blocked normal batch use.
const uploadLimiter = new Map<string, { count: number; resetAt: number }>()

export const dynamic = 'force-dynamic'

// 5 minutes — large uploads (GBs of text) need sustained time.
export const maxDuration = 300

// Admin-configurable via Settings ("Max File Size") — see lib/settings.ts's
// getMaxUploadFileSizeBytes() for the clamp range and default (10 GB).

interface Actor { id: number | null; email: string | null }

function actorOf(user: JWTPayload | null): Actor {
  return { id: user ? Number(user.userId) : null, email: user?.email || null }
}

// ─── SSE progress wrapper ─────────────────────────────────────────────────────

/**
 * Wraps a processing function with SSE progress events + audit logging.
 * Pushes a heartbeat every 2 s; pushes a final event on done/error.
 */
async function runWithProgress(
  jobId:    string,
  filename: string,
  actor:    Actor,
  fn:       () => Promise<ProcessResult>,
): Promise<void> {
  const startAt = Date.now()
  const interval = setInterval(async () => {
    const j = getJob(jobId)
    if (j) await pushEvent(j).catch(() => {})
  }, 2_000)

  try {
    const result = await fn()
    updateJob(jobId, {
      status:              'done',
      imported:            result.imported,
      skipped:             result.skipped,
      tierDropped:         result.tierDropped,
      rejection_breakdown: result.rejection_breakdown,
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
    logJob({
      source:      'http',
      filename,
      status:      'done',
      imported:    result.imported,
      skipped:     result.skipped,
      duration_ms: Date.now() - startAt,
      breach_name: result.breach_name,
    })
    void logUploadAction('upload.complete', actor, jobId, {
      filename, imported: result.imported, skipped: result.skipped, duration_ms: Date.now() - startAt,
    })
  } catch (err) {
    updateJob(jobId, {
      status: 'error',
      error:  err instanceof Error ? err.message : 'Upload failed',
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
    logJob({
      source:        'http',
      filename,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: err instanceof Error ? err.message : String(err),
    })
    void logUploadAction('upload.fail', actor, jobId, {
      filename, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startAt,
    })
  } finally {
    clearInterval(interval)
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError
  const actor = actorOf(user)

  // Rate limit: 60 uploads per IP per 5 minutes
  const ip       = getClientIP(request)
  const rlResult = checkLimit(uploadLimiter, ip, 60, 5 * 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many uploads — please wait before uploading again.' },
      {
        status: 429,
        headers: {
          'Retry-After':           String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit':     '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(rlResult.resetAt),
        },
      }
    )
  }

  await runClickHouseMigrations()

  const MAX_FILE_SIZE = await settingsManager.getMaxUploadFileSizeBytes()

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    return NextResponse.json(
      { success: false, error: `File too large (max ${formatBytes(MAX_FILE_SIZE)})` },
      { status: 413 },
    )
  }

  const originalFilename = request.nextUrl.searchParams.get('filename')
  if (!originalFilename) {
    return NextResponse.json(
      { success: false, error: 'No filename provided' },
      { status: 400 },
    )
  }

  if (!request.body) {
    return NextResponse.json(
      { success: false, error: 'No file data received' },
      { status: 400 },
    )
  }

  const filename = originalFilename.toLowerCase()
  const isText = filename.endsWith('.txt') || filename.endsWith('.csv')
  const isZip  = filename.endsWith('.zip')
  if (!isText && !isZip) {
    return NextResponse.json(
      { success: false, error: 'Unsupported file type. Upload a .txt, .csv, or .zip file.' },
      { status: 400 },
    )
  }

  // Receive the WHOLE body before doing anything else, and only then reply. The old route answered first and let the body
  // trickle into the importer; a stall, a queue wait, the 300 s request timeout or a client disconnect then left a job that
  // never finished and held its slot of the shared queue (docs/superpowers/specs/2026-10-02-import-reliability-design.md).
  // The body is also held to the size cap against bytes actually seen, not the client-supplied Content-Length.
  let spool: SpoolResult
  try {
    spool = await spoolRequestBody(request.body, {
      maxBytes:      MAX_FILE_SIZE,
      signal:        request.signal,
      expectedBytes: contentLength ? parseInt(contentLength) : undefined,
    })
  } catch (error) {
    const known = describeSpoolError(error)
    if (known) return NextResponse.json({ success: false, error: known.message }, { status: known.status })
    if (request.signal.aborted) {
      console.warn(`[upload] client disconnected while uploading ${originalFilename}; nothing was imported`)
      return NextResponse.json({ success: false, error: 'Upload cancelled' }, { status: 400 })
    }
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  }

  // For text the queue owns the spool file from here on; for ZIP this handler does until it responds.
  let handedOff = false
  try {
    // ── Plain text / CSV ──────────────────────────────────────────────────────
    if (isText) {
      const jobId       = crypto.randomUUID()
      const breach_name = matchBreach(originalFilename)
      createJob(jobId, Math.floor(spool.bytes / 60), breach_name)
      void logUploadAction(
        'upload.start', actor, jobId,
        { filename: originalFilename, bytes: spool.bytes, via: 'ui' },
        request,
      )

      runWithProgress(
        jobId,
        originalFilename,
        actor,
        () => uploadQueue(async () => {
          setCurrentJob(originalFilename)
          try {
            return await runImportJob({
              label: originalFilename,
              work:  ctx => processTextFile(spool.path, originalFilename, jobId, undefined, ctx),
            })
          } finally {
            setCurrentJob(null)
            await discardSpool(spool.path)
          }
        }),
      ).catch(console.error)
      handedOff = true

      return NextResponse.json({
        success:        true,
        jobId,
        streamUrl:      `/api/upload/progress/${jobId}`,
        queue_position: uploadQueue.pendingCount,
      })
    }

    // ── ZIP archive ───────────────────────────────────────────────────────────
    const startAt = Date.now()
    const results: ProcessResult[] = []
    let totalErrors = 0
    const failedEntries: string[] = []
    void logUploadAction(
      'upload.start', actor, null,
      { filename: originalFilename, bytes: spool.bytes, via: 'ui', kind: 'zip' },
      request,
    )

    try {
      await uploadQueue(async () => {
        setCurrentJob(originalFilename)
        try {
          await runImportJob({
            label: originalFilename,
            work:  ctx => processZipFile(spool.path, result => {
              if (result.imported > 0) results.push(result)
              if (result.errors > 0) {
                totalErrors += result.errors
                failedEntries.push(
                  result.error_reason ? `${result.filename} (${result.error_reason})` : result.filename
                )
              }
            }, ctx),
          })
        } finally {
          setCurrentJob(null)
        }
      })
    } catch (error) {
      void logUploadAction('upload.fail', actor, null, {
        filename: originalFilename,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startAt,
      })
      throw error
    }

    const totalBreakdown = makeRejectionMap()
    let totalImported = 0
    let totalSkipped  = 0
    let totalTierDropped = 0

    for (const r of results) {
      totalImported += r.imported
      totalSkipped  += r.skipped
      totalTierDropped += r.tierDropped
      for (const [k, v] of Object.entries(r.rejection_breakdown)) {
        totalBreakdown[k as RejectionReason] += v
      }
    }

    logJob({
      source:      'http',
      filename:    originalFilename,
      status:      'done',
      imported:    totalImported,
      skipped:     totalSkipped,
      duration_ms: Date.now() - startAt,
      ...(failedEntries.length > 0
        ? { error_message: `${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'} skipped: ${failedEntries.join(', ')}` }
        : {}),
    })
    void logUploadAction('upload.complete', actor, null, {
      filename: originalFilename, imported: totalImported, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
    })

    const total = totalImported + totalSkipped
    return NextResponse.json({
      success:             true,
      imported:            totalImported,
      skipped:             totalSkipped,
      tierDropped:         totalTierDropped,
      errors:              totalErrors,
      import_pct:          total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0,
      rejection_breakdown: totalBreakdown,
      files:               results.map(r => ({
        filename:    r.filename,
        breach_name: r.breach_name,
        imported:    r.imported,
      })),
      filename: originalFilename,
    })
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  } finally {
    if (!handedOff) await discardSpool(spool.path)
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/upload-route-spool.test.ts __tests__/upload-route-raw-stream.test.ts`
Expected: PASS (both files). If the "shorter than its Content-Length" case answers `200`, this runtime dropped the `content-length` header from the constructed `Request`; build that request with `new NextRequest(url, { method: 'POST', body, headers: new Headers([['content-length', '100']]) })` and re-run.

- [x] **Step 5: Typecheck, lint the file, commit**

```bash
npx tsc --noEmit && npx eslint --no-eslintrc -c .eslintrc.json app/api/upload/route.ts lib/upload-spool.ts lib/import-runner.ts && git add app/api/upload/route.ts __tests__/upload-route-spool.test.ts __tests__/upload-route-raw-stream.test.ts && git commit -m "$(cat <<'EOF'
fix(upload): receive the whole file before the browser route answers

POST /api/upload replied with the job id first and let the request body trickle
into the importer. Reproduced on an isolated stack: a >=5 s consumer stall, an
upload queued behind a busy slot, the 300 s request timeout and a client
disconnect each left a job that never finished and held a slot of the shared
queue, which also stopped the inbox. The route now spools the body to disk, replies
(same JSON), and imports from the file under the stall watchdog; a cut upload
imports nothing and leaves no file. ZIP uses the same spool, and every upload is
audited with the acting user.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: typecheck exits 0 and ESLint prints nothing; one commit created.

---

### Task 7: The v1 API route spools first as well

**Files:**
- Modify: `app/api/v1/upload/route.ts`
- Create: `__tests__/upload-v1-route-spool.test.ts`
- Delete: `__tests__/upload-route-raw-stream.test.ts` (its remaining v1 block is replaced by the new file)

**Interfaces:**
- Consumes: `spoolRequestBody`, `discardSpool`, `describeSpoolError`, `SpoolResult` (Task 3); `runImportJob` (Task 2); `processTextFile`, `processZipFile` (Task 4); `logUploadAction` (Task 5).
- Produces: unchanged v1 responses (`{ success, imported, skipped, errors, filename[, files] }`, synchronous), but the body is spooled first so a queue wait or a disconnect can no longer strand the request.

- [x] **Step 1: Write the failing tests**

Create `__tests__/upload-v1-route-spool.test.ts`:

```ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/processing-log', () => ({ logJob: vi.fn() }))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { keyId: '5', userId: '2', userName: 'ci', name: 'ci-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/settings', () => ({
  settingsManager: { getMaxUploadFileSizeBytes: vi.fn().mockResolvedValue(10 * 1024 ** 3) },
}))

const captured = vi.hoisted(() => ({ text: '', path: '' }))

vi.mock('@/lib/upload-processor', () => ({
  processTextFile: vi.fn(async (filePath: string, filename: string) => {
    const { readFileSync } = await import('node:fs')
    captured.text = readFileSync(filePath, 'utf8')
    captured.path = filePath
    return {
      imported: 1, skipped: 0, errors: 0, filename, breach_name: 'test',
      rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
    }
  }),
  processZipFile: vi.fn().mockResolvedValue(undefined),
}))

import { settingsManager } from '@/lib/settings'
import { logJob } from '@/lib/processing-log'
import { logUploadAction } from '@/lib/audit-log'
import { processTextFile, processZipFile } from '@/lib/upload-processor'
import { POST } from '@/app/api/v1/upload/route'

const mockProcessTextFile = processTextFile as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>
const mockGetMax = settingsManager.getMaxUploadFileSizeBytes as ReturnType<typeof vi.fn>
const mockLogJob = logJob as ReturnType<typeof vi.fn>
const mockAudit = logUploadAction as ReturnType<typeof vi.fn>

let spoolRoot: string

beforeAll(() => {
  spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-v1-spool-'))
  process.env.UPLOAD_SPOOL_DIR = spoolRoot
  process.env.UPLOAD_SPOOL_MIN_FREE_BYTES = '0'
})

afterAll(() => {
  fs.rmSync(spoolRoot, { recursive: true, force: true })
  delete process.env.UPLOAD_SPOOL_DIR
  delete process.env.UPLOAD_SPOOL_MIN_FREE_BYTES
})

beforeEach(() => {
  mockProcessTextFile.mockClear()
  mockProcessZipFile.mockReset()
  mockProcessZipFile.mockResolvedValue(undefined)
  mockLogJob.mockClear()
  mockAudit.mockClear()
  captured.text = ''
  captured.path = ''
})

const spoolFiles = () => fs.readdirSync(spoolRoot)
const post = (name: string, body: string) =>
  POST(new NextRequest(`http://localhost/api/v1/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', body }))

describe('POST /api/v1/upload: spool first, answer when the import has finished', () => {
  it('rejects a request with no filename query param', async () => {
    const res = await POST(new NextRequest('http://localhost/api/v1/upload', { method: 'POST', body: 'x' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No filename provided' })
  })

  it('imports a text upload from the spool file and answers with the result', async () => {
    const body = 'https://a.com:user@a.com:pass\n'

    const res = await post('dump.txt', body)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, imported: 1, skipped: 0, errors: 0, filename: 'dump.txt' })
    const [filePath, filename, jobId, onBatch, hooks] = mockProcessTextFile.mock.calls[0]
    expect(path.dirname(filePath)).toBe(spoolRoot)
    expect(filename).toBe('dump.txt')
    expect(jobId).toBeUndefined()
    expect(onBatch).toBeUndefined()
    expect(hooks).toEqual({ signal: expect.any(AbortSignal), beat: expect.any(Function) })
    expect(captured.text).toBe(body)
    expect(spoolFiles()).toEqual([]) // removed before the response
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', status: 'done', imported: 1 }))
  })

  it('audits the start and the end with the API key', async () => {
    await post('dump.txt', 'https://a.com:user@a.com:pass\n')

    expect(mockAudit).toHaveBeenCalledWith(
      'upload.api.start', { id: 2, email: null }, null,
      expect.objectContaining({ api_key_id: '5', api_key_name: 'ci-key', filename: 'dump.txt' }),
      expect.anything(),
    )
    expect(mockAudit).toHaveBeenCalledWith(
      'upload.api.complete', { id: 2, email: null }, null,
      expect.objectContaining({ api_key_id: '5', filename: 'dump.txt', imported: 1 }),
    )
  })

  it('no longer buffers zip uploads into memory before processing (regression test for the v1 OOM-pattern fix)', () => {
    const source = fs.readFileSync(new URL('../app/api/v1/upload/route.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('arrayBuffer()')
    expect(source).not.toContain('processZipBuffer')
  })

  it('imports a zip from the spool file and lists its entries', async () => {
    mockProcessZipFile.mockImplementationOnce(async (filePath: string, onEntry: (r: unknown) => void) => {
      captured.path = filePath
      onEntry({
        imported: 2, skipped: 0, errors: 0, filename: 'inner.txt', breach_name: 'test',
        rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
      })
    })

    const res = await post('archive.zip', 'pretend zip bytes')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, imported: 2, skipped: 0, errors: 0,
      files: [{ filename: 'inner.txt', imported: 2 }], filename: 'archive.zip',
    })
    expect(path.dirname(captured.path)).toBe(spoolRoot)
    expect(spoolFiles()).toEqual([])
  })

  it('respects a smaller admin-configured max file size, not just the 10 GB default', async () => {
    mockGetMax.mockResolvedValueOnce(10) // 10 bytes, for this call only

    const res = await post('dump.txt', 'this body is well over 10 bytes long')

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ success: false, error: 'File too large (max 10 Bytes)' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(spoolFiles()).toEqual([])
  })

  it('answers 400 and imports nothing when the client disconnects mid-body', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('https://a.com:user@a.com:pass\n')) }, // and never ends
    })
    const request = new NextRequest('http://localhost/api/v1/upload?filename=cut.txt', {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' })

    const pending = POST(request)
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort()
    const res = await pending

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Upload cancelled' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })
})
```

Delete the superseded file: `git rm __tests__/upload-route-raw-stream.test.ts`.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/upload-v1-route-spool.test.ts`
Expected: FAIL: the v1 route still streams into `processTextStream` (so `processTextFile` is never called, nothing is spooled, no audit rows).

- [x] **Step 3: Rewrite the route**

Replace the whole of `app/api/v1/upload/route.ts` with:

```ts
/**
 * Upload API v1 — ULP Credentials Upload
 * POST /api/v1/upload?filename=<name>  (raw file bytes as the request body)
 *
 * API-key authenticated (admin role).  The whole body is received into the upload spool FIRST (lib/upload-spool.ts), then
 * the file goes through the shared uploadQueue (pLimit; browser uploads and the inbox watcher share it) and is imported
 * from the spool file under the stall watchdog (lib/import-runner.ts).  Receiving first means a wait in the queue or a
 * dropped connection can no longer strand the request or wedge a queue slot.  The response is still synchronous: it is
 * sent when the import has finished.
 *
 * Uses the same processing pipeline as the other routes:
 *   - processTextFile  for .txt/.csv  (streams the spool file; also matches credentials against domain monitors
 *                       in-process and fires alerts via fireMonitorAlertsFromMatches — not a separate step)
 *   - processZipFile   for .zip       (yauzl lazy entry streaming from the spool file)
 *   - logJob           for observability (appears in /inbox monitor)
 *   - logUploadAction  for the audit log (who, which file, how it ended)
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { uploadQueue } from "@/lib/upload-queue"
import { processTextFile, processZipFile, type ProcessResult } from "@/lib/upload-processor"
import { logJob } from "@/lib/processing-log"
import { settingsManager } from "@/lib/settings"
import { formatBytes } from "@/lib/utils"
import { runImportJob } from '@/lib/import-runner'
import { spoolRequestBody, discardSpool, describeSpoolError, type SpoolResult } from '@/lib/upload-spool'
import { logUploadAction } from '@/lib/audit-log'

export const dynamic    = "force-dynamic"
export const maxDuration = 300  // 5 minutes — large uploads need sustained time

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/upload')
  const actor = { id: Number(authResult.apiKey.userId) || null, email: null as string | null }
  const keyDetails = { api_key_id: authResult.apiKey.keyId, api_key_name: authResult.apiKey.name }

  // Admin-configurable via Settings ("Max File Size") — see lib/settings.ts's
  // getMaxUploadFileSizeBytes() for the clamp range and default (10 GB).
  const MAX_FILE_SIZE = await settingsManager.getMaxUploadFileSizeBytes()

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    return NextResponse.json({ success: false, error: `File too large (max ${formatBytes(MAX_FILE_SIZE)})` }, { status: 413 })
  }

  const originalFilename = request.nextUrl.searchParams.get('filename')
  if (!originalFilename) {
    return NextResponse.json({ success: false, error: 'No filename provided' }, { status: 400 })
  }

  if (!request.body) {
    return NextResponse.json({ success: false, error: 'No file data received' }, { status: 400 })
  }

  const name = originalFilename.toLowerCase()
  const isText = name.endsWith('.txt') || name.endsWith('.csv')
  const isZip  = name.endsWith('.zip')
  if (!isText && !isZip) {
    return NextResponse.json({ success: false, error: 'Unsupported file type. Use .txt, .csv, or .zip' }, { status: 400 })
  }

  const startAt = Date.now()
  let spool: SpoolResult | undefined

  try {
    // The body is held to the size cap against bytes actually seen, not the client-supplied Content-Length (which can be
    // omitted with chunked transfer-encoding or simply be wrong).
    spool = await spoolRequestBody(request.body, {
      maxBytes:      MAX_FILE_SIZE,
      signal:        request.signal,
      expectedBytes: contentLength ? parseInt(contentLength) : undefined,
    })
    const file = spool.path
    void logUploadAction(
      'upload.api.start', actor, null,
      { ...keyDetails, filename: originalFilename, bytes: spool.bytes, kind: isZip ? 'zip' : 'text' },
      request,
    )

    // ── Plain text / CSV ──────────────────────────────────────────────────────
    // Streaming: constant RAM regardless of file size.
    // Runs through the shared uploadQueue so it doesn't race with other uploads.
    if (isText) {
      // Definite assignment: uploadQueue always resolves the import or throws, so `result` is always assigned when we
      // reach the next line.
      // eslint-disable-next-line prefer-const
      let result!: ProcessResult

      await uploadQueue(async () => {
        result = await runImportJob({
          label: originalFilename,
          work:  ctx => processTextFile(file, originalFilename, undefined, undefined, ctx),
        })
      })
      const r = result
      logJob({
        source:      'http',
        filename:    originalFilename,
        status:      'done',
        imported:    r.imported,
        skipped:     r.skipped,
        duration_ms: Date.now() - startAt,
        breach_name: r.breach_name,
      })
      void logUploadAction('upload.api.complete', actor, null, {
        ...keyDetails, filename: originalFilename, imported: r.imported, skipped: r.skipped, duration_ms: Date.now() - startAt,
      })

      const response = NextResponse.json({
        success:  true,
        imported: r.imported,
        skipped:  r.skipped,
        errors:   r.errors,
        filename: r.filename,
      })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    // ── ZIP archive ───────────────────────────────────────────────────────────
    const results: ProcessResult[] = []
    let totalErrors = 0
    const failedEntries: string[] = []

    await uploadQueue(async () => {
      await runImportJob({
        label: originalFilename,
        work:  ctx => processZipFile(file, result => {
          if (result.imported > 0) results.push(result)
          if (result.errors > 0) {
            totalErrors += result.errors
            failedEntries.push(
              result.error_reason ? `${result.filename} (${result.error_reason})` : result.filename
            )
          }
        }, ctx),
      })
    })

    let totalImported = 0
    let totalSkipped  = 0
    for (const r of results) { totalImported += r.imported; totalSkipped += r.skipped }

    logJob({
      source:      'http',
      filename:    originalFilename,
      status:      'done',
      imported:    totalImported,
      skipped:     totalSkipped,
      duration_ms: Date.now() - startAt,
      ...(failedEntries.length > 0
        ? { error_message: `${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'} skipped: ${failedEntries.join(', ')}` }
        : {}),
    })
    void logUploadAction('upload.api.complete', actor, null, {
      ...keyDetails, filename: originalFilename, imported: totalImported, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
    })

    const response = NextResponse.json({
      success:  true,
      imported: totalImported,
      skipped:  totalSkipped,
      errors:   totalErrors,
      files:    results.map(r => ({ filename: r.filename, imported: r.imported })),
      filename: originalFilename,
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    const known = describeSpoolError(error)
    const cancelled = !known && request.signal.aborted
    if (cancelled) {
      console.warn(`[v1 upload] client disconnected while uploading ${originalFilename}; nothing was imported`)
    } else {
      console.error('v1 upload error:', error)
    }
    logJob({
      source:        'http',
      filename:      originalFilename,
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: error instanceof Error ? error.message : String(error),
    })
    void logUploadAction('upload.api.fail', actor, null, {
      ...keyDetails, filename: originalFilename, error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startAt,
    })
    if (known) {
      return NextResponse.json({ success: false, error: known.message }, { status: known.status })
    }
    if (cancelled) {
      return NextResponse.json({ success: false, error: 'Upload cancelled' }, { status: 400 })
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  } finally {
    if (spool) await discardSpool(spool.path)
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/upload-v1-route-spool.test.ts __tests__/upload-route-spool.test.ts`
Expected: PASS (both files).

- [x] **Step 5: Run the whole suite, typecheck, lint, commit**

```bash
npm test 2>&1 | tail -8 && npx tsc --noEmit && npx eslint --no-eslintrc -c .eslintrc.json app/api/v1/upload/route.ts && git add app/api/v1/upload/route.ts __tests__/upload-v1-route-spool.test.ts && git commit -m "$(cat <<'EOF'
fix(v1-upload): spool the body before queueing, audit with the API key

The v1 route left the request body unread while it waited for a queue slot, so a
wait of more than 300 s (Node's request timeout) or a dropped connection stranded
the request. It now receives the body into the upload spool first, imports from
the file under the stall watchdog, and records upload.api.start/complete/fail with
the key id. The synchronous response is unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: the suite's last lines show every test file passing with 0 failures; typecheck exits 0; ESLint prints nothing; one commit created (the deletion of the old test file is included because it was staged with `git rm`).

---

### Task 8: The inbox watcher imports under the runner; Retry is audited

**Files:**
- Modify: `lib/inbox-watcher.ts`, `app/api/inbox/retry/route.ts`
- Create: `__tests__/inbox-watcher-runner.test.ts`, `__tests__/inbox-retry-audit.test.ts`

**Interfaces:**
- Consumes: `runImportJob` (Task 2); `processTextFile`, `processZipFile` with `hooks` (Task 4); `logUploadAction` (Task 5).
- Produces: inbox imports that fail (and free their queue slot) when they stall; every Retry recorded as `inbox.retry` with the acting user. The watcher's existing structure is unchanged: the memory-guard wait still precedes the claim, the claim is still a rename, an interrupted file still goes to `failed/`.

The existing watcher tests (`inbox-watcher-memory-guard`, `inbox-watcher-stability`, `inbox-content-sniff`, `inbox-watcher-globalthis`) read the watcher's source text and pin the order `uploadQueue(async` → `waitForHeadroom(` → `claimFileForProcessing(filePath, PROC)`. Keep that order.

- [x] **Step 1: Write the failing tests**

Create `__tests__/inbox-watcher-runner.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher: imports run under the stall watchdog', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports runImportJob and processTextFile, and no longer hand-builds a stream', () => {
    expect(source).toMatch(/import\s*\{[^}]*runImportJob[^}]*\}\s*from\s*['"]@\/lib\/import-runner['"]/)
    expect(source).toMatch(/import\s*\{[^}]*processTextFile[^}]*\}\s*from\s*['"]@\/lib\/upload-processor['"]/)
    expect(source).not.toContain('Readable.toWeb')
    expect(source).not.toContain('processTextStream')
  })

  test('both the text and the zip import run inside runImportJob', () => {
    const afterClaim = source.slice(source.indexOf('claimFileForProcessing(filePath, PROC)'))
    expect(afterClaim.match(/runImportJob\(/g)?.length).toBe(2)
    expect(afterClaim).toContain('processZipFile(claimedPath')
    expect(afterClaim).toContain('processTextFile(claimedPath')
  })

  test('the task still clears its in-flight state in a finally, so the slot and the inFlight entry are always released', () => {
    expect(source).toMatch(/finally \{\s*setCurrentProgress\(null\)/)
  })
})
```

Create `__tests__/inbox-retry-audit.test.ts`:

```ts
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '4', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/inbox-helpers', () => ({
  retryFiles: vi.fn().mockReturnValue(['a.txt']),
  retryAllFailed: vi.fn().mockReturnValue(['a.txt', 'b.zip']),
}))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: vi.fn().mockResolvedValue(1) }))

import { logUploadAction } from '@/lib/audit-log'
import { POST } from '@/app/api/inbox/retry/route'

const mockAudit = logUploadAction as ReturnType<typeof vi.fn>
const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/inbox/retry', { method: 'POST', body: JSON.stringify(body) }))
const admin = { id: 4, email: 'admin@example.com' }

beforeEach(() => mockAudit.mockClear())

describe('POST /api/inbox/retry: audit', () => {
  it('records who retried which file', async () => {
    const res = await post({ filename: 'a.txt' })

    expect(res.status).toBe(200)
    expect(mockAudit).toHaveBeenCalledWith('inbox.retry', admin, null, { moved: ['a.txt'], mode: 'one' }, expect.anything())
  })

  it('records a retry of every failed file', async () => {
    await post({ all: true })

    expect(mockAudit).toHaveBeenCalledWith('inbox.retry', admin, null, { moved: ['a.txt', 'b.zip'], mode: 'all' }, expect.anything())
  })

  it('records nothing for a malformed body', async () => {
    const res = await post({ nothing: true })

    expect(res.status).toBe(400)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/inbox-watcher-runner.test.ts __tests__/inbox-retry-audit.test.ts`
Expected: FAIL: the watcher still imports `processTextStream` and builds the stream by hand; the Retry route never calls `logUploadAction`.

- [x] **Step 3: Implement the watcher change**

In `lib/inbox-watcher.ts`, replace the import block

```ts
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import { uploadQueue, queueSize, setCurrentJob } from '@/lib/upload-queue'
import { logJob } from '@/lib/processing-log'
import { processTextStream, processZipFile } from '@/lib/upload-processor'
```

with

```ts
import path from 'path'
import fs from 'fs'
import { uploadQueue, queueSize, setCurrentJob } from '@/lib/upload-queue'
import { logJob } from '@/lib/processing-log'
import { processTextFile, processZipFile } from '@/lib/upload-processor'
import { runImportJob } from '@/lib/import-runner'
```

Then replace this block (the part of the queued task right after the claim):

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
            console.log(
              `[inbox-watcher]   ${result.filename}: ` +
              `imported=${result.imported} skipped=${result.skipped}`
            )
          } else if (result.errors > 0) {
            console.warn(`[inbox-watcher]   ${result.filename}: skipped (entry error)`)
          }
        })
      } else {
        const nodeStream = fs.createReadStream(procPath)
        const webStream  = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
        const result     = await processTextStream(webStream, filename, undefined, n => {
          // onBatch: update live progress after each 500 K-row batch
          const cp = getCurrentProgress()
          if (cp) cp.rows_imported = n
        })
        imported = result.imported
        skipped  = result.skipped
        console.log(
          `[inbox-watcher] done: ${filename} ` +
          `imported=${result.imported} skipped=${result.skipped}`
        )
      }
```

with

```ts
      console.log(`[inbox-watcher] processing: ${filename}`)
      // Capture file size (from the claimed path) for ETA in the status API.
      const claimedPath: string = procPath
      const fileSizeBytes = (() => { try { return fs.statSync(claimedPath).size } catch { return 0 } })()
      setCurrentProgress({ filename, started_at: startAt, rows_imported: 0, file_size_bytes: fileSizeBytes })

      // runImportJob fails the job, and frees this queue slot, if it stops making progress for IMPORT_STALL_TIMEOUT_MS:
      // one wedged import can no longer hold the shared queue until an app restart.
      if (ext === '.zip') {
        await runImportJob({
          label: filename,
          work:  ctx => processZipFile(claimedPath, result => {
            imported += result.imported
            skipped  += result.skipped
            const cp = getCurrentProgress()
            if (cp) cp.rows_imported = imported
            if (result.imported > 0) {
              console.log(
                `[inbox-watcher]   ${result.filename}: ` +
                `imported=${result.imported} skipped=${result.skipped}`
              )
            } else if (result.errors > 0) {
              console.warn(`[inbox-watcher]   ${result.filename}: skipped (entry error)`)
            }
          }, ctx),
        })
      } else {
        const result = await runImportJob({
          label: filename,
          work:  ctx => processTextFile(claimedPath, filename, undefined, n => {
            // onBatch: update live progress after each batch
            const cp = getCurrentProgress()
            if (cp) cp.rows_imported = n
          }, ctx),
        })
        imported = result.imported
        skipped  = result.skipped
        console.log(
          `[inbox-watcher] done: ${filename} ` +
          `imported=${result.imported} skipped=${result.skipped}`
        )
      }
```

The lines that follow (`// Move processing/ -> done/ BEFORE logJob ...`) are unchanged.

- [x] **Step 4: Implement the Retry audit**

In `app/api/inbox/retry/route.ts` add the import

```ts
import { logUploadAction } from '@/lib/audit-log'
```

below the `inbox-helpers` import, and replace the final line of `POST`

```ts
  return NextResponse.json({ success: true, moved })
```

with

```ts
  await logUploadAction(
    'inbox.retry',
    { id: user ? Number(user.userId) : null, email: user?.email || null },
    null,
    { moved, mode: b.all === true ? 'all' : 'one' },
    request,
  )

  return NextResponse.json({ success: true, moved })
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/inbox-watcher-runner.test.ts __tests__/inbox-retry-audit.test.ts __tests__/inbox-watcher-memory-guard.test.ts __tests__/inbox-watcher-stability.test.ts __tests__/inbox-content-sniff.test.ts __tests__/inbox-watcher-globalthis.test.ts`
Expected: PASS (all six files).

- [x] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint --no-eslintrc -c .eslintrc.json lib/inbox-watcher.ts app/api/inbox/retry/route.ts && git add lib/inbox-watcher.ts app/api/inbox/retry/route.ts __tests__/inbox-watcher-runner.test.ts __tests__/inbox-retry-audit.test.ts && git commit -m "$(cat <<'EOF'
feat(inbox): import under the stall watchdog and audit Retry

The inbox watcher shares the upload queue, so one wedged import there held a slot
until an app restart too. Imports now run through runImportJob (and the shared
processTextFile instead of a hand-built stream); a stalled one fails, moves to
failed/ and frees the slot. Inbox Retry is recorded as inbox.retry with the user.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: typecheck exits 0 and ESLint prints nothing; one commit created.

---

### Task 9: The Upload page shows the transfer, then the import

**Files:**
- Create: `lib/upload-client.ts`
- Create: `__tests__/upload-client.test.ts`
- Modify: `app/upload/page.tsx`

**Interfaces:**
- Produces (in `lib/upload-client.ts`, browser-safe, no Node imports):
  - `interface XhrLike` (the subset of `XMLHttpRequest` the helper uses, so tests can fake it)
  - `class UploadNetworkError extends Error { aborted: boolean }`
  - `postFileWithProgress(url: string, file: Blob, onProgress: (loaded: number, total: number) => void, createXhr?: () => XhrLike): Promise<{ status: number; json: any }>`
  - `transferPercent(loaded: number, total: number): number`
  - `uploadErrorMessage(err: unknown, fileSize: number): string`

Why: `fetch` cannot report how many bytes of a request body have been sent; `XMLHttpRequest` can. The server now answers only after it holds the whole file, so without this the page would sit on a static bar for the whole transfer.

- [x] **Step 1: Write the failing tests**

Create `__tests__/upload-client.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import {
  UploadNetworkError,
  postFileWithProgress,
  transferPercent,
  uploadErrorMessage,
  type XhrLike,
} from '@/lib/upload-client'

class FakeXhr implements XhrLike {
  opened: { method: string; url: string } | null = null
  sent: Blob | null = null
  status = 0
  responseText = ''
  upload: XhrLike['upload'] = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  open(method: string, url: string) { this.opened = { method, url } }
  send(body: Blob) { this.sent = body }
  abort() { this.onabort?.() }
}

describe('postFileWithProgress', () => {
  it('posts the file, reports transfer progress and resolves with the parsed reply', async () => {
    const xhr = new FakeXhr()
    const onProgress = vi.fn()
    const file = new Blob(['abc'])

    const promise = postFileWithProgress('/api/upload?filename=a.txt', file, onProgress, () => xhr)
    expect(xhr.opened).toEqual({ method: 'POST', url: '/api/upload?filename=a.txt' })
    expect(xhr.sent).toBe(file)

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 })
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 2, total: 0 }) // ignored: the browser does not know the total
    xhr.status = 200
    xhr.responseText = JSON.stringify({ success: true, jobId: 'j1' })
    xhr.onload?.()

    await expect(promise).resolves.toEqual({ status: 200, json: { success: true, jobId: 'j1' } })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(1, 3)
  })

  it('turns a non-JSON reply into a failure the page can show', async () => {
    const xhr = new FakeXhr()
    const promise = postFileWithProgress('/x', new Blob(['a']), () => {}, () => xhr)
    xhr.status = 502
    xhr.responseText = '<html>Bad gateway</html>'
    xhr.onload?.()

    const { status, json } = await promise
    expect(status).toBe(502)
    expect(json).toEqual({ success: false, error: 'Unexpected response from the server (HTTP 502)' })
  })

  it('rejects with UploadNetworkError when the connection drops, times out or is aborted', async () => {
    const dropped = new FakeXhr()
    const first = postFileWithProgress('/x', new Blob(['a']), () => {}, () => dropped)
    dropped.onerror?.()
    await expect(first).rejects.toBeInstanceOf(UploadNetworkError)

    const timedOut = new FakeXhr()
    const second = postFileWithProgress('/x', new Blob(['a']), () => {}, () => timedOut)
    timedOut.ontimeout?.()
    await expect(second).rejects.toBeInstanceOf(UploadNetworkError)

    const aborted = new FakeXhr()
    const third = postFileWithProgress('/x', new Blob(['a']), () => {}, () => aborted)
    aborted.abort()
    await expect(third).rejects.toMatchObject({ name: 'UploadNetworkError', aborted: true })
  })
})

describe('transferPercent', () => {
  it('rounds, clamps to 100 and tolerates an unknown total', () => {
    expect(transferPercent(1, 3)).toBe(33)
    expect(transferPercent(5, 3)).toBe(100)
    expect(transferPercent(5, 0)).toBe(0)
  })
})

describe('uploadErrorMessage', () => {
  const GiB = 1024 ** 3
  const lost = 'The connection to the server was lost during the upload'

  it('points large files at the inbox when the connection failed', () => {
    expect(uploadErrorMessage(new UploadNetworkError(lost), 2 * GiB))
      .toBe(`${lost}. Files this large are more reliable dropped into the inbox folder.`)
  })

  it('leaves small files and server messages alone', () => {
    expect(uploadErrorMessage(new UploadNetworkError(lost), 10 * 1024 * 1024)).toBe(lost)
    expect(uploadErrorMessage(new Error('File too large (max 10 GB)'), 20 * GiB)).toBe('File too large (max 10 GB)')
    expect(uploadErrorMessage('weird', 1)).toBe('Upload failed')
  })
})

describe('the Upload page', () => {
  const page = readFileSync(new URL('../app/upload/page.tsx', import.meta.url), 'utf8')

  it('uploads through the progress helper, not fetch (fetch cannot report how much of the body was sent)', () => {
    expect(page).toContain('postFileWithProgress(')
    expect(page).not.toMatch(/fetch\(`\/api\/upload\?/)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/upload-client.test.ts`
Expected: FAIL: `Cannot find module '@/lib/upload-client'`.

- [x] **Step 3: Implement the helper**

Create `lib/upload-client.ts`:

```ts
/**
 * Browser-side upload helper for the Upload page.
 *
 * fetch() cannot report how many bytes of a request body have been sent; XMLHttpRequest can. The server now answers an
 * upload only once it holds the whole file (lib/upload-spool.ts), so the page needs this to show the transfer before the
 * import progress (SSE) starts. No Node imports: this runs in the browser.
 */

export interface PostFileResult {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
}

export class UploadNetworkError extends Error {
  readonly aborted: boolean

  constructor(message: string, aborted = false) {
    super(message)
    this.name = 'UploadNetworkError'
    this.aborted = aborted
  }
}

/** The subset of XMLHttpRequest this helper uses, so tests can fake it. */
export interface XhrLike {
  open(method: string, url: string): void
  send(body: Blob): void
  abort(): void
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
  status: number
  responseText: string
}

const LOST = 'The connection to the server was lost during the upload'

export function postFileWithProgress(
  url: string,
  file: Blob,
  onProgress: (loaded: number, total: number) => void,
  createXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): Promise<PostFileResult> {
  return new Promise<PostFileResult>((resolve, reject) => {
    const xhr = createXhr()
    xhr.open('POST', url)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      let json: unknown
      try {
        json = JSON.parse(xhr.responseText)
      } catch {
        json = { success: false, error: `Unexpected response from the server (HTTP ${xhr.status})` }
      }
      resolve({ status: xhr.status, json })
    }
    xhr.onerror = () => reject(new UploadNetworkError(LOST))
    xhr.ontimeout = () => reject(new UploadNetworkError(LOST))
    xhr.onabort = () => reject(new UploadNetworkError('The upload was cancelled', true))
    xhr.send(file)
  })
}

/** Files at least this large are better dropped in the inbox folder when the connection fails. */
export const LARGE_UPLOAD_HINT_BYTES = 1024 ** 3

export function transferPercent(loaded: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
}

/** The message the page shows for a failed upload; a dropped connection on a large file points at the inbox. */
export function uploadErrorMessage(err: unknown, fileSize: number): string {
  const base = err instanceof Error ? err.message : 'Upload failed'
  if (err instanceof UploadNetworkError && fileSize >= LARGE_UPLOAD_HINT_BYTES) {
    return `${base}. Files this large are more reliable dropped into the inbox folder.`
  }
  return base
}
```

- [x] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run __tests__/upload-client.test.ts`
Expected: the helper tests PASS; the last test (`the Upload page`) still FAILS because the page still calls `fetch`.

- [x] **Step 5: Switch the page to the helper**

In `app/upload/page.tsx`:

5a. Add two imports after `import { IngestHealthPanel } from "@/components/ingest-health-panel"`:

```tsx
import { postFileWithProgress, transferPercent, uploadErrorMessage } from "@/lib/upload-client"
import { formatBytes } from "@/lib/utils"
```

5b. Add three state variables directly after `const [elapsedMs, setElapsedMs]       = useState(0)`:

```tsx
  // 'transfer': the browser is still sending the file; 'import': the server holds it and is importing it.
  const [phase, setPhase]             = useState<'transfer' | 'import'>('transfer')
  const [sentBytes, setSentBytes]     = useState({ loaded: 0, total: 0 })
  const [queuedAhead, setQueuedAhead] = useState(0)
```

5c. In `processFileSingle`, replace

```tsx
      setState('uploading')
      setProgress(20)
      setErrorMsg('')

      fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
        .then(r => r.json())
        .then((data: any) => {
          setProgress(90)
          if (!data.success) throw new Error(data.error || 'Upload failed')

          if (data.jobId) {
            // SSE path — resolve when server signals done or error
            setLiveImported(0); setLiveSkipped(0); setLiveTierDropped(0); setLivePct(0); setElapsedMs(0)
```

with

```tsx
      setState('uploading')
      setPhase('transfer')
      setProgress(0)
      setSentBytes({ loaded: 0, total: file.size })
      setQueuedAhead(0)
      setErrorMsg('')

      // The server answers only once it holds the whole file, so the transfer is reported here, by the browser;
      // the import progress (SSE) starts after the reply.
      postFileWithProgress(
        `/api/upload?filename=${encodeURIComponent(file.name)}`,
        file,
        (loaded, total) => {
          setSentBytes({ loaded, total })
          setProgress(transferPercent(loaded, total))
          // Every byte is out: what follows is the server's work (for a .zip the reply only comes when it is done).
          if (total > 0 && loaded >= total) setPhase('import')
        },
      )
        .then(({ json: data }: { json: any }) => {
          setProgress(100)
          setPhase('import')
          if (!data.success) throw new Error(data.error || 'Upload failed')

          if (data.jobId) {
            // SSE path — resolve when server signals done or error
            setQueuedAhead(data.queue_position ?? 0)
            setLiveImported(0); setLiveSkipped(0); setLiveTierDropped(0); setLivePct(0); setElapsedMs(0)
```

and in the same function replace

```tsx
        .catch(err => {
          const msg = err instanceof Error ? err.message : 'Upload failed'
```

with

```tsx
        .catch(err => {
          const msg = uploadErrorMessage(err, file.size)
```

5d. In the "Uploading" card, replace

```tsx
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Importing…
              </span>
              <span className="text-muted-foreground tabular-nums">
                {(elapsedMs / 1000).toFixed(0)}s elapsed
              </span>
            </div>
            {livePct > 0 ? (
```

with

```tsx
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {phase === 'transfer' ? 'Uploading…' : 'Importing…'}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {phase === 'transfer'
                  ? `${formatBytes(sentBytes.loaded)} of ${formatBytes(sentBytes.total)}`
                  : `${(elapsedMs / 1000).toFixed(0)}s elapsed`}
              </span>
            </div>
            {phase === 'import' && queuedAhead > 0 && liveImported === 0 && (
              <p className="text-xs text-muted-foreground">
                Waiting in the import queue: {queuedAhead} ahead of this file.
              </p>
            )}
            {livePct > 0 ? (
```

(The `else` branch `<Progress value={progress} className="h-2" />` is unchanged; it now shows the transfer, then 100% while the import waits for its first batch.)

- [x] **Step 6: Run the tests, typecheck, lint, commit**

```bash
npx vitest run __tests__/upload-client.test.ts && npx tsc --noEmit && npx eslint --no-eslintrc -c .eslintrc.json app/upload/page.tsx lib/upload-client.ts && git add lib/upload-client.ts __tests__/upload-client.test.ts app/upload/page.tsx && git commit -m "$(cat <<'EOF'
feat(upload-page): show the transfer, then the import

The server now answers an upload only after it holds the whole file, so the page
sends it with XMLHttpRequest (fetch cannot report how much of a body was sent):
"Uploading... N of M", then the existing import progress, plus the queue position
when the import has to wait. A dropped connection on a file of 1 GiB or more says
the inbox folder is more reliable.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: all `upload-client` tests PASS (including the page test); typecheck exits 0 and ESLint prints nothing; one commit created.

---

### Task 10: The resilience e2e script on the rehearsal stack

**Files:**
- Create: `scripts/e2e-upload-resilience.ts`
- Modify: `docker-compose.rehearsal.yml` (a 30 s stall timeout for the rehearsal app), `docs/superpowers/specs/2026-10-02-import-reliability-design.md` (make its e2e numbers match)

**Interfaces:**
- Consumes: the running rehearsal stack started by `npx tsx scripts/e2e-alert-rehearsal.ts --keep` (containers `ulprehearsal_app` and `ulprehearsal_clickhouse`, app on `127.0.0.1:3101`), the new image built from this branch, and the `zip` command.
- Produces: one process exit code (0 when every check passes, 1 when a check fails, 2 when the stack is not ready). It never touches the real stack: it refuses any container name that does not start with `ulprehearsal_`.

- [x] **Step 1: Give the rehearsal app a short stall timeout**

In `docker-compose.rehearsal.yml`, in the `app:` service `environment:` block, directly after `CONTENT_DEDUP_APPLY: "false"` add:

```yaml
      # lib/import-runner.ts fails an import with no progress for this long. 30 s (the default is 20 minutes) so that
      # scripts/e2e-upload-resilience.ts can prove the watchdog by freezing ClickHouse for longer than that.
      IMPORT_STALL_TIMEOUT_MS: "30000"
```

Run: `npx vitest run __tests__/rehearsal-isolation.test.ts`
Expected: PASS (the isolation rules are about names, networks, volumes and ports; an env var does not touch them).

- [x] **Step 2: Write the script**

Create `scripts/e2e-upload-resilience.ts`:

```ts
/**
 * End-to-end resilience scenarios for the upload pipeline, against the ISOLATED rehearsal stack
 * (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * Why it exists: on 2026-10-02 four ways to wedge the HTTP upload route were reproduced (an importer that stops reading for
 * 5 s or more, an upload queued behind a busy slot, the 300 s request timeout, a client that disconnects). Each left a job
 * that never finished and held a slot of the shared queue, which also stopped the inbox. The routes now receive the whole
 * file into a spool before they answer (lib/upload-spool.ts) and every import runs under a stall watchdog
 * (lib/import-runner.ts). This script keeps those cases from coming back.
 *
 * The clients are raw sockets, like a browser or curl. Node's own http client (and undici's fetch) stop sending the body once
 * the server has replied, which makes any test written with them look like a server hang.
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-upload-resilience.ts         # about 6 minutes; --slow adds the 300 s slow-client case (+7 minutes)
 *                                                    # (--only-slow runs just that case)
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Needs the `zip` command. Exit 0 when every check passes, 1 when one fails, 2 when the stack is not ready.
 */
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const HOST = '127.0.0.1'
const PORT = 3101
const BASE = `http://${HOST}:${PORT}`
// --only=queue-wait,cut-fin runs just those scenarios (keys: happy cut-fin cut-rst zip-cut queue-wait freeze-8s freeze-stall slow);
// --slow adds the 300 s slow-client case to a full run; --only-slow is --only=slow.
const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length).split(',')
const only = process.argv.includes('--only-slow') ? ['slow'] : onlyArg
const slow = process.argv.includes('--slow')

if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || PORT !== 3101) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}

const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

// --async_insert=0: the default profile buffers inserts, and this script reads what was written straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
const rowsFor = (source: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${source}'`))
const spoolCount = () => Number(sh('docker', ['exec', APP, 'sh', '-c', 'ls /tmp/ulp-spool 2>/dev/null | wc -l']))

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 250): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* not yet */
    }
    await sleep(intervalMs)
  }
  return null
}

// ── login and the app's own view of a job / the queue ─────────────────────────────────────────────────────────────────────────
let cookie = ''

async function login(): Promise<void> {
  const email = sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL'])
  const password = sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD'])
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function queue(): Promise<{ active: number; pending: number; current_file: string | null }> {
  const res = await fetch(`${BASE}/api/upload/queue-status`, { headers: { cookie } })
  return ((await res.json()) as { queue: { active: number; pending: number; current_file: string | null } }).queue
}

type JobEvent = { status: string; imported?: number; error?: string }

/** One SSE frame for the job (a finished job answers at once; a running one pushes a frame every 2 s). */
async function jobSnapshot(jobId: string, waitMs = 4500): Promise<JobEvent> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  try {
    const res = await fetch(`${BASE}/api/upload/progress/${jobId}`, { headers: { cookie }, signal: controller.signal })
    if (res.status !== 200 || !res.body) return { status: `http-${res.status}` }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { status: 'stream-closed' }
      buffer += decoder.decode(value, { stream: true })
      const frame = /^data: (.*)$/m.exec(buffer)
      if (frame) {
        controller.abort()
        return JSON.parse(frame[1]) as JobEvent
      }
    }
  } catch {
    return { status: 'no-event' }
  } finally {
    clearTimeout(timer)
  }
}

async function waitJob(jobId: string, timeoutMs: number): Promise<JobEvent> {
  const end = Date.now() + timeoutMs
  let last: JobEvent = { status: 'no-event' }
  while (Date.now() < end) {
    last = await jobSnapshot(jobId)
    if (last.status === 'done' || last.status === 'error') return last
    await sleep(1000)
  }
  return last
}

async function expectIdleQueue(label: string): Promise<void> {
  const idle = await waitFor(async () => {
    const q = await queue()
    return q.active === 0 && q.pending === 0
  }, 30_000, 500)
  check(`${label}: the queue slot is free again`, !!idle, JSON.stringify(await queue()))
}

// ── fixtures and the raw-socket client ────────────────────────────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'e2e-upload-'))
// Source names are unique per run: the importer skips a filename it has already imported, so a re-run on the same stack
// with fixed names would pass vacuously.
const RUN = Date.now().toString(36)
const fixture = (name: string, text: string) => {
  const path = join(work, name)
  writeFileSync(path, text)
  return path
}
const genLines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `https://shop${i % 500}.example-store.test/login:${tag}${i}@probe-mail.test:Pw-${tag}${i}-Xy!`).join('\n') + '\n'

interface RawUpload {
  readonly size: number
  /** Body bytes the client has written so far. */
  sent: number
  status: number | null
  jobId: string | null
  queuePosition: number | null
  /** Body bytes the client had written when the first byte of the reply arrived. */
  sentAtReply: number | null
  closed: boolean
  cut(how: 'fin' | 'rst'): void
}

/** POST a file the way a browser or curl does: headers, then the body, whatever the server answers meanwhile. */
function rawUpload(filename: string, file: string, opts: { bytesPerSec?: number } = {}): RawUpload {
  const size = statSync(file).size
  const head =
    `POST /api/upload?filename=${encodeURIComponent(filename)} HTTP/1.1\r\n` +
    `Host: ${HOST}:${PORT}\r\nCookie: ${cookie}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${size}\r\n\r\n`
  const sock = net.connect(PORT, HOST)
  sock.setNoDelay(true)
  let reply = ''
  const rs = createReadStream(file, { highWaterMark: opts.bytesPerSec ? Math.max(1024, Math.floor(opts.bytesPerSec / 20)) : 64 * 1024 })
  const up: RawUpload = {
    size, sent: 0, status: null, jobId: null, queuePosition: null, sentAtReply: null, closed: false,
    cut(how) {
      if (how === 'rst') sock.resetAndDestroy()
      else sock.destroy()
      rs.destroy()
    },
  }
  sock.on('data', data => {
    if (reply.length >= 4000) return
    reply += data.toString('latin1')
    if (up.status === null) {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(reply)
      if (status) {
        up.status = Number(status[1])
        up.sentAtReply = up.sent
      }
    }
    const id = /"jobId":"([^"]+)"/.exec(reply)
    if (id) up.jobId = id[1]
    const position = /"queue_position":(\d+)/.exec(reply)
    if (position) up.queuePosition = Number(position[1])
  })
  sock.on('error', () => { /* a cut, or the server closing the connection, surfaces through 'close' */ })
  sock.on('close', () => { up.closed = true })
  sock.write(head)
  rs.on('data', chunk => {
    up.sent += chunk.length
    const accepted = sock.write(chunk)
    if (opts.bytesPerSec) {
      // Throttled: a short pause between chunks is the whole flow control (the socket buffer never fills at these rates).
      rs.pause()
      setTimeout(() => rs.resume(), 50)
    } else if (!accepted) {
      rs.pause()
      sock.once('drain', () => rs.resume())
    }
  })
  rs.on('error', () => {})
  return up
}

async function followUpImports(name: string): Promise<boolean> {
  const up = rawUpload(name, fixture(name, genLines(50, 'fu')))
  const id = await waitFor(() => up.jobId, 30_000)
  const final = id ? await waitJob(id, 30_000) : null
  up.cut('fin')
  return final?.status === 'done' && rowsFor(name) === 50
}

// ── scenarios ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function happyPath(): Promise<void> {
  console.log('\n1. A browser-like client uploads 300,000 lines')
  const name = `e2e-happy-${RUN}.txt`
  const up = rawUpload(name, fixture(name, genLines(300_000, 'hp')))
  const id = await waitFor(() => up.jobId, 120_000)
  check('the server answered with a job id', !!id)
  check('...and only after it had received the whole file', up.sentAtReply === up.size, `the client had written ${up.sentAtReply} of ${up.size} bytes when the reply arrived`)
  const final = id ? await waitJob(id, 120_000) : null
  check('the import finished with status done', final?.status === 'done', JSON.stringify(final))
  check('all 300000 rows are in ClickHouse', rowsFor(name) === 300_000, `rows ${rowsFor(name)}`)
  check('the spool file is gone', spoolCount() === 0)
  up.cut('fin')
  await expectIdleQueue('happy path')
}

async function cutMidBody(how: 'fin' | 'rst'): Promise<void> {
  console.log(`\n2. The client disconnects (${how.toUpperCase()}) while the file is still arriving`)
  const name = `e2e-cut-${how}-${RUN}.txt`
  const up = rawUpload(name, fixture(name, genLines(250_000, `c${how[0]}`)), { bytesPerSec: 2_000_000 })
  await waitFor(() => up.sent >= up.size * 0.4, 60_000, 100)
  up.cut(how)
  await sleep(3000)
  check('no job was created: the server never replied', up.jobId === null && up.status === null)
  check('nothing was imported', rowsFor(name) === 0)
  check('no spool file is left', spoolCount() === 0)
  await expectIdleQueue(`cut ${how}`)
  check('a following upload imports normally', await followUpImports(`e2e-after-cut-${how}-${RUN}.txt`))
}

async function zipCutMidBody(): Promise<void> {
  console.log('\n3. The client disconnects while a .zip archive is still arriving')
  const name = `e2e-cut-${RUN}.zip`
  const entry = `e2e-zip-entry-${RUN}.txt`
  fixture(entry, genLines(900_000, 'zc'))
  sh('zip', ['-q', '-j', join(work, name), join(work, entry)])
  const up = rawUpload(name, join(work, name), { bytesPerSec: 1_500_000 })
  await waitFor(() => up.sent >= up.size * 0.4, 60_000, 100)
  up.cut('fin')
  await sleep(3000)
  check('nothing was imported from the cut archive', rowsFor(entry) === 0)
  check('no spool file is left', spoolCount() === 0)
  await expectIdleQueue('cut zip')
}

async function queuedBehindABusySlot(): Promise<void> {
  console.log('\n4. A second upload arrives while the first is importing (the only queue slot is busy)')
  const a = `e2e-queue-a-${RUN}.txt`
  const b = `e2e-queue-b-${RUN}.txt`
  const fileB = fixture(b, genLines(250_000, 'qb')) // written before A starts, so B's upload begins the moment A is importing
  const upA = rawUpload(a, fixture(a, genLines(700_000, 'qa')))
  const tA = Date.now()
  await waitFor(() => rowsFor(a) >= 100_000, 120_000)
  info('A reached 100000 rows after', `${Date.now() - tA} ms`)
  const tB = Date.now()
  const upB = rawUpload(b, fileB)
  const idB = await waitFor(() => upB.jobId, 60_000, 100)
  const replyMs = Date.now() - tB
  const rowsOfAAtReply = rowsFor(a)
  info('B was answered after', `${replyMs} ms, when A had ${rowsOfAAtReply} rows`)
  check('B was accepted while A was still importing', !!idB && rowsOfAAtReply < 700_000, `A had ${rowsOfAAtReply} rows when B was accepted`)
  check('B was told it is queued', (upB.queuePosition ?? 0) >= 1, `queue_position ${upB.queuePosition}`)
  const finalA = upA.jobId ? await waitJob(upA.jobId, 180_000) : null
  const finalB = idB ? await waitJob(idB, 180_000) : null
  check('A finished (status done) with all 700000 rows', finalA?.status === 'done' && rowsFor(a) === 700_000, `${JSON.stringify(finalA)} rows ${rowsFor(a)}`)
  check('B finished (status done) with all 250000 rows', finalB?.status === 'done' && rowsFor(b) === 250_000, `${JSON.stringify(finalB)} rows ${rowsFor(b)}`)
  upA.cut('fin')
  upB.cut('fin')
  await expectIdleQueue('queue wait')
}

async function clickHouseFrozen(o: { name: string; tag: string; freezeSeconds: number; expectStall: boolean }): Promise<void> {
  const { name, tag, freezeSeconds, expectStall } = o
  console.log(`\n${expectStall ? '6' : '5'}. ClickHouse is frozen for ${freezeSeconds} s in the middle of an import${expectStall ? ' (longer than the 30 s stall timeout)' : ''}`)
  const up = rawUpload(name, fixture(name, genLines(600_000, tag)))
  const id = await waitFor(() => up.jobId, 60_000)
  await waitFor(() => rowsFor(name) >= 100_000, 120_000)
  sh('docker', ['pause', CH])
  let during: JobEvent | null = null
  try {
    if (expectStall) {
      await sleep(40_000)
      during = id ? await jobSnapshot(id) : null // ClickHouse is still frozen here
      await sleep(Math.max(0, freezeSeconds * 1000 - 40_000))
    } else {
      await sleep(freezeSeconds * 1000)
    }
  } finally {
    sh('docker', ['unpause', CH])
  }
  await waitFor(() => chQuery('SELECT 1') === '1', 60_000, 1000)
  up.cut('fin')

  if (expectStall) {
    check('the watchdog failed the job while ClickHouse was still frozen', during?.status === 'error', JSON.stringify(during))
    check('...with the stall reason', /stalled/.test(during?.error ?? ''), during?.error ?? '')
    check('no spool file is left', spoolCount() === 0)
    await expectIdleQueue('after the stall')
    check('the next upload imports normally', await followUpImports(`e2e-after-stall-${RUN}.txt`))
  } else {
    const final = id ? await waitJob(id, 180_000) : null
    check(`the import survived a ${freezeSeconds} s freeze (status done)`, final?.status === 'done', JSON.stringify(final))
    check('...and every row arrived exactly once', rowsFor(name) === 600_000, `rows ${rowsFor(name)}`)
    check('no spool file is left', spoolCount() === 0)
    await expectIdleQueue('after the freeze')
  }
}

async function slowClient(): Promise<void> {
  console.log('\n7. A client so slow that the body cannot arrive within Node\'s 300 s request timeout (--slow, about 7 minutes)')
  const name = `e2e-slow-${RUN}.txt`
  const up = rawUpload(name, fixture(name, genLines(300_000, 'sl')), { bytesPerSec: 70_000 })
  const cutByServer = await waitFor(() => up.closed, 420_000, 1000)
  check('the server cut the connection at its request timeout', !!cutByServer)
  up.cut('fin')
  check('no job was created', up.jobId === null)
  check('nothing was imported', rowsFor(name) === 0)
  check('no spool file is left', spoolCount() === 0)
  await expectIdleQueue('slow client')
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  for (const container of [APP, CH]) {
    let health = ''
    try {
      health = sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', container])
    } catch {
      /* missing */
    }
    if (health !== 'healthy') {
      console.error(`${container} is not running and healthy. Start the rehearsal stack first:\n  npx tsx scripts/e2e-alert-rehearsal.ts --keep`)
      return 2
    }
  }
  try {
    sh('zip', ['-v'])
  } catch {
    console.error('The `zip` command is required (apt install zip).')
    return 2
  }
  let stallMs = ''
  try {
    stallMs = sh('docker', ['exec', APP, 'printenv', 'IMPORT_STALL_TIMEOUT_MS'])
  } catch {
    /* unset */
  }
  if (stallMs !== '30000') {
    console.error('The rehearsal app was not started with IMPORT_STALL_TIMEOUT_MS=30000 (docker-compose.rehearsal.yml). Recreate the stack with the current compose file.')
    return 2
  }

  try {
    await login()
    const scenarios: Array<{ key: string; slowOnly?: boolean; run: () => Promise<void> }> = [
      { key: 'happy', run: happyPath },
      { key: 'cut-fin', run: () => cutMidBody('fin') },
      { key: 'cut-rst', run: () => cutMidBody('rst') },
      { key: 'zip-cut', run: zipCutMidBody },
      { key: 'queue-wait', run: queuedBehindABusySlot },
      { key: 'freeze-8s', run: () => clickHouseFrozen({ name: `e2e-freeze-8s-${RUN}.txt`, tag: 'f8', freezeSeconds: 8, expectStall: false }) },
      { key: 'freeze-stall', run: () => clickHouseFrozen({ name: `e2e-freeze-stall-${RUN}.txt`, tag: 'fs', freezeSeconds: 45, expectStall: true }) },
      { key: 'slow', slowOnly: true, run: slowClient },
    ]
    for (const scenario of scenarios) {
      const selected = only ? only.includes(scenario.key) : scenario.slowOnly ? slow : true
      if (selected) await scenario.run()
    }
  } catch (err) {
    check('the scenarios ran without an unexpected error', false, err instanceof Error ? err.message : String(err))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  return failed.length === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(2)
  },
)
```

- [x] **Step 3: Smoke-test the script without a stack**

Run: `npx tsx scripts/e2e-upload-resilience.ts; echo "exit=$?"`
Expected: it prints `ulprehearsal_app is not running and healthy. Start the rehearsal stack first:` and `exit=2` (this proves the file parses and the preflight works; the scenarios themselves run in Task 11).

- [x] **Step 4: Make the spec agree with the script**

In `docs/superpowers/specs/2026-10-02-import-reliability-design.md`, in the "Verification plan" item 2, replace the clause

`ClickHouse frozen 8 s and 20 s mid-import still completes; frozen longer than a 15 s test stall timeout fails the job with the stall reason and the next upload works after the unfreeze;`

(it may wrap across two lines in the file) with

`ClickHouse frozen 8 s mid-import still completes; frozen 45 s, with the rehearsal stack's 30 s stall timeout, fails the job with the stall reason while ClickHouse is still frozen and the next upload works after the unfreeze;`

Then run: `grep -n "20 s mid-import\|15 s test stall" docs/superpowers/specs/2026-10-02-import-reliability-design.md || echo "spec is consistent"`
Expected: `spec is consistent`.

- [x] **Step 5: Commit**

```bash
npx vitest run __tests__/rehearsal-isolation.test.ts && git add scripts/e2e-upload-resilience.ts docker-compose.rehearsal.yml docs/superpowers/specs/2026-10-02-import-reliability-design.md && git commit -m "$(cat <<'EOF'
test(e2e): rehearse the upload resilience scenarios on the isolated stack

A browser-like raw-socket client uploads a file (the server must reply only after
it holds the whole body), is cut mid-body with FIN and RST (no job, no rows, no
spool file, slot free), is cut mid-zip, queues behind a busy slot (both finish
with every row), and survives ClickHouse frozen 8 s. Frozen 45 s with the
rehearsal's 30 s stall timeout, the watchdog fails the job with the stall reason
while ClickHouse is still frozen and the next upload works. --slow adds the 300 s
request-timeout case. The clients are raw sockets because Node's own http client
stops sending after an early reply and fakes a server hang.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: the isolation test passes; one commit created.

---

### Task 11: Verify, build, rehearse, check in a real browser, release

**Files:** none new. This task runs the whole verification ladder and only then merges and deploys. The live stack is touched only in Steps 8 and 9 and only while it is idle.

- [x] **Step 1: Full suite, typecheck, lint**

```bash
cd /home/cole/ulp-suite && npm test 2>&1 | tail -8 && npx tsc --noEmit && echo "tsc ok" && npm run lint 2>&1 | tail -6
```
Expected: every test file passes with 0 failures (more tests than the 1864 before this work); `tsc ok`; lint reports no errors.

- [x] **Step 2: Tag the current image for rollback, then build the new one**

```bash
cd /home/cole/ulp-suite && docker tag ulp-suite-app:latest "ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz)" && DCFG=$(mktemp -d) && echo '{}' > "$DCFG/config.json" && DOCKER_CONFIG="$DCFG" docker compose build app 2>&1 | tail -12; rm -rf "$DCFG"; docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' | grep ulp-suite-app
```
Expected: the build ends with the image written and tagged `ulp-suite-app:latest`; the listing shows the new `latest` created moments ago and a `rollback-<timestamp>` tag on the previous image. (A scoped `DOCKER_CONFIG` is needed because this laptop's global Docker config has a broken credential store. The live container keeps running the old image until it is recreated in Step 9.)

- [x] **Step 3: Rehearse the existing end-to-end suite on the new image**

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-alert-rehearsal.ts --keep 2>&1 | tail -15
```
Expected: `36 of 36 checks passed.` and the message that the stack was left running.

- [x] **Step 4: Run the new resilience scenarios**

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-upload-resilience.ts 2>&1 | tail -50
```
Expected: every line `PASS` and a final `N of N checks passed.` (about 6 minutes). If a check fails, stop and diagnose before continuing: the failing check names the scenario; the app log is `docker logs ulprehearsal_app --tail 50`.

- [x] **Step 5: Optional slow-client case**

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-upload-resilience.ts --slow 2>&1 | tail -12
```
Expected: the scenario-7 checks pass (about 7 more minutes). Skip only if time-boxed; say so in the hand-off.

- [x] **Step 6: Check the real Upload page in a browser**

Open the in-app browser on `http://127.0.0.1:3101/login` (the rehearsal stack), log in with the throwaway admin (`docker exec ulprehearsal_app printenv ADMIN_EMAIL` / `ADMIN_PASSWORD`), open `/upload`, and drive the page's own file input with a synthetic file (this runs the real component code):

```js
(async () => {
  const lines = Array.from({ length: 200000 }, (_, i) => `https://shop${i % 500}.example-store.test/login:ui${i}@probe-mail.test:Pw-ui${i}-Xy!`)
  const file = new File([lines.join('\n') + '\n'], 'browser-ui.txt', { type: 'text/plain' })
  const input = document.querySelector('input[type=file]')
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return 'started'
})()
```

Then read the page text a few times while it runs. Expected: first `Uploading…` with `N of M` bytes, then `Importing…` with imported counts, then the success summary with 200,000 imported; `docker exec ulprehearsal_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials WHERE source_file='browser-ui.txt'"` prints `200000`.

Then prove a cut from a real browser: in the same tab run

```js
(async () => {
  const xhr = new XMLHttpRequest()
  xhr.open('POST', '/api/upload?filename=browser-cut.txt')
  xhr.upload.onprogress = e => { if (e.loaded > 5e6) xhr.abort() }
  xhr.send(new Blob([new Uint8Array(150 * 1024 * 1024)]))
  return 'started'
})()
```

Expected: after a few seconds `docker exec ulprehearsal_app sh -c 'ls /tmp/ulp-spool 2>/dev/null | wc -l'` prints `0`, `docker exec ulprehearsal_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials WHERE source_file='browser-cut.txt'"` prints `0`, and a following small upload through the page still imports (the slot is free).

- [x] **Step 7: Tear the rehearsal stack down**

```bash
cd /home/cole/ulp-suite && D=$(mktemp -d) && echo '{}' > "$D/config.json" && DOCKER_CONFIG="$D" REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v 2>&1 | tail -3; rm -rf "$D"; docker ps -a --format '{{.Names}}' | grep -i rehearsal || echo "no rehearsal containers"; docker volume ls --format '{{.Name}}' | grep -i rehearsal || echo "no rehearsal volumes"
```
Expected: `no rehearsal containers` and `no rehearsal volumes`. Close the browser tab.

- [x] **Step 8: Merge to main and push**

```bash
cd /home/cole/ulp-suite && git status --short && git switch main && git merge --ff-only feat/import-reliability && git push origin main && git log --oneline -12
```
Expected: only `?? .claude/` in the status; a fast-forward merge; the push succeeds. Then confirm CI: `gh run list --branch main --limit 3` (the newest run is for this push; wait for it to finish and read the result with `gh run view <id>`; CI runs `npm ci`, typecheck, tests and lint).

- [x] **Step 9: Deploy to the live local stack, only while it is idle**

First prove it is idle (all three must be empty/zero):

```bash
cd /home/cole/ulp-suite && ls -A inbox inbox/processing 2>/dev/null | grep -v '^done$\|^failed$\|^processing$' || echo "inbox empty"; docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.processes WHERE query_kind = 'Insert'"
```
Expected: `inbox empty` and `0`. If anything is importing, wait for it to finish (do not deploy mid-import).

Then recreate only the app container from the main checkout:

```bash
cd /home/cole/ulp-suite && DCFG=$(mktemp -d) && echo '{}' > "$DCFG/config.json" && DOCKER_CONFIG="$DCFG" docker compose up -d app 2>&1 | tail -5; rm -rf "$DCFG"; until [ "$(docker inspect -f '{{.State.Health.Status}}' ulpsuite_app)" = healthy ]; do sleep 3; done; docker inspect -f '{{.Image}}' ulpsuite_app | cut -c1-19; docker images --no-trunc --format '{{.ID}} {{.Tag}}' | grep ' latest$' | grep ulp | cut -c1-19
```
Expected: `ulpsuite_app` becomes healthy and the two printed image ids match (the container runs the new `latest`).

Verify:

```bash
docker logs --tail 40 ulpsuite_app 2>&1 | grep -E "inbox-watcher|content-dedup|upload-spool|rror" ; for p in "api/upload?filename=x.txt" "api/v1/upload?filename=x.txt"; do curl -s -o /dev/null -w "POST /$p -> %{http_code}\n" -X POST "http://127.0.0.1:3000/$p"; done; curl -s -o /dev/null -w "GET /upload -> %{http_code}\n" http://127.0.0.1:3000/upload; docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT (SELECT count() FROM ulp.credentials), (SELECT count() FROM ulp.sources)"
```
Expected: the log shows the inbox watcher started and no errors; both POSTs answer `401`, `/upload` answers `307` (login redirect); the row counts are unchanged from before the deploy (1394459025 and 251). Rollback if anything is wrong: `docker tag ulp-suite-app:rollback-<timestamp> ulp-suite-app:latest` and repeat the `up -d app` command.

- [x] **Step 10: Record the result**

Update the project memory notes (the import-verification memory and the ledger: the four defects are fixed and deployed, the commit range, the image rollback tag, what is still open: sub-project 2) and tell the user what to try: upload a small file from the Upload page (it should show "Uploading…" then "Importing…"), and that the inbox remains the right path for very large files. Mark the spec `Status: implemented 2026-10-02` with the merge commit.

---

## Execution notes (what differed from the plan as written)

Executed inline on 2026-10-02 on `feat/import-reliability`. The plan's code was applied as written except for the fixes below. Each was found by a test or a run and is already folded into the code blocks above.

- `runImportJob` refuses to start the work when the external signal is already aborted (the plan's own test showed an instantly-resolving job could win the race against an already-rejected abort promise).
- `sweepSpool` clamps a negative file age to zero (a file written in the same millisecond has an mtime a fraction ahead of `Date.now()`, so `maxAgeMs: 0` removed nothing).
- The browser-route test waits for the mock's asynchronous read of the spool file.
- The Upload page switches its label to "Importing…" once the last byte has been sent: a ZIP is imported before the server replies.
- `scripts/e2e-upload-resilience.ts`: source names are unique per run (the importer skips a filename it has already imported, so a re-run on one stack passed vacuously and the queue-wait scenario failed); `--only=<keys>` and `--only-slow` select scenarios; the queue-wait scenario prints its timings; the throttled client no longer piles up `drain` listeners.

Verified before merging: 135 test files / 1931 tests, `tsc`, lint; the image built; the rehearsal suite 36/36; the resilience scenarios 33/33 (twice; the second time with unique names) plus the 300 s slow-client case 5/5; the real Upload page driven in a browser ("Uploading… 0 Bytes of 15.39 MB", then "Importing…", 200,000 rows imported, audit rows carrying the admin's email); a browser-side abort at 29 MB of a 150 MB body left no spool file and no rows, and the next upload imported.

Released 2026-10-02: fast-forwarded to `main` (`6db72ed..cf29ad1`), pushed, CI green (54 s). The live app was idle (inbox empty, 0 running inserts, no import in the last 6 hours), so only `ulpsuite_app` was recreated, from image `2d6ba2bcf747` (rollback image `ulp-suite-app:rollback-20261002-1813z` = the previous `b1402ea387f2`). After the deploy: healthy, all five crons and the inbox watcher started, `POST /api/upload` and `/api/v1/upload` answer 401 without credentials, `/upload` redirects to login, the data is untouched (1,394,459,025 credentials, 251 sources). The new settings are forwarded empty, so the code defaults apply (20 minute stall timeout, `/tmp/ulp-spool`, 20 GiB free-space floor); `UPLOAD_CONCURRENCY` stays 2. Not exercised live: an authenticated upload (needs the owner's session).
