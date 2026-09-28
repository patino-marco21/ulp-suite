# ClickHouse Disk-Headroom Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, fail-closed disk-headroom guard for heavy ClickHouse write operations, and wire it into `lib/content-dedup.ts`'s populate step as its first real consumer.

**Architecture:** A new `lib/clickhouse-disk-guard.ts` module mirrors `lib/clickhouse-memory-guard.ts`'s shape (query ClickHouse's own system tables — the app container has no direct filesystem access to the ClickHouse data volume) but is deliberately fail-closed rather than fail-open, and is a small stateful object (`DiskGuard`) rather than stateless functions, since the growth projection needs to remember the starting reading across calls within one run. Integration into content-dedup extracts a small, dependency-injected helper function so it stays independently unit-testable without mocking the whole ClickHouse client.

**Tech Stack:** TypeScript, Vitest, `@clickhouse/client`. No new dependencies.

## Global Constraints

- Fail-closed: any error from the underlying `system.disks` query must become a `DiskHeadroomError(reason: 'check-failed')`, never "proceed anyway" — this is the opposite of `clickhouse-memory-guard.ts`'s fail-open default, and is deliberate (see spec).
- Query exactly `SELECT unreserved_space, total_space FROM system.disks WHERE name = 'default'` — this container has a single disk named `default` (confirmed live 2026-09-28); use `unreserved_space`, not `free_space` (the former accounts for ClickHouse's own pending reservations, more conservative).
- Floor formula: `effectiveFloorBytes = max(minFreeBytes, minFreeRatio × totalBytes)` — "whichever is stricter."
- Env vars: `DISK_GUARD_MIN_FREE_BYTES` (default `50 * 1024**3` = 53687091200, i.e. 50 GiB) and `DISK_GUARD_MIN_FREE_RATIO` (default `0.15`).
- Only wire into `lib/content-dedup.ts`'s populate step (`runContentDedupTick`'s step 5). Do not touch the stats pass, the verify pass, `scripts/backfill-credential-dedup.sh`, or anything else — all out of scope per the spec.
- Any new `console.*` call this work adds must use `console.warn`, never `console.log` — see `docs/superpowers/specs/2026-09-28-clickhouse-disk-headroom-guard-design.md`'s reference to `[[project_removeconsole_strips_logs]]`: `console.log` is stripped from this project's production build entirely.
- `AbortSignal` parameters must be optional (`?:` where the signal is the last/only parameter, or typed `AbortSignal | undefined` in required position when a required parameter follows it) — this codebase's actual call site (`runContentDedupTick`, cron-triggered, not request-triggered) has no `AbortSignal` available anywhere in its call chain, unlike `clickhouse-memory-guard.ts`'s callers.
- On a `DiskHeadroomError` during the populate loop, drop the partial `AUTO_DEDUP_TABLE` immediately before re-throwing — don't leave it for the next day's tick to clean up.

---

## Task 1: Pure floor and projection logic

**Files:**
- Create: `lib/clickhouse-disk-guard.ts`
- Test: `__tests__/clickhouse-disk-guard.test.ts`

**Interfaces:**
- Produces: `DiskHeadroom { freeBytes: number, totalBytes: number, ratio: number }`, `DiskGuardOptions { minFreeBytes?: number, minFreeRatio?: number }`, `IterationContext { index: number, total: number }`, `DiskHeadroomReason = 'floor-breached' | 'projected-breach' | 'check-failed'`, `class DiskHeadroomError extends Error` with readonly `headroom: DiskHeadroom | null`, `effectiveFloorBytes: number | null`, `reason: DiskHeadroomReason`, `formatBytes(bytes: number): string`, `resolveDiskGuardOptions(opts?: DiskGuardOptions, env?: NodeJS.ProcessEnv): Required<DiskGuardOptions>`, `computeEffectiveFloorBytes(opts: Required<DiskGuardOptions>, totalBytes: number): number`, `type ProjectionResult = { trip: false } | { trip: true; reason: 'floor-breached' | 'projected-breach' }`, `checkProjection(params): ProjectionResult`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/clickhouse-disk-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  formatBytes,
  resolveDiskGuardOptions,
  computeEffectiveFloorBytes,
  checkProjection,
} from '@/lib/clickhouse-disk-guard'

