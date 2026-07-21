# Ingest Memory Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop large ClickHouse imports from tripping `OvercommitTracker` by having the app watch ClickHouse's own memory tracker and pace itself, instead of firing inserts into an already-stressed server and only reacting after a batch fails.

**Architecture:** A new pure module (`lib/clickhouse-memory-guard.ts`) polls `system.metrics.MemoryTracking` against `system.server_settings.max_server_memory_usage` — the same two numbers ClickHouse's own `OvercommitTracker` compares — and pauses with backoff when the ratio crosses a threshold. It's wired into the two places large imports actually push data: the batch-insert loop shared by inbox + HTTP upload, and the inbox watcher's file-claim step. Paired with a modest, evidence-backed increase to ClickHouse's memory ceiling.

**Tech Stack:** TypeScript, Next.js (standalone build), `@clickhouse/client`, Vitest, Docker Compose, ClickHouse 26.3.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md` — read it for full context/rationale before starting.
- Do not change `UPLOAD_BATCH_SIZE`, the single-file (`pLimit(1)`) concurrency model, or any ClickHouse setting other than `max_server_memory_usage`.
- The guard must be fail-open: any error checking pressure, or exceeding the wait budget while still over threshold, must let the import proceed rather than throw or hang. This is a pacing layer, not a correctness dependency.
- Test framework is Vitest (`npm test` runs `vitest run`). Match existing conventions in `__tests__/`: `vi.hoisted` for mock fns, `vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({...}) }))`, `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` for anything timing-based.
- `lib/inbox-watcher.ts` is not directly executed in tests (it's coupled to chokidar/fs/globals) — its existing test (`__tests__/inbox-watcher-stability.test.ts`) asserts wiring by reading and pattern-matching the raw source text instead. Follow that same convention for the new inbox-watcher test rather than trying to execute `enqueueFile`.

---

### Task 1: `lib/clickhouse-memory-guard.ts` — the backpressure module

**Files:**
- Create: `lib/clickhouse-memory-guard.ts`
- Test: `__tests__/clickhouse-memory-guard.test.ts`

**Interfaces:**
- Produces: `checkMemoryPressure(signal: AbortSignal): Promise<MemoryPressure>`, `waitForHeadroom(signal: AbortSignal, opts?: { thresholdRatio?: number; maxWaitMs?: number; pollIntervalMs?: number }): Promise<void>`, and the exported `MemoryPressure` interface (`{ usedBytes: number; ceilingBytes: number; ratio: number }`) — Tasks 2 and 3 import `waitForHeadroom` from this file.
- Consumes: `getClient` from `@/lib/clickhouse`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/clickhouse-memory-guard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  query: vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ query: h.query }) }))

const pressureResult = (used: number, ceiling: number) =>
  h.query.mockResolvedValue({ json: async () => [{ used: String(used), ceiling: String(ceiling) }] })

beforeEach(() => {
  h.query.mockReset()
})

describe('checkMemoryPressure', () => {
  it('computes the ratio of MemoryTracking to max_server_memory_usage', async () => {
    pressureResult(9_000_000_000, 18_000_000_000)
    const { checkMemoryPressure } = await import('@/lib/clickhouse-memory-guard')

    const result = await checkMemoryPressure(new AbortController().signal)

    expect(result).toEqual({ usedBytes: 9_000_000_000, ceilingBytes: 18_000_000_000, ratio: 0.5 })
  })

  it('passes the abort signal through to the query', async () => {
    pressureResult(1, 2)
    const { checkMemoryPressure } = await import('@/lib/clickhouse-memory-guard')
    const controller = new AbortController()

    await checkMemoryPressure(controller.signal)

    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ abort_signal: controller.signal }))
  })
})

describe('waitForHeadroom', () => {
  it('resolves immediately when ratio is under threshold', async () => {
    pressureResult(1_000_000_000, 18_000_000_000) // ~5.5%
    const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')

    await waitForHeadroom(new AbortController().signal, { thresholdRatio: 0.75 })

    expect(h.query).toHaveBeenCalledTimes(1)
  })

  it('polls until the ratio drops below threshold, then resolves', async () => {
    vi.useFakeTimers()
    h.query
      .mockResolvedValueOnce({ json: async () => [{ used: '16000000000', ceiling: '18000000000' }] }) // ~0.89
      .mockResolvedValueOnce({ json: async () => [{ used: '16000000000', ceiling: '18000000000' }] }) // ~0.89
      .mockResolvedValueOnce({ json: async () => [{ used: '9000000000',  ceiling: '18000000000' }] }) // 0.5

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')
      const promise = waitForHeadroom(new AbortController().signal, {
        thresholdRatio: 0.75, pollIntervalMs: 5_000, maxWaitMs: 60_000,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await promise

      expect(h.query).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails open when the pressure check itself throws', async () => {
    h.query.mockRejectedValue(new Error('connection refused'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')

      await expect(waitForHeadroom(new AbortController().signal)).resolves.toBeUndefined()
      expect(h.query).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('fails open once maxWaitMs elapses while still over threshold', async () => {
    vi.useFakeTimers()
    h.query.mockResolvedValue({ json: async () => [{ used: '17000000000', ceiling: '18000000000' }] }) // ~0.94, always over
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')
      const promise = waitForHeadroom(new AbortController().signal, {
        thresholdRatio: 0.75, pollIntervalMs: 5_000, maxWaitMs: 12_000,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await promise

      expect(h.query.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('wait budget')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/clickhouse-memory-guard.test.ts`