describe('formatBytes', () => {
  it('renders GiB to two decimal places', () => {
    expect(formatBytes(50 * 1024 ** 3)).toBe('50.00 GiB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GiB')
  })
})

describe('resolveDiskGuardOptions', () => {
  it('defaults to 50 GiB / 0.15 when nothing is set', () => {
    const resolved = resolveDiskGuardOptions({}, {})
    expect(resolved).toEqual({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.15 })
  })

  it('honors explicit options over env', () => {
    const resolved = resolveDiskGuardOptions(
      { minFreeBytes: 1000, minFreeRatio: 0.5 },
      { DISK_GUARD_MIN_FREE_BYTES: '999', DISK_GUARD_MIN_FREE_RATIO: '0.99' },
    )
    expect(resolved).toEqual({ minFreeBytes: 1000, minFreeRatio: 0.5 })
  })

  it('honors env vars when no explicit options are given', () => {
    const resolved = resolveDiskGuardOptions({}, { DISK_GUARD_MIN_FREE_BYTES: '2000', DISK_GUARD_MIN_FREE_RATIO: '0.2' })
    expect(resolved).toEqual({ minFreeBytes: 2000, minFreeRatio: 0.2 })
  })

  it('falls back to defaults on invalid env values', () => {
    const resolved = resolveDiskGuardOptions({}, { DISK_GUARD_MIN_FREE_BYTES: 'not-a-number', DISK_GUARD_MIN_FREE_RATIO: '' })
    expect(resolved).toEqual({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.15 })
  })
})

describe('computeEffectiveFloorBytes', () => {
  it('picks the absolute floor when it is stricter (larger)', () => {
    // 50 GiB absolute vs. 1% of a 100 GiB disk (1 GiB) -- absolute wins
    const totalBytes = 100 * 1024 ** 3
    const floor = computeEffectiveFloorBytes({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.01 }, totalBytes)
    expect(floor).toBe(50 * 1024 ** 3)
  })

  it('picks the percentage floor when it is stricter (larger)', () => {
    // 50 GiB absolute vs. 15% of a 937 GiB disk (~140.5 GiB) -- percentage wins
    const totalBytes = 937 * 1024 ** 3
    const floor = computeEffectiveFloorBytes({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.15 }, totalBytes)
    expect(floor).toBeCloseTo(0.15 * totalBytes, 0)
    expect(floor).toBeGreaterThan(50 * 1024 ** 3)
  })
})

describe('checkProjection', () => {
  const floor = 100

  it('trips floor-breached when current free is already under the floor, even at index 0', () => {
    const result = checkProjection({ startFreeBytes: 50, currentFreeBytes: 50, effectiveFloorBytes: floor, index: 0, total: 10 })
    expect(result).toEqual({ trip: true, reason: 'floor-breached' })
  })

  it('does not project at index 0, regardless of how tight total is', () => {
    // Healthy now, but if a projection somehow ran at index 0 with total=1 it would divide by zero / misbehave.
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 1000, effectiveFloorBytes: floor, index: 0, total: 1 })
    expect(result).toEqual({ trip: false })
  })

  it('does not trip when projected consumption stays comfortably above the floor', () => {
    // Started at 1000, now at 900 after 1 of 10 iterations (100/iteration). 9 remain -> projects to 0, still... wait, use a case that clearly stays above floor.
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 950, effectiveFloorBytes: floor, index: 1, total: 10 })
    // consumed 50 in 1 iteration, 9 remain -> projects 950 - 450 = 500, well above floor=100
    expect(result).toEqual({ trip: false })
  })

  it('trips projected-breach when the observed rate would breach the floor before finishing', () => {
    // Started at 1000, now at 500 after 1 of 10 iterations (500/iteration). 9 remain -> projects 500 - 4500, deeply negative.
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 500, effectiveFloorBytes: floor, index: 1, total: 10 })
    expect(result).toEqual({ trip: true, reason: 'projected-breach' })
  })

  it('uses the running average across all completed iterations, not just the most recent one', () => {
    // Started 1000, after 2 completed iterations now at 800 (avg 100/iteration). 8 remain -> projects 800 - 800 = 0, breaches floor=100.
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 800, effectiveFloorBytes: floor, index: 2, total: 10 })
    expect(result).toEqual({ trip: true, reason: 'projected-breach' })
  })

  it('clamps apparent negative consumption to zero rather than projecting growing headroom', () => {
    // currentFreeBytes > startFreeBytes (something else freed space concurrently) -- must not project forever-growing headroom.
    const result = checkProjection({ startFreeBytes: 500, currentFreeBytes: 600, effectiveFloorBytes: floor, index: 1, total: 10 })
    // consumedSoFar clamped to 0 -> avgPerIteration 0 -> projectedFree = currentFreeBytes = 600, above floor=100
    expect(result).toEqual({ trip: false })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/clickhouse-disk-guard.test.ts`
Expected: FAIL — `Cannot find module '@/lib/clickhouse-disk-guard'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/clickhouse-disk-guard.ts`:

```ts
/**
 * Fail-closed disk-headroom guard for heavy ClickHouse write operations.
 *
 * Mirrors lib/clickhouse-memory-guard.ts's shape (query ClickHouse's own system
 * tables -- the app container has no direct filesystem access to the ClickHouse
 * data volume) but is deliberately the opposite of memory-guard's fail-open
 * default: any check failure here is treated as a trip, not "proceed anyway."
 * Memory-guard's failure mode when wrong is one query getting OOM-killed (it
 * has its own retry net). This guard's failure mode when wrong is a repeat of
 * the 2026-09-26 disk-exhaustion incident (937GB host disk -> 311MB free).
 * See docs/superpowers/specs/2026-09-28-clickhouse-disk-headroom-guard-design.md.
 */
import { getClient } from '@/lib/clickhouse'

export interface DiskHeadroom {
  freeBytes:  number
  totalBytes: number
  ratio:      number
}

export interface DiskGuardOptions {
  minFreeBytes?: number
  minFreeRatio?: number
}

export interface IterationContext {
  index: number
  total: number
}

export type DiskHeadroomReason = 'floor-breached' | 'projected-breach' | 'check-failed'

export class DiskHeadroomError extends Error {
  readonly headroom: DiskHeadroom | null
  readonly effectiveFloorBytes: number | null
  readonly reason: DiskHeadroomReason

  constructor(
    reason: DiskHeadroomReason,
    message: string,
    headroom: DiskHeadroom | null = null,
    effectiveFloorBytes: number | null = null,
  ) {
    super(message)
    this.name = 'DiskHeadroomError'
    this.reason = reason
    this.headroom = headroom
    this.effectiveFloorBytes = effectiveFloorBytes
  }
}

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const DEFAULT_MIN_FREE_BYTES = 50 * 1024 ** 3 // 50 GiB
const DEFAULT_MIN_FREE_RATIO = 0.15

/** Human-readable byte formatting for error messages, e.g. "50.00 GiB". */
export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

export function resolveDiskGuardOptions(
  opts: DiskGuardOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Required<DiskGuardOptions> {
  return {
    minFreeBytes: opts.minFreeBytes ?? parseEnvNumber(env.DISK_GUARD_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES),
    minFreeRatio: opts.minFreeRatio ?? parseEnvNumber(env.DISK_GUARD_MIN_FREE_RATIO, DEFAULT_MIN_FREE_RATIO),
  }
}

/** "Whichever is stricter": the larger of the two floor-in-bytes values. */
export function computeEffectiveFloorBytes(opts: Required<DiskGuardOptions>, totalBytes: number): number {
  return Math.max(opts.minFreeBytes, opts.minFreeRatio * totalBytes)
}

export type ProjectionResult =
  | { trip: false }
  | { trip: true; reason: 'floor-breached' | 'projected-breach' }

/**
 * Pure projection math -- see the design doc's "growth projection" section.
 * index === 0 means no iteration has completed yet, so only the immediate
 * floor check applies; the projection only activates from index > 0, using
 * the running average consumption across all completed iterations so far
 * (not just the most recent one, so one anomalous iteration can't dominate).
 */
export function checkProjection(params: {
  startFreeBytes: number
  currentFreeBytes: number
  effectiveFloorBytes: number
  index: number
  total: number
}): ProjectionResult {
  const { startFreeBytes, currentFreeBytes, effectiveFloorBytes, index, total } = params

  if (currentFreeBytes < effectiveFloorBytes) return { trip: true, reason: 'floor-breached' }

  if (index > 0) {
    const consumedSoFar = Math.max(0, startFreeBytes - currentFreeBytes)
    const avgPerIteration = consumedSoFar / index
    const remaining = total - index
    const projectedFree = currentFreeBytes - avgPerIteration * remaining
    if (projectedFree < effectiveFloorBytes) return { trip: true, reason: 'projected-breach' }
  }

  return { trip: false }
}
```

Note: this step creates the file with only the pure pieces plus the (unused-for-now)
`import { getClient } from '@/lib/clickhouse'`, which Task 2 will use. Confirmed
against this project's `tsconfig.json`: neither `noUnusedLocals` nor
`noUnusedParameters` is set, so an unused import is not a typecheck error here —
no cleanup needed between Task 1 and Task 2.

- [ ] **Step 4: Run tests to verify they pass, and typecheck**

Run: `npx vitest run __tests__/clickhouse-disk-guard.test.ts`
Expected: PASS — all tests green.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/clickhouse-disk-guard.ts __tests__/clickhouse-disk-guard.test.ts
git commit -m "feat(disk-guard): pure floor and growth-projection logic

Part 1 of the disk-headroom guard (docs/superpowers/specs/2026-09-28-
clickhouse-disk-headroom-guard-design.md). Floor and projection math
only -- no live ClickHouse querying yet, that's task 2."
```

---

## Task 2: Live query function and the DiskGuard object

**Files:**
- Modify: `lib/clickhouse-disk-guard.ts`
- Modify: `__tests__/clickhouse-disk-guard.test.ts`

**Interfaces:**
- Consumes (from Task 1): `DiskHeadroom`, `DiskGuardOptions`, `IterationContext`, `DiskHeadroomError`, `formatBytes`, `resolveDiskGuardOptions`, `computeEffectiveFloorBytes`, `checkProjection`.
- Produces: `checkDiskHeadroom(signal?: AbortSignal): Promise<DiskHeadroom>`, `interface DiskGuard { preflight(signal?: AbortSignal): Promise<void>; checkBeforeIteration(signal: AbortSignal | undefined, ctx: IterationContext): Promise<void> }`, `createDiskGuard(opts?: DiskGuardOptions): DiskGuard`.

This task follows `__tests__/clickhouse-memory-guard.test.ts`'s established pattern for
testing a live-ClickHouse-query function: mock `@/lib/clickhouse`'s `getClient()`
entirely via `vi.mock`, rather than requiring a live container for these tests
(a live spot-check happens in Step 5 below, separately).

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/clickhouse-disk-guard.test.ts` (new imports merge with the existing
`import { ... } from 'vitest'` and `@/lib/clickhouse-disk-guard'` lines at the top —
add `vi, beforeEach` to the vitest import and `checkDiskHeadroom, createDiskGuard,
DiskHeadroomError` to the disk-guard import):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatBytes,
  resolveDiskGuardOptions,
  computeEffectiveFloorBytes,
  checkProjection,
  checkDiskHeadroom,
  createDiskGuard,
  DiskHeadroomError,
} from '@/lib/clickhouse-disk-guard'

const h = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ query: h.query }) }))