Expected: FAIL — `Cannot find module '@/lib/clickhouse-memory-guard'`

- [ ] **Step 3: Write the implementation**

Create `lib/clickhouse-memory-guard.ts`:

```ts
/**
 * Memory-aware backpressure for the ingest pipeline.
 *
 * Polls ClickHouse's own memory tracker (system.metrics.MemoryTracking)
 * against its configured ceiling (system.server_settings.max_server_memory_usage)
 * -- the same two numbers OvercommitTracker itself compares before killing a
 * query -- so imports can pace themselves ahead of a kill instead of reacting
 * to one after the fact.
 *
 * See docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md.
 */

import { getClient } from '@/lib/clickhouse'

export interface MemoryPressure {
  usedBytes:    number
  ceilingBytes: number
  ratio:        number
}

const DEFAULT_THRESHOLD_RATIO  = Number(process.env.MEMORY_GUARD_THRESHOLD_RATIO ?? '0.75')
const DEFAULT_MAX_WAIT_MS      = Number(process.env.MEMORY_GUARD_MAX_WAIT_MS ?? String(10 * 60 * 1_000))
const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Live snapshot of ClickHouse's own memory tracker vs. its configured ceiling. */
export async function checkMemoryPressure(signal: AbortSignal): Promise<MemoryPressure> {
  const res = await getClient().query({
    query: `
      SELECT
        (SELECT value FROM system.metrics WHERE metric = 'MemoryTracking')                AS used,
        (SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage') AS ceiling
    `,
    format:       'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: {
      use_query_cache: 0,
    },
  })
  const rows = await res.json() as Array<{ used: string | number; ceiling: string | number }>
  const usedBytes    = Number(rows[0]?.used ?? 0)
  const ceilingBytes = Number(rows[0]?.ceiling ?? 0)
  const ratio         = ceilingBytes > 0 ? usedBytes / ceilingBytes : 0
  return { usedBytes, ceilingBytes, ratio }
}

/**
 * Polls checkMemoryPressure until the ratio drops below threshold, or
 * maxWaitMs elapses -- whichever comes first. Fail-open: any error from
 * checkMemoryPressure, or exceeding maxWaitMs while still above threshold,
 * resolves immediately rather than throwing or hanging. This is a soft
 * pacing layer, not a correctness dependency -- the existing
 * withClickHouseRetry safety net (lib/clickhouse-retry.ts) still covers a
 * batch that fails despite backpressure.
 */
export async function waitForHeadroom(
  signal: AbortSignal,
  opts: { thresholdRatio?: number; maxWaitMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const thresholdRatio = opts.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const maxWaitMs      = opts.maxWaitMs      ?? DEFAULT_MAX_WAIT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const deadline = Date.now() + maxWaitMs
  let warned = false

  while (true) {
    let pressure: MemoryPressure
    try {
      pressure = await checkMemoryPressure(signal)
    } catch (err) {
      console.warn(
        '[clickhouse-memory-guard] pressure check failed, proceeding:',
        err instanceof Error ? err.message : String(err)
      )
      return
    }

    if (pressure.ratio < thresholdRatio) return

    if (Date.now() >= deadline) {
      console.warn(
        `[clickhouse-memory-guard] wait budget (${maxWaitMs}ms) exceeded at ` +
        `ratio ${pressure.ratio.toFixed(2)} -- proceeding anyway`
      )
      return
    }

    if (!warned) {
      console.warn(
        `[clickhouse-memory-guard] ClickHouse memory pressure ${(pressure.ratio * 100).toFixed(0)}% >= ` +
        `${(thresholdRatio * 100).toFixed(0)}% threshold -- pausing before next batch`
      )
      warned = true
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/clickhouse-memory-guard.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/clickhouse-memory-guard.ts __tests__/clickhouse-memory-guard.test.ts
git commit -m "feat(ingest): add ClickHouse memory-pressure backpressure guard"
```

---

### Task 2: Wire the guard into the batch-insert loop

**Files:**
- Modify: `lib/upload-processor.ts`
- Modify: `__tests__/upload-processor.test.ts`

**Interfaces:**
- Consumes: `waitForHeadroom(signal: AbortSignal): Promise<void>` from Task 1's `lib/clickhouse-memory-guard.ts`.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/upload-processor.test.ts`, as a new `describe` block (place it near the existing `describe('live ingest-metrics wiring', ...)` block, same file):

```ts
describe('memory-guard wiring', () => {
  it('streamCredentialsToTable calls waitForHeadroom once per batch, before the insert', async () => {
    vi.resetModules()
    const callOrder: string[] = []
    const guard = { waitForHeadroom: vi.fn().mockImplementation(async () => { callOrder.push('guard') }) }
    vi.doMock('@/lib/clickhouse-memory-guard', () => guard)
    h.insert.mockImplementation(async () => { callOrder.push('insert') })

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      await processTextStream(
        Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
        'guard-wiring.txt',
      )

      expect(guard.waitForHeadroom).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['guard', 'insert'])
    } finally {
      vi.doUnmock('@/lib/clickhouse-memory-guard')
      vi.resetModules()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/upload-processor.test.ts -t "memory-guard wiring"`
Expected: FAIL — `guard.waitForHeadroom` was called 0 times

- [ ] **Step 3: Implement**

In `lib/upload-processor.ts`, add the import alongside the other `@/lib/*` imports near the top of the file:

```ts
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
```

In `streamCredentialsToTable`'s batch loop, immediately before the existing `const tInsert = performance.now()` / `await insertBatch(...)` lines:

```ts
      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
```

becomes:

```ts
      const guardController = new AbortController()
      await waitForHeadroom(guardController.signal)

      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/upload-processor.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Commit**

```bash
git add lib/upload-processor.ts __tests__/upload-processor.test.ts
git commit -m "feat(ingest): pace batch inserts on ClickHouse memory pressure"
```

---

### Task 3: Wire the guard into the inbox file claim

**Files:**
- Modify: `lib/inbox-watcher.ts`
- Create: `__tests__/inbox-watcher-memory-guard.test.ts`

**Interfaces:**
- Consumes: `waitForHeadroom(signal: AbortSignal): Promise<void>` from Task 1's `lib/clickhouse-memory-guard.ts`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/inbox-watcher-memory-guard.test.ts` (source-text assertions, matching the existing convention in `__tests__/inbox-watcher-stability.test.ts` for this same file — `lib/inbox-watcher.ts` is coupled to chokidar/fs/globals and isn't directly executed in tests):

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher — memory-aware backpressure wiring', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports waitForHeadroom from lib/clickhouse-memory-guard', () => {
    expect(source).toMatch(/import\s*\{[^}]*waitForHeadroom[^}]*\}\s*from\s*['"]@\/lib\/clickhouse-memory-guard['"]/)
  })

  test('enqueueFile calls waitForHeadroom before claimFileForProcessing', () => {
    const fnStart = source.indexOf('uploadQueue(async')
    const claimIdx = source.indexOf('claimFileForProcessing(filePath, PROC)')
    expect(fnStart).toBeGreaterThan(-1)
    expect(claimIdx).toBeGreaterThan(fnStart)

    const fn = source.slice(fnStart, claimIdx)
    expect(fn).toContain('waitForHeadroom(')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/inbox-watcher-memory-guard.test.ts`
Expected: FAIL — source does not contain `waitForHeadroom`

- [ ] **Step 3: Implement**

In `lib/inbox-watcher.ts`, add the import alongside the other `@/lib/*` imports near the top of the file:

```ts
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
```

Inside `enqueueFile`'s `uploadQueue(async () => { ... })` callback, immediately before the existing claim comment/call:

```ts
    let imported = 0
    let skipped  = 0
    let procPath: string | null = null
    try {
      // CLAIM: atomically move the file out of inbox/ into processing/ BEFORE
```

becomes:

```ts
    let imported = 0
    let skipped  = 0
    let procPath: string | null = null
    try {
      const guardController = new AbortController()
      await waitForHeadroom(guardController.signal)

      // CLAIM: atomically move the file out of inbox/ into processing/ BEFORE
```

(The rest of the `try` block — the `claimFileForProcessing` call and everything after — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/inbox-watcher-memory-guard.test.ts __tests__/inbox-watcher-stability.test.ts __tests__/inbox-watcher-globalthis.test.ts`
Expected: PASS (all tests in all three files — confirms the new wiring didn't break the existing stability-check wiring test, since both now run before the claim)

- [ ] **Step 5: Commit**

```bash
git add lib/inbox-watcher.ts __tests__/inbox-watcher-memory-guard.test.ts
git commit -m "feat(ingest): pace new-file claims on ClickHouse memory pressure"
```

---

### Task 4: Raise the ClickHouse memory ceiling

**Files:**
- Modify: `docker/clickhouse/config/ulp-performance.xml`
- Modify: `docker-compose.yml`

**Interfaces:** None — config-only change, no code interfaces.

- [ ] **Step 1: Update the memory ceiling and its rationale comment**

In `docker/clickhouse/config/ulp-performance.xml`, replace the `<!-- ── Memory ceiling ── -->` comment block and its setting:

```xml
    <!-- ── Memory ceiling ────────────────────────────────────────────────────────
         UNRESOLVED: whether mark_cache/uncompressed_cache bytes are counted inside
         max_server_memory_usage's own hard limit, or only show up in real container
         RSS outside of it, is NOT settled — see the 2026-06-27 memory-pressure
         investigation notes. The enforced ceiling has actually measured ~14.05 GiB
         in production (twice: 2026-06-21 and 2026-06-27), 2 GiB below this 16 GiB
         setting, which is consistent with caches counting inside it — but a prior
         2026-06-07 fix (commit 6fced4c) was itself motivated by a real cgroup
         OOM-kill that's only explainable if caches are real RSS OUTSIDE this limit.
         Don't raise max_server_memory_usage based on either theory alone without
         verifying directly against this host (compare system.metrics
         'MemoryTracking' + system.asynchronous_metrics cache bytes against actual
         process RSS) — under the OOM-motivated model, raising it without also
         raising the container's mem_limit (docker-compose.yml, currently 20g)
         would remove the safety margin that fix was protecting.

         max_server_memory_usage covers: query execution, query result cache,
         query condition cache, background merge buffers, connection overhead. -->
    <max_server_memory_usage>17179869184</max_server_memory_usage>      <!-- 16 GB -->
```

with:

```xml
    <!-- ── Memory ceiling ────────────────────────────────────────────────────────
         RESOLVED 2026-07-20 (see docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md):
         verified live that system.metrics 'MemoryTracking' (612 MB at idle) and
         the container's actual cgroup RSS (11 GB at idle, from
         /sys/fs/cgroup/memory.current) are NOT the same number — the ~10 GB gap
         is Linux page cache from reading/writing ClickHouse's data files, which
         cgroup v2 counts in memory.current but is reclaimable and outside
         MemoryTracking. mark_cache (256 MB) + uncompressed_cache (512 MB) cannot
         explain a 10 GB gap either. MemoryTracking vs. max_server_memory_usage is
         a real, independent, allocator-level ceiling, not conflated with page
         cache or those caches.

         Raised 16 GB → 18 GB on that basis: idle usage is 612 MB against either
         ceiling, so there was real headroom. 2 GB margin kept under the
         container's hard 20 GB mem_limit (docker-compose.yml) intentionally — if
         ClickHouse's own tracked usage ever did reach this ceiling, the
         alternative to OvercommitTracker gracefully killing one query is the
         kernel cgroup-OOM-killing the entire server process, the failure mode
         the 2026-06-07 fix (commit 6fced4c) was protecting against. As of this
         change, imports also proactively back off before reaching this ceiling
         (lib/clickhouse-memory-guard.ts, default threshold 75% = ~13.5 GB).

         max_server_memory_usage covers: query execution, query result cache,
         query condition cache, background merge buffers, connection overhead. -->
    <max_server_memory_usage>19327352832</max_server_memory_usage>      <!-- 18 GB -->
```

- [ ] **Step 2: Update the matching comment in docker-compose.yml**

In `docker-compose.yml`, the `clickhouse` service's memory comment:

```yaml
    # Memory: 32 GB total — 20 GB ClickHouse + 8 GB App + 4 GB OS/kernel headroom.
    # Whether mark_cache (256 MB) + uncompressed_cache (512 MB) count inside or
    # outside max_server_memory_usage (16 GB) is unresolved — see the memory
    # ceiling comment in ulp-performance.xml before changing any of these values.
    mem_limit: 20g
```

becomes:

```yaml
    # Memory: 32 GB total — 20 GB ClickHouse + 8 GB App + 4 GB OS/kernel headroom.
    # max_server_memory_usage (ulp-performance.xml) is 18 GB, 2 GB under this
    # container limit intentionally — see the memory ceiling comment there for
    # the live verification behind that number.
    mem_limit: 20g
```

- [ ] **Step 3: Commit**

```bash
git add docker/clickhouse/config/ulp-performance.xml docker-compose.yml
git commit -m "fix(clickhouse): raise memory ceiling 16GB->18GB with live-verified rationale"
```

---

### Task 5: Deploy and recover the stuck files

**Files:** None (operational task — rebuild, restart, verify through the running system).

**Interfaces:** None.

- [ ] **Step 1: Run the full test suite before deploying**

Run: `npm test`
Expected: PASS (all tests, including the new ones from Tasks 1-3)

- [ ] **Step 2: Rebuild and restart both containers**

```bash
docker compose build app
docker compose up -d clickhouse app
```

Expected: both containers report healthy. Verify:

```bash
docker compose ps
```

Expected: `ulpsuite_clickhouse` and `ulpsuite_app` both show `(healthy)`. This is also the check for whether Task 4's XML edit was well-formed — ClickHouse fails to start on malformed `config.d/` XML, so a healthy container here confirms it parsed correctly; no separate validation step needed.

- [ ] **Step 3: Confirm the new memory ceiling took effect**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage'"
```

Expected: `19327352832`

- [ ] **Step 4: Retry one stuck file first, not all 11**

In the Inbox Monitor UI (`/inbox`), click the per-file **Retry** button (not **Retry All**) on one of the memory-limit-failed files (e.g. `DUMP ULP 18.05.2026 Base34 1.txt`) — or via API:

```bash
curl -sS -X POST http://localhost:3000/api/inbox/retry \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <admin-token>" \
  -d '{"filename": "DUMP ULP 18.05.2026 Base34 1.txt"}'
```

Watch for the new guard's log lines while it processes:

```bash
docker compose logs app -f --tail=0 | grep -i "clickhouse-memory-guard\|inbox-watcher"
```

Expected: either no `clickhouse-memory-guard` lines (pressure stayed under threshold throughout) or occasional `pausing before next batch` lines followed by processing continuing — and no `(total) memory limit exceeded` or `Timeout exceeded while reading from socket` errors.

- [ ] **Step 5: Confirm it landed in done/, not failed/**

```bash
ls inbox/done/ inbox/failed/
```

Expected: `DUMP ULP 18.05.2026 Base34 1.txt` is now in `inbox/done/`, no longer in `inbox/failed/`.

Cross-check the job log. Note: `-w /app` is required — Node resolves `require('better-sqlite3')` relative to the working directory for an inline `-e` script, and the module only exists under `/app/node_modules`:

```bash
docker exec -w /app ulpsuite_app node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/ulp.db', { readonly: true });
console.log(db.prepare(\"SELECT filename, status, imported, error_message FROM processing_jobs WHERE filename = ? ORDER BY id DESC LIMIT 1\").get('DUMP ULP 18.05.2026 Base34 1.txt'));
"
```

Expected: `status: 'done'`, `imported` > 0, `error_message: null`.

- [ ] **Step 6: Retry the remaining files**

Once step 5 confirms a clean success, click **Retry All** in the Inbox Monitor UI (or `POST /api/inbox/retry` with `{"all": true}`) to queue the remaining 10. They process sequentially (`pLimit(1)`).

Expected outcome per the design doc: 9 more land in `inbox/done/`; the `.08`-extension file (`🐊 TG @KURZL0GS_UP - 29.04.2026 - ULP PRIVATE.08`) bounces straight back to `inbox/failed/` with the same "unsupported extension" message — expected, not a regression.

- [ ] **Step 7: Final verification**

```bash
ls inbox/failed/
```

Expected: only the `.08` file remains.