const diskResult = (unreserved: number, total: number) =>
  h.query.mockResolvedValue({ json: async () => [{ unreserved_space: String(unreserved), total_space: String(total) }] })

beforeEach(() => {
  h.query.mockReset()
})

// ... existing describe blocks for formatBytes / resolveDiskGuardOptions /
// computeEffectiveFloorBytes / checkProjection stay exactly as Task 1 left them ...

describe('checkDiskHeadroom', () => {
  it('reads unreserved_space and total_space for the default disk', async () => {
    diskResult(300 * 1024 ** 3, 1000 * 1024 ** 3)

    const result = await checkDiskHeadroom()

    expect(result).toEqual({ freeBytes: 300 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3, ratio: 0.3 })
    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining(`WHERE name = 'default'`),
    }))
  })

  it('passes the abort signal through when one is given', async () => {
    diskResult(1, 2)
    const controller = new AbortController()

    await checkDiskHeadroom(controller.signal)

    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ abort_signal: controller.signal }))
  })

  it('works with no signal at all (the real call site has none)', async () => {
    diskResult(1, 2)
    await expect(checkDiskHeadroom()).resolves.toBeDefined()
  })

  it('throws if system.disks returns no row for "default"', async () => {
    h.query.mockResolvedValue({ json: async () => [] })
    await expect(checkDiskHeadroom()).rejects.toThrow('no usable row')
  })
})

describe('createDiskGuard', () => {
  it('preflight passes when headroom is above the floor', async () => {
    diskResult(300 * 1024 ** 3, 1000 * 1024 ** 3) // 30% free, well above 15%/50GiB defaults
    const guard = createDiskGuard()
    await expect(guard.preflight()).resolves.toBeUndefined()
  })

  it('preflight throws DiskHeadroomError(floor-breached) when already below the floor', async () => {
    diskResult(1 * 1024 ** 3, 1000 * 1024 ** 3) // 0.1% free, way under both floors
    const guard = createDiskGuard()
    await expect(guard.preflight()).rejects.toThrow(DiskHeadroomError)
    await expect(guard.preflight()).rejects.toMatchObject({ reason: 'floor-breached' })
  })

  it('preflight throws DiskHeadroomError(check-failed) when the query itself fails', async () => {
    h.query.mockRejectedValue(new Error('connection refused'))
    const guard = createDiskGuard()
    await expect(guard.preflight()).rejects.toMatchObject({ reason: 'check-failed' })
  })

  it('checkBeforeIteration throws if called before preflight', async () => {
    const guard = createDiskGuard()
    await expect(guard.checkBeforeIteration(undefined, { index: 0, total: 10 })).rejects.toThrow('before preflight')
  })

  it('checkBeforeIteration trips projected-breach using the reading captured at preflight as the baseline', async () => {
    diskResult(1000 * 1024 ** 3, 2000 * 1024 ** 3) // preflight baseline: 1000 GiB free, floor = max(50, 300) = 300 GiB
    const guard = createDiskGuard()
    await guard.preflight()

    diskResult(500 * 1024 ** 3, 2000 * 1024 ** 3) // after bucket 0: 500 GiB free (consumed 500 in 1 iteration)
    await expect(guard.checkBeforeIteration(undefined, { index: 1, total: 3 }))
      .rejects.toMatchObject({ reason: 'projected-breach' }) // 2 remain -> projects 500 - 1000 = -500, under the 300 GiB floor
  })

  it('checkBeforeIteration does not trip when headroom stays comfortably above the floor', async () => {
    diskResult(1000 * 1024 ** 3, 2000 * 1024 ** 3) // preflight baseline: 1000 GiB free, floor 300 GiB
    const guard = createDiskGuard()
    await guard.preflight()

    diskResult(950 * 1024 ** 3, 2000 * 1024 ** 3) // after bucket 0: consumed only 50 GiB
    await expect(guard.checkBeforeIteration(undefined, { index: 1, total: 3 }))
      .resolves.toBeUndefined() // 2 remain -> projects 950 - 100 = 850, well above 300 GiB floor
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run __tests__/clickhouse-disk-guard.test.ts`
Expected: FAIL — `checkDiskHeadroom`, `createDiskGuard`, `DiskHeadroomError` (as an
import target used in `.toMatchObject`/`instanceof` checks) are not yet exported
from `lib/clickhouse-disk-guard.ts`'s current (Task 1) contents.

- [ ] **Step 3: Add the implementation**

Append to `lib/clickhouse-disk-guard.ts`, after `checkProjection` (the
`import { getClient } from '@/lib/clickhouse'` line Task 1 added is already there
and gets its first real use here):

```ts
/** One live snapshot: queries system.disks fresh, every call. No caching. */
export async function checkDiskHeadroom(signal?: AbortSignal): Promise<DiskHeadroom> {
  const res = await getClient().query({
    query: `SELECT unreserved_space, total_space FROM system.disks WHERE name = 'default'`,
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: { use_query_cache: 0 },
  })
  const rows = await res.json() as Array<{ unreserved_space: string | number; total_space: string | number }>
  const freeBytes = Number(rows[0]?.unreserved_space ?? NaN)
  const totalBytes = Number(rows[0]?.total_space ?? NaN)
  if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('[clickhouse-disk-guard] system.disks returned no usable row for disk "default"')
  }
  return { freeBytes, totalBytes, ratio: freeBytes / totalBytes }
}

export interface DiskGuard {
  preflight(signal?: AbortSignal): Promise<void>
  checkBeforeIteration(signal: AbortSignal | undefined, ctx: IterationContext): Promise<void>
}

export function createDiskGuard(opts: DiskGuardOptions = {}): DiskGuard {
  const resolved = resolveDiskGuardOptions(opts)
  let startFreeBytes: number | null = null

  async function safeCheck(signal?: AbortSignal): Promise<DiskHeadroom> {
    try {
      return await checkDiskHeadroom(signal)
    } catch (err) {
      throw new DiskHeadroomError(
        'check-failed',
        `[clickhouse-disk-guard] headroom check failed, treating as a trip: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    async preflight(signal?: AbortSignal): Promise<void> {
      const headroom = await safeCheck(signal)
      startFreeBytes = headroom.freeBytes
      const effectiveFloorBytes = computeEffectiveFloorBytes(resolved, headroom.totalBytes)
      if (headroom.freeBytes < effectiveFloorBytes) {
        throw new DiskHeadroomError(
          'floor-breached',
          `[clickhouse-disk-guard] preflight: ${formatBytes(headroom.freeBytes)} free < ${formatBytes(effectiveFloorBytes)} floor -- refusing to start`,
          headroom,
          effectiveFloorBytes,
        )
      }
    },

    async checkBeforeIteration(signal: AbortSignal | undefined, ctx: IterationContext): Promise<void> {
      if (startFreeBytes === null) {
        throw new Error('[clickhouse-disk-guard] checkBeforeIteration called before preflight')
      }
      const headroom = await safeCheck(signal)
      const effectiveFloorBytes = computeEffectiveFloorBytes(resolved, headroom.totalBytes)
      const result = checkProjection({
        startFreeBytes,
        currentFreeBytes: headroom.freeBytes,
        effectiveFloorBytes,
        index: ctx.index,
        total: ctx.total,
      })
      if (result.trip) {
        const detail = result.reason === 'floor-breached'
          ? `${formatBytes(headroom.freeBytes)} free < ${formatBytes(effectiveFloorBytes)} floor`
          : `projected to breach ${formatBytes(effectiveFloorBytes)} floor before iteration ${ctx.total} of ${ctx.total} completes (currently ${formatBytes(headroom.freeBytes)} free at iteration ${ctx.index} of ${ctx.total})`
        throw new DiskHeadroomError(
          result.reason,
          `[clickhouse-disk-guard] checkBeforeIteration: ${detail}`,
          headroom,
          effectiveFloorBytes,
        )
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass, and typecheck**

Run: `npx vitest run __tests__/clickhouse-disk-guard.test.ts`
Expected: PASS — all tests green, including Task 1's.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Live spot-check against the real container**

This is the one piece Task 1/2's mocked tests can't cover: whether `system.disks`
really has a `name = 'default'` row with the expected column names on the actual
running container (verified once already, manually, on 2026-09-28 during design —
re-confirm now that real code depends on it):

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT name, unreserved_space, total_space FROM system.disks WHERE name = 'default' FORMAT Vertical"
```

Expected: one row, `name: default`, both space columns non-empty positive numbers.
If this returns zero rows or a different disk name, stop — the `WHERE name =
'default'` in `checkDiskHeadroom` needs to change to match reality before
continuing, and that's a real finding worth flagging back rather than silently
patching around.

- [ ] **Step 6: Commit**

```bash
git add lib/clickhouse-disk-guard.ts __tests__/clickhouse-disk-guard.test.ts
git commit -m "feat(disk-guard): live system.disks query and DiskGuard object

Part 2: checkDiskHeadroom() and createDiskGuard(), fail-closed on any
query error per the design doc. Tested by mocking @/lib/clickhouse,
same pattern as __tests__/clickhouse-memory-guard.test.ts uses for its
own live-query function. Live-verified system.disks' schema against
the real container."
```

---

## Task 3: Wire into content-dedup's populate step

**Files:**
- Modify: `lib/content-dedup.ts`
- Modify: `__tests__/content-dedup.test.ts`

**Interfaces:**
- Consumes (from Task 2): `createDiskGuard`, `DiskHeadroomError`, `type DiskGuard` from `@/lib/clickhouse-disk-guard`.
- Produces: `populateDedupedTableWithGuard(client: ClickHouseClient, bucketCount: number, guard: DiskGuard): Promise<void>` (exported from `lib/content-dedup.ts`, dependency-injected so it's testable without mocking the whole ClickHouse module).

`runContentDedupTick`'s step 5 currently reads (this is its exact, unmodified
current content — confirmed against the file as of this session):

```ts
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
    }
```

That `console.log` line is intentionally left as-is by this task — it's a mid-run
progress line, not a liveness/tick-summary signal, and was deliberately excluded
from the 2026-09-28 `console.warn` promotion pass for exactly that reason (see
`[[project_removeconsole_strips_logs]]`). Only the loop body changes.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/content-dedup.test.ts` (new top-of-file imports: add
`populateDedupedTableWithGuard` to the existing `from '@/lib/content-dedup'`
import, and add a new import for `DiskHeadroomError` from
`@/lib/clickhouse-disk-guard`; no `vi.mock` needed since this function takes its
dependencies as plain parameters):

```ts
import { DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'

describe('populateDedupedTableWithGuard', () => {
  function fakeClient() {
    return { exec: vi.fn().mockResolvedValue(undefined) } as unknown as { exec: ReturnType<typeof vi.fn> }
  }

  function fakeGuard(overrides: Partial<DiskGuard> = {}): DiskGuard {
    return {
      preflight: vi.fn().mockResolvedValue(undefined),
      checkBeforeIteration: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  it('calls preflight once, then checkBeforeIteration + populate once per bucket, in order', async () => {
    const client = fakeClient()
    const guard = fakeGuard()

    await populateDedupedTableWithGuard(client as any, 3, guard)

    expect(guard.preflight).toHaveBeenCalledTimes(1)
    expect(guard.checkBeforeIteration).toHaveBeenCalledTimes(3)
    expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(1, undefined, { index: 0, total: 3 })
    expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(2, undefined, { index: 1, total: 3 })
    expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(3, undefined, { index: 2, total: 3 })
    expect(client.exec).toHaveBeenCalledTimes(3)
  })

  it('drops AUTO_DEDUP_TABLE and re-throws when the guard trips with a DiskHeadroomError', async () => {
    const client = fakeClient()
    const tripError = new DiskHeadroomError('floor-breached', 'nope', null, null)
    const guard = fakeGuard({
      checkBeforeIteration: vi.fn()
        .mockResolvedValueOnce(undefined) // bucket 0: fine
        .mockRejectedValueOnce(tripError), // bucket 1: trips
    })

    await expect(populateDedupedTableWithGuard(client as any, 5, guard)).rejects.toBe(tripError)

    // Only bucket 0's populate ran -- bucket 1's guard check threw before its populate call.
    expect(client.exec).toHaveBeenCalledTimes(2) // 1 populate (bucket 0) + 1 DROP TABLE cleanup
    expect(client.exec).toHaveBeenLastCalledWith({ query: expect.stringContaining('DROP TABLE IF EXISTS ulp.credentials_cdedup_auto SYNC') })
  })

  it('re-throws without a DROP TABLE cleanup when the guard throws something other than DiskHeadroomError', async () => {
    const client = fakeClient()
    const otherError = new Error('unrelated failure')
    const guard = fakeGuard({
      checkBeforeIteration: vi.fn().mockRejectedValueOnce(otherError),
    })

    await expect(populateDedupedTableWithGuard(client as any, 5, guard)).rejects.toBe(otherError)

    expect(client.exec).not.toHaveBeenCalled() // no populate (failed before it), and no DROP TABLE (not a DiskHeadroomError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/content-dedup.test.ts`
Expected: FAIL — `populateDedupedTableWithGuard` is not exported from
`lib/content-dedup.ts` yet.

- [ ] **Step 3: Write the implementation**

In `lib/content-dedup.ts`, add the new import alongside the existing ones at the top:

```ts
import { createDiskGuard, DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
```

Add this new function directly above `runContentDedupTick` (after
`buildCatchupInsertSql` and the env-knobs section, in the same place a reader
would expect the next piece of "how the tick actually populates the table" logic):

```ts
/**
 * Populates AUTO_DEDUP_TABLE one bucket at a time, guarded by a disk-headroom
 * check before each bucket. On a trip, drops the partial AUTO_DEDUP_TABLE
 * immediately -- rather than leaving it for the next day's tick (step 2/3's
 * own cleanup, 24h away) to find -- before re-throwing. Takes client and guard
 * as parameters (not module-scope state) so it's independently testable with
 * plain fake objects, no ClickHouse-module mocking required.
 * See docs/superpowers/specs/2026-09-28-clickhouse-disk-headroom-guard-design.md.
 */
export async function populateDedupedTableWithGuard(
  client: ClickHouseClient,
  bucketCount: number,
  guard: DiskGuard,
): Promise<void> {
  await guard.preflight()
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    try {
      await guard.checkBeforeIteration(undefined, { index: bucket, total: bucketCount })
    } catch (err) {
      if (err instanceof DiskHeadroomError) {
        await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE} SYNC` })
      }
      throw err
    }
    await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
  }
}
```

Then replace step 5's loop inside `runContentDedupTick` — find:

```ts
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
    }
```

with:

```ts
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    await populateDedupedTableWithGuard(client, bucketCount, createDiskGuard())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/content-dedup.test.ts __tests__/clickhouse-disk-guard.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Full verification pass**

Run the complete suite and typecheck, since this task touches a file
(`content-dedup.ts`) other tests may transitively import:

```bash
npm run typecheck
npx vitest run
```

Expected: typecheck clean; all test files pass (75 files / 1117+ tests as of
2026-09-28, now plus this task's new tests).

Then a real production build, to confirm this compiles cleanly end-to-end
(mirrors how the 2026-09-28 logging fix was verified before deploy):

```bash
npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts
git commit -m "feat(dedup): guard content-dedup's populate step with the disk-headroom guard

Wires lib/clickhouse-disk-guard.ts into runContentDedupTick's populate
loop (step 5) as its first real consumer -- content-dedup is the
mechanism this project adopted 2026-09-28 for the long-term dedup
path. A trip drops the partial AUTO_DEDUP_TABLE immediately rather
than waiting for the next day's tick to clean it up. Only the populate
step is guarded; the read-only stats/verify passes can't grow disk
usage and are unaffected."
```

**This does not need a production deploy right now.** `CONTENT_DEDUP_APPLY` is
still `false` (report-only), so the populate step this guards doesn't run in
production yet regardless of whether this code is deployed. Deploying is safe
whenever it's next convenient (e.g. bundled with some other change), not
urgent on its own — unlike the 2026-09-28 bucket-count fix, which had a real
same-day deadline.

---

## Plan self-review notes

- **Spec coverage:** every section of the design doc maps to a task — pure logic
  (Task 1), live query + fail-closed `DiskGuard` (Task 2), content-dedup
  integration with immediate scratch-table cleanup (Task 3). The two "open items"
  the spec flagged (error-message format, log level of new output) are resolved
  concretely in Tasks 1–2's `formatBytes`/message text and by deliberately *not*
  adding any new `console.log` calls anywhere in this plan.
- **Signal-optionality gap:** the spec's interface sketch showed `signal:
  AbortSignal` as required throughout. Writing concrete code in this plan surfaced
  that `runContentDedupTick` has no `AbortSignal` anywhere in its real call chain
  (it's `setInterval`-triggered, not request-triggered) — every signal parameter
  in this plan is optional to match that reality. This is a refinement of the
  spec's interface sketch, not a change to its architecture or intent.
- **Testing-strategy upgrade over the spec:** the spec's own testability section
  said `checkDiskHeadroom` "needs live verification instead" of direct unit
  testing. Checking `__tests__/clickhouse-memory-guard.test.ts` (the closest real
  precedent in this codebase) during planning showed it *does* directly unit-test
  its own live-query function, via `vi.mock('@/lib/clickhouse', ...)`. Task 2
  follows that proven, stronger pattern instead of the spec's more conservative
  floor — strictly more coverage, nothing dropped (Task 2 Step 5 still does a
  live spot-check on top).
