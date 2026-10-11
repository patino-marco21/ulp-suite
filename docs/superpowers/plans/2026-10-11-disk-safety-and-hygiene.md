# Disk Safety and Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An import can never fill the disk (it pauses and resumes by itself), the operator sees a low disk on every page, the `projection-scope` job and both crons stop misbehaving, and CI, dependencies and debris are tidied before 2026-10-19.

**Architecture:** A new `lib/ingest-disk-gate.ts` is awaited before every insert batch and before the inbox claims a file; its state lives on `globalThis` and feeds a new admin-only `GET /api/monitoring/disk` and an Ingest Health line, which a client banner polls under the header. `projection-scope` asks `system.projection_parts` what really carries the projection and checks free space first. A new `lib/daily-schedule.ts` replaces the boot-relative `setTimeout` + `setInterval` pair in both crons.

**Tech Stack:** Next.js 15 (App Router), TypeScript, ClickHouse 26.3 (`@clickhouse/client` 1.23), Vitest 4 (node environment, `globals: true`), Docker Compose, GitHub Actions.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-11-disk-safety-and-hygiene-design.md` (commit 4ac1817). Where this plan and the spec differ, the spec wins; say so in the commit.
- Ingest floor `INGEST_MIN_FREE_BYTES`, default 50 GiB = 53,687,091,200; resume level = floor + floor/10 (integer arithmetic, 55 GiB by default); poll every 5 s; reading cache 5 s; reminder every 10 min; no timeout; a failed free-space read pauses (fail closed); `INGEST_DISK_GATE=off|0|false` disables the gate.
- Gate state lives on `globalThis.__ulpIngestDiskGate`.
- Banner endpoint `GET /api/monitoring/disk` is admin-only (`validateRequest` + `requireAdminRole`) and returns `{ disk, gate }`; the banner polls every 60 s while the tab is visible and is not rendered for `/login` and `/check`; `lib/disk-banner.ts` is pure and may only use `import type` from server modules.
- `projection-scope`: eligibility from `system.projection_parts` joined to `system.parts`; need = largest part x 1.1 + 5 GiB; ALTER sent with `alter_sync: '0'` and `mutations_sync: '0'`; never the newest partition; the SQL assertions already in `__tests__/projection-scope.test.ts` keep passing unchanged.
- Scheduler: 30 s wall-clock poller, `unref()`, one catch-up run after a long gap; `msUntilNextRun` stays importable from `@/lib/dedup-cron`.
- CI: `runs-on: ubuntu-24.04`, `actions/checkout@v7`, `actions/setup-node@v7`.
- Dependencies: only non-major fixes for `next`, `sharp`, `source-map-js`, `postcss-nested`, proven by `npm ci` and by reading `node_modules/<pkg>/package.json`.
- Work happens on branch `sp1-disk-safety-hygiene` in `/home/cole/ulp-suite` (no worktree). Use absolute paths.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The repository is public: no operator search terms, download file names, channel names or credential values in code, tests, docs or commit messages.
- Docker on this laptop: use a scoped `DOCKER_CONFIG` directory containing `{}` for `build` and `compose up`. Never run `docker system|container|image prune`: an unrelated stack shares the daemon.

---

### Task 0: Branch and baseline

**Files:** none.

- [ ] **Step 1: Create the branch**

```bash
cd /home/cole/ulp-suite && git status -sb && git fetch -q origin && git switch -c sp1-disk-safety-hygiene
```
Expected: `## main...origin/main` (only `?? .claude/` untracked), then `Switched to a new branch 'sp1-disk-safety-hygiene'`.

- [ ] **Step 2: Baseline typecheck**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Baseline tests**

Run: `cd /home/cole/ulp-suite && npx vitest run 2>&1 | tail -8`
Expected: every file passes. Write down the `Test Files` and `Tests` counts as the BASELINE (last recorded 2026-10-05: 149 files, 2,306 tests; the `*.live.test.ts` files are skipped).

---

### Task 1: The ingest disk gate module

**Files:**
- Create: `/home/cole/ulp-suite/lib/ingest-disk-gate.ts`
- Test: `/home/cole/ulp-suite/__tests__/ingest-disk-gate.test.ts`

**Interfaces:**
- Consumes: `checkDiskHeadroom(signal?: AbortSignal): Promise<DiskHeadroom>`, `formatBytes(bytes: number): string` and `type DiskHeadroom { freeBytes: number; totalBytes: number; ratio: number }` from `@/lib/clickhouse-disk-guard`.
- Produces (later tasks rely on these exact names):
  - `DEFAULT_INGEST_MIN_FREE_BYTES: number`
  - `interface IngestDiskGateConfig { enabled: boolean; floorBytes: number; resumeBytes: number; pollMs: number }`
  - `interface IngestDiskGateState { enabled: boolean; paused: boolean; since: number | null; waiters: number; freeBytes: number | null; floorBytes: number; resumeBytes: number; checkedAt: number | null; error?: string }`
  - `ingestDiskGateConfig(env?: NodeJS.ProcessEnv): IngestDiskGateConfig`
  - `getIngestDiskGate(env?: NodeJS.ProcessEnv): IngestDiskGateState`
  - `resetIngestDiskGate(): void` (test seam)
  - `waitForDiskSpace(signal: AbortSignal, opts?: { onPoll?: () => void; check?: (signal: AbortSignal) => Promise<DiskHeadroom>; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number; env?: NodeJS.ProcessEnv }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ingest-disk-gate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import { getClient } from '@/lib/clickhouse'
import {
  DEFAULT_INGEST_MIN_FREE_BYTES,
  getIngestDiskGate,
  ingestDiskGateConfig,
  resetIngestDiskGate,
  waitForDiskSpace,
} from '@/lib/ingest-disk-gate'

const GiB = 1024 ** 3
const headroom = (freeGiB: number) => ({ freeBytes: freeGiB * GiB, totalBytes: 936.8 * GiB, ratio: freeGiB / 936.8 })
const env = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv
const noSleep = async () => {}

beforeEach(() => {
  resetIngestDiskGate()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ingestDiskGateConfig', () => {
  it('defaults to enabled, a 50 GiB floor, a 55 GiB resume level and a 5 s poll', () => {
    expect(ingestDiskGateConfig({})).toEqual({ enabled: true, floorBytes: 50 * GiB, resumeBytes: 55 * GiB, pollMs: 5_000 })
    expect(DEFAULT_INGEST_MIN_FREE_BYTES).toBe(53_687_091_200)
  })

  it('honours INGEST_MIN_FREE_BYTES', () => {
    const c = ingestDiskGateConfig(env({ INGEST_MIN_FREE_BYTES: String(100 * GiB) }))
    expect(c.floorBytes).toBe(100 * GiB)
    expect(c.resumeBytes).toBe(110 * GiB)
  })

  it.each(['', '  ', 'abc', '-5', 'NaN'])('falls back to the default for INGEST_MIN_FREE_BYTES=%j', raw => {
    expect(ingestDiskGateConfig(env({ INGEST_MIN_FREE_BYTES: raw })).floorBytes).toBe(50 * GiB)
  })

  it.each(['off', 'OFF', '0', 'false', ' False '])('INGEST_DISK_GATE=%j switches the gate off', raw => {
    expect(ingestDiskGateConfig(env({ INGEST_DISK_GATE: raw })).enabled).toBe(false)
  })

  it.each(['', 'on', '1', 'true'])('INGEST_DISK_GATE=%j leaves it on', raw => {
    expect(ingestDiskGateConfig(env({ INGEST_DISK_GATE: raw })).enabled).toBe(true)
  })
})

describe('getIngestDiskGate', () => {
  it('reports the configured floor and resume level before any import has asked', () => {
    expect(getIngestDiskGate(env({ INGEST_MIN_FREE_BYTES: String(20 * GiB) }))).toEqual({
      enabled: true, paused: false, since: null, waiters: 0, freeBytes: null,
      floorBytes: 20 * GiB, resumeBytes: 22 * GiB, checkedAt: null,
    })
  })
})

describe('getIngestDiskGate — switched off', () => {
  it('says so, so that the banner does not claim imports pause', () => {
    expect(getIngestDiskGate(env({ INGEST_DISK_GATE: 'off' })).enabled).toBe(false)
    expect(getIngestDiskGate(env()).enabled).toBe(true)
  })
})

describe('waitForDiskSpace', () => {
  it('proceeds at once when free space is above the floor', async () => {
    const check = vi.fn(async () => headroom(80))
    const sleep = vi.fn(noSleep)
    await waitForDiskSpace(new AbortController().signal, { check, sleep, env: env() })
    expect(check).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, freeBytes: 80 * GiB })
  })

  it('proceeds when free space is exactly the floor', async () => {
    const sleep = vi.fn(noSleep)
    await waitForDiskSpace(new AbortController().signal, { check: async () => headroom(50), sleep, env: env() })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('is a no-op when switched off: it does not even read the disk', async () => {
    const check = vi.fn(async () => headroom(1))
    await waitForDiskSpace(new AbortController().signal, { check, env: env({ INGEST_DISK_GATE: 'off' }) })
    expect(check).not.toHaveBeenCalled()
  })

  it('reads the disk through the ClickHouse client by default', async () => {
    const query = vi.fn(async () => ({ json: async () => [{ unreserved_space: 80 * GiB, total_space: 936.8 * GiB }] }))
    ;(getClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ query })
    await waitForDiskSpace(new AbortController().signal, { env: env() })
    expect(query).toHaveBeenCalledTimes(1)
    expect(getIngestDiskGate(env()).freeBytes).toBe(80 * GiB)
  })

  it('pauses under the floor and resumes only at the resume level, not at the floor', async () => {
    const reads = [40, 52, 56] // 52 is above the 50 GiB floor but below the 55 GiB resume level
    const check = vi.fn(async () => headroom(reads.shift() ?? 56))
    const seen: Array<{ paused: boolean; waiters: number }> = []
    const sleep = vi.fn(async () => {
      const g = getIngestDiskGate(env())
      seen.push({ paused: g.paused, waiters: g.waiters })
    })
    const onPoll = vi.fn()

    await waitForDiskSpace(new AbortController().signal, { check, sleep, onPoll, env: env() })

    expect(check).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal))
    expect(onPoll).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([{ paused: true, waiters: 1 }, { paused: true, waiters: 1 }])
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, since: null, freeBytes: 56 * GiB })
  })

  it('treats an unreadable disk as below the floor, says why, and recovers', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue(headroom(60))
    const seen: Array<{ paused: boolean; error?: string; freeBytes: number | null }> = []
    const sleep = vi.fn(async () => {
      const g = getIngestDiskGate(env())
      seen.push({ paused: g.paused, error: g.error, freeBytes: g.freeBytes })
    })

    await waitForDiskSpace(new AbortController().signal, { check, sleep, env: env() })

    expect(seen).toEqual([{ paused: true, error: 'connection refused', freeBytes: null }])
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, freeBytes: 60 * GiB })
    expect(getIngestDiskGate(env()).error).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
  })

  it('stops waiting when the import is aborted, and leaves no waiter behind', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const settled = waitForDiskSpace(controller.signal, { check: async () => headroom(10), env: env() }).then(
      () => 'resolved',
      e => `rejected:${(e as Error).name}`,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getIngestDiskGate(env())).toMatchObject({ paused: true, waiters: 1 })

    controller.abort()

    await expect(settled).resolves.toBe('rejected:AbortError')
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, since: null })
  })

  it('does not wait at all for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const check = vi.fn(async () => headroom(80))
    await expect(waitForDiskSpace(controller.signal, { check, env: env() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(check).not.toHaveBeenCalled()
  })

  it('two imports waiting share one state and resume together', async () => {
    vi.useFakeTimers()
    let free = 10
    const check = vi.fn(async () => headroom(free))
    const controller = new AbortController()
    const a = waitForDiskSpace(controller.signal, { check, env: env() })
    const b = waitForDiskSpace(controller.signal, { check, env: env() })
    await vi.advanceTimersByTimeAsync(0)
    expect(getIngestDiskGate(env())).toMatchObject({ paused: true, waiters: 2 })

    free = 60
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([a, b])

    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, since: null })
  })

  it('a late arrival between the floor and the resume level waits too', async () => {
    vi.useFakeTimers()
    let free = 10
    const check = vi.fn(async () => headroom(free))
    const controller = new AbortController()
    const a = waitForDiskSpace(controller.signal, { check, env: env() })
    await vi.advanceTimersByTimeAsync(0)

    free = 52 // above the floor, below the resume level
    await vi.advanceTimersByTimeAsync(5_000)
    let bDone = false
    const b = waitForDiskSpace(controller.signal, { check, env: env() }).then(() => { bDone = true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(bDone).toBe(false)
    expect(getIngestDiskGate(env()).waiters).toBe(2)

    free = 56
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([a, b])
    expect(bDone).toBe(true)
  })

  it('reuses a fast-path reading younger than five seconds', async () => {
    let t = 0
    const now = () => t
    const check = vi.fn(async () => headroom(80))
    const signal = new AbortController().signal

    await waitForDiskSpace(signal, { check, now, env: env() })
    t = 4_999
    await waitForDiskSpace(signal, { check, now, env: env() })
    expect(check).toHaveBeenCalledTimes(1)

    t = 5_000
    await waitForDiskSpace(signal, { check, now, env: env() })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('logs one pause line, one reminder per ten minutes, and one resume line', async () => {
    let t = 1_000_000
    const now = () => t
    const reads = [10, 10, 10, 10, 60]
    const check = vi.fn(async () => headroom(reads.shift() ?? 60))
    const sleep = vi.fn(async () => { t += 5 * 60_000 }) // each poll is five minutes later

    await waitForDiskSpace(new AbortController().signal, { check, sleep, now, env: env() })

    const lines = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('pausing imports')
    expect(lines[1]).toContain('still paused')
    expect(lines[2]).toContain('resuming imports')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-disk-gate.test.ts 2>&1 | tail -15`
Expected: FAIL: `Failed to resolve import "@/lib/ingest-disk-gate"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `/home/cole/ulp-suite/lib/ingest-disk-gate.ts`:

```ts
/**
 * Disk-space gate for the ingest path.
 *
 * lib/clickhouse-memory-guard.ts paces an import against ClickHouse MEMORY and fails open. Nothing paced it against DISK: on
 * 2026-10-09 the data disk reached 0.00 GiB free while the importer was free to keep inserting. This is the disk counterpart,
 * with the opposite failure mode. While free space on the ClickHouse data disk is under a floor an import PAUSES. It never
 * fails and there is no timeout: a file that fails halfway is worse than one that waits, because until novelty-aware ingest
 * exists a retry re-inserts the rows that already landed. It resumes by itself once free space is back above the floor plus
 * 10%. A free-space read that fails counts as "below the floor": the inserts would fail anyway, and unknown free space on this
 * path is the same risk as low free space.
 *
 * The state lives on globalThis: instrumentation.ts (the inbox watcher) and the route handlers are separate webpack chunks,
 * so plain module state would not be shared with the endpoint that reports it.
 *
 * See docs/superpowers/specs/2026-10-11-disk-safety-and-hygiene-design.md.
 */
import { checkDiskHeadroom, formatBytes, type DiskHeadroom } from '@/lib/clickhouse-disk-guard'

const GiB = 1024 ** 3

export const DEFAULT_INGEST_MIN_FREE_BYTES = 50 * GiB
const POLL_MS = 5_000
/** A fast-path reading younger than this is reused, so a batch every few seconds costs one tiny query, not one per batch. */
const CACHE_MS = 5_000
const REMINDER_MS = 10 * 60_000

export interface IngestDiskGateConfig {
  enabled: boolean
  /** Pause under this much free space. */
  floorBytes: number
  /** Resume at or above this much free space (the floor plus 10%). */
  resumeBytes: number
  pollMs: number
}

export interface IngestDiskGateState {
  /** False when INGEST_DISK_GATE switches the gate off: nothing pauses, and the banner must not say that imports do. */
  enabled: boolean
  /** True while at least one import is waiting. */
  paused: boolean
  /** When the first current waiter began waiting (epoch ms), or null. */
  since: number | null
  /** Imports waiting right now. */
  waiters: number
  /** Free bytes at the last reading; null when the last read failed or no import has asked yet. */
  freeBytes: number | null
  floorBytes: number
  resumeBytes: number
  checkedAt: number | null
  /** Why freeBytes is null after a failed read. */
  error?: string
}

export function ingestDiskGateConfig(env: NodeJS.ProcessEnv = process.env): IngestDiskGateConfig {
  const flag = (env.INGEST_DISK_GATE ?? '').trim().toLowerCase()
  const enabled = !(flag === 'off' || flag === '0' || flag === 'false')
  const raw = env.INGEST_MIN_FREE_BYTES
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  const floorBytes = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INGEST_MIN_FREE_BYTES
  // Integer arithmetic: 50 GiB + 5 GiB is exactly 55 GiB, with no floating-point dust.
  return { enabled, floorBytes, resumeBytes: floorBytes + Math.floor(floorBytes / 10), pollMs: POLL_MS }
}

interface GateStore {
  waiters: number
  since: number | null
  freeBytes: number | null
  checkedAt: number | null
  error?: string
  lastReminderAt: number
  cache: { at: number; headroom: DiskHeadroom } | null
}

const globalForGate = globalThis as unknown as { __ulpIngestDiskGate?: GateStore }

function store(): GateStore {
  return (globalForGate.__ulpIngestDiskGate ??= {
    waiters: 0, since: null, freeBytes: null, checkedAt: null, lastReminderAt: 0, cache: null,
  })
}

/** Snapshot for the banner endpoint and the Ingest Health panel. The floor and resume level always come from the environment. */
export function getIngestDiskGate(env: NodeJS.ProcessEnv = process.env): IngestDiskGateState {
  const s = store()
  const cfg = ingestDiskGateConfig(env)
  return {
    enabled: cfg.enabled,
    paused: s.waiters > 0,
    since: s.waiters > 0 ? s.since : null,
    waiters: s.waiters,
    freeBytes: s.freeBytes,
    floorBytes: cfg.floorBytes,
    resumeBytes: cfg.resumeBytes,
    checkedAt: s.checkedAt,
    ...(s.error ? { error: s.error } : {}),
  }
}

/** Test seam. */
export function resetIngestDiskGate(): void {
  globalForGate.__ulpIngestDiskGate = undefined
}

export interface WaitForDiskSpaceOptions {
  /** Called on every poll while paused: a waiting import is not a wedged one (lib/import-runner.ts). */
  onPoll?: () => void
  /** Test seams. */
  check?: (signal: AbortSignal) => Promise<DiskHeadroom>
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  env?: NodeJS.ProcessEnv
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface Reading {
  freeBytes: number | null
  error?: string
}

async function readFree(
  signal: AbortSignal,
  check: (signal: AbortSignal) => Promise<DiskHeadroom>,
  now: () => number,
  useCache: boolean,
): Promise<Reading> {
  const s = store()
  if (useCache && s.cache && now() - s.cache.at < CACHE_MS) return { freeBytes: s.cache.headroom.freeBytes }
  try {
    const headroom = await check(signal)
    const at = now()
    s.cache = { at, headroom }
    s.freeBytes = headroom.freeBytes
    s.checkedAt = at
    s.error = undefined
    return { freeBytes: headroom.freeBytes }
  } catch (err) {
    // An abort (the stall watchdog, a cancel) is not a failed read: let it through.
    if (signal.aborted) throw signal.reason ?? err
    const error = err instanceof Error ? err.message : String(err)
    s.cache = null
    s.freeBytes = null
    s.checkedAt = now()
    s.error = error
    return { freeBytes: null, error }
  }
}

/**
 * Resolves when the import may insert its next batch. Pauses while free space on the ClickHouse data disk is under the floor
 * (see the module comment); rejects only when `signal` aborts.
 */
export async function waitForDiskSpace(signal: AbortSignal, opts: WaitForDiskSpaceOptions = {}): Promise<void> {
  const cfg = ingestDiskGateConfig(opts.env ?? process.env)
  if (!cfg.enabled) return
  signal.throwIfAborted()

  const now = opts.now ?? Date.now
  const check = opts.check ?? ((s: AbortSignal) => checkDiskHeadroom(s))
  const sleep = opts.sleep ?? defaultSleep
  const s = store()

  // While anyone is waiting, the resume level applies to everyone: a late arrival in the band between the floor and the
  // resume level waits too, so the gate does not flap.
  const first = await readFree(signal, check, now, true)
  if (first.freeBytes !== null && first.freeBytes >= (s.waiters > 0 ? cfg.resumeBytes : cfg.floorBytes)) return

  const startedAt = now()
  if (s.waiters === 0) {
    s.since = startedAt
    s.lastReminderAt = startedAt
  }
  s.waiters++
  console.warn(
    first.freeBytes === null
      ? `[ingest-disk-gate] pausing imports: free disk space could not be read (${first.error})`
      : `[ingest-disk-gate] pausing imports: ${formatBytes(first.freeBytes)} free is under the ${formatBytes(cfg.floorBytes)} floor; they resume above ${formatBytes(cfg.resumeBytes)}`,
  )
  try {
    for (;;) {
      opts.onPoll?.()
      await sleep(cfg.pollMs, signal)
      signal.throwIfAborted()
      const reading = await readFree(signal, check, now, false)
      if (reading.freeBytes !== null && reading.freeBytes >= cfg.resumeBytes) {
        console.warn(
          `[ingest-disk-gate] resuming imports: ${formatBytes(reading.freeBytes)} free after waiting ${Math.round((now() - startedAt) / 1000)} s`,
        )
        return
      }
      if (now() - s.lastReminderAt >= REMINDER_MS) {
        s.lastReminderAt = now()
        console.warn(
          reading.freeBytes === null
            ? `[ingest-disk-gate] still paused: free disk space could not be read (${reading.error})`
            : `[ingest-disk-gate] still paused: ${formatBytes(reading.freeBytes)} free, they resume above ${formatBytes(cfg.resumeBytes)}`,
        )
      }
    }
  } finally {
    s.waiters--
    if (s.waiters === 0) s.since = null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-disk-gate.test.ts 2>&1 | tail -30`
Expected: PASS, every test in the file green (about 22).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && git add lib/ingest-disk-gate.ts __tests__/ingest-disk-gate.test.ts && git commit -F - <<'EOF'
feat(ingest): a disk gate that pauses imports under 50 GiB free and resumes by itself

waitForDiskSpace reads the ClickHouse data disk (system.disks unreserved space), pauses with a heartbeat while it is under
INGEST_MIN_FREE_BYTES (default 50 GiB), resumes at floor + 10%, never times out, and fails closed when the read fails.
State lives on globalThis for the banner endpoint. Not wired in yet.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```
Expected: `tsc` silent, commit created.

---

### Task 2: Wire the gate into the batch loop and the inbox watcher

**Files:**
- Modify: `/home/cole/ulp-suite/lib/upload-processor.ts` (import near line 25; the batch loop near line 327)
- Modify: `/home/cole/ulp-suite/lib/inbox-watcher.ts` (import near line 42; the queued task near line 286)
- Create: `/home/cole/ulp-suite/__tests__/setup/ingest-gate-off.ts`
- Modify: `/home/cole/ulp-suite/vitest.config.ts` (`setupFiles`)
- Test: `/home/cole/ulp-suite/__tests__/upload-processor-disk-gate.test.ts`, `/home/cole/ulp-suite/__tests__/inbox-watcher-disk-gate.test.ts`

**Interfaces:**
- Consumes: `waitForDiskSpace(signal, { onPoll })` from Task 1.
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write the failing tests**

Create `/home/cole/ulp-suite/__tests__/upload-processor-disk-gate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
  gate: vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: h.gate }))

const parser = vi.hoisted(() => ({ batches: [] as any[] }))
vi.mock('@/lib/ulp-parser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
  return {
    ...actual,
    parseULPStream: async function* () {
      for (const b of parser.batches) yield b
    },
  }
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
const emptyBreakdown = () => ({ blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 })
const batchOf = (n: number, tag: string) => ({
  credentials: Array.from({ length: n }, (_, i) => ({
    url: '', email: `u${i}@${tag}.com`, password: `${tag}${i}`, domain: `${tag}.com`, source_file: 'g.txt',
  })),
  rejected: 0,
  breakdown: emptyBreakdown(),
})
const webStream = () => Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>

beforeEach(() => {
  parser.batches = []
  h.insert.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.gate.mockReset()
  h.gate.mockResolvedValue(undefined)
})

describe('streamCredentialsToTable — ingest disk gate', () => {
  it('asks the gate before every batch, with the import signal and its heartbeat', async () => {
    parser.batches = [batchOf(2, 'a'), batchOf(3, 'b')]
    const controller = new AbortController()
    const beat = vi.fn()
    const { streamCredentialsToTable } = await import('@/lib/upload-processor')

    const res = await streamCredentialsToTable(webStream(), 'g.txt', {
      table: 'ulp.bench_x', pipeline: false, signal: controller.signal, onBeat: beat,
    })

    expect(res.imported).toBe(5)
    expect(h.gate).toHaveBeenCalledTimes(2)
    expect(h.gate.mock.calls[0][0]).toBe(controller.signal)
    expect(h.gate.mock.calls[0][1]).toEqual({ onPoll: beat })
  })

  it('inserts nothing while the gate is paused, and carries on when it opens', async () => {
    parser.batches = [batchOf(2, 'a')]
    let open!: () => void
    h.gate.mockImplementationOnce(() => new Promise<void>(resolve => { open = resolve }))
    const { streamCredentialsToTable } = await import('@/lib/upload-processor')

    const done = streamCredentialsToTable(webStream(), 'g.txt', { table: 'ulp.bench_x', pipeline: false })
    await tick()
    await tick()
    expect(h.insert).not.toHaveBeenCalled()

    open()
    const res = await done
    expect(h.insert).toHaveBeenCalledTimes(1)
    expect(res.imported).toBe(2)
  })

  it('stops the file, without inserting, when the wait is aborted', async () => {
    parser.batches = [batchOf(2, 'a'), batchOf(2, 'b')]
    h.gate.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const { streamCredentialsToTable } = await import('@/lib/upload-processor')

    await expect(
      streamCredentialsToTable(webStream(), 'g.txt', { table: 'ulp.bench_x', pipeline: false }),
    ).rejects.toThrow('aborted')
    expect(h.insert).not.toHaveBeenCalled()
  })
})
```

Create `/home/cole/ulp-suite/__tests__/inbox-watcher-disk-gate.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher — ingest disk gate wiring', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports waitForDiskSpace from lib/ingest-disk-gate', () => {
    expect(source).toMatch(/import\s*\{[^}]*waitForDiskSpace[^}]*\}\s*from\s*['"]@\/lib\/ingest-disk-gate['"]/)
  })

  test('the queued task waits for disk space before the memory guard, and both before the file is claimed', () => {
    const fnStart = source.indexOf('uploadQueue(async')
    const gateIdx = source.indexOf('waitForDiskSpace(', fnStart)
    const memIdx = source.indexOf('waitForHeadroom(', fnStart)
    const claimIdx = source.indexOf('claimFileForProcessing(filePath, PROC)')
    expect(fnStart).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(fnStart)
    expect(memIdx).toBeGreaterThan(gateIdx)
    expect(claimIdx).toBeGreaterThan(memIdx)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-processor-disk-gate.test.ts __tests__/inbox-watcher-disk-gate.test.ts 2>&1 | tail -25`
Expected: FAIL. The first file: `expected "spy" to be called 2 times, but got 0 times`; the second: the import regex does not match.

- [ ] **Step 3: Wire the batch loop**

In `/home/cole/ulp-suite/lib/upload-processor.ts`, add the import directly under the memory-guard import:

```ts
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { waitForDiskSpace } from '@/lib/ingest-disk-gate'
```

and replace this single line in `streamCredentialsToTable` (inside the `while (true)` loop):

```ts
      await waitForHeadroom(options.signal ?? new AbortController().signal, { onPoll: options.onBeat })
```

with:

```ts
      // Disk before memory: a full disk is the harsher condition. This pauses (it never fails) while the ClickHouse data disk is
      // under INGEST_MIN_FREE_BYTES and resumes by itself -- see lib/ingest-disk-gate.ts.
      const guardSignal = options.signal ?? new AbortController().signal
      await waitForDiskSpace(guardSignal, { onPoll: options.onBeat })
      await waitForHeadroom(guardSignal, { onPoll: options.onBeat })
```

- [ ] **Step 4: Wire the inbox watcher**

In `/home/cole/ulp-suite/lib/inbox-watcher.ts`, add the import under the `waitForHeadroom` import (line 42):

```ts
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { waitForDiskSpace } from '@/lib/ingest-disk-gate'
```

and in the queued task replace:

```ts
      const guardController = new AbortController()
      await waitForHeadroom(guardController.signal)
```

with:

```ts
      const guardController = new AbortController()
      // Disk first (lib/ingest-disk-gate.ts): while the data disk is under its floor the file stays in inbox/, unclaimed.
      await waitForDiskSpace(guardController.signal)
      await waitForHeadroom(guardController.signal)
```

- [ ] **Step 5: Keep the existing suites from hanging on the gate**

The gate fails closed, and several suites run the real batch loop against a mocked ClickHouse client whose answers have the wrong shape for it. They would pause forever. Switch the gate off for the whole test run (the gate's own suite passes `env` explicitly, so it is unaffected).

Create `/home/cole/ulp-suite/__tests__/setup/ingest-gate-off.ts`:

```ts
// The ingest disk gate (lib/ingest-disk-gate.ts) reads ClickHouse's disk and fails CLOSED. Many suites run the import loop
// against a mocked client whose answers have the wrong shape for it, which would pause every one of them forever. The gate has
// its own suite (it passes `env` explicitly) and scripts/e2e-disk-gate.ts exercises it for real on the rehearsal stack.
process.env.INGEST_DISK_GATE = 'off'
```

In `/home/cole/ulp-suite/vitest.config.ts` change:

```ts
    setupFiles: ['./__tests__/setup/sqlite-worker-setup.ts'],
```

to:

```ts
    setupFiles: ['./__tests__/setup/sqlite-worker-setup.ts', './__tests__/setup/ingest-gate-off.ts'],
```

- [ ] **Step 6: Run the new tests, then the suites that run the batch loop**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-processor-disk-gate.test.ts __tests__/inbox-watcher-disk-gate.test.ts __tests__/upload-processor.test.ts __tests__/import-pipeline.test.ts __tests__/inbox-watcher-memory-guard.test.ts __tests__/ingest-disk-gate.test.ts 2>&1 | tail -12`
Expected: PASS for all six files.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && git add lib/upload-processor.ts lib/inbox-watcher.ts __tests__/setup/ingest-gate-off.ts vitest.config.ts __tests__/upload-processor-disk-gate.test.ts __tests__/inbox-watcher-disk-gate.test.ts && git commit -F - <<'EOF'
feat(ingest): await the disk gate before every batch and before the inbox claims a file

Disk first, then the memory guard. HTTP uploads, the v1 API, ZIP entries and the inbox all pass through
streamCredentialsToTable, so one call covers them; the watcher also waits before moving a file into processing/.
The test run sets INGEST_DISK_GATE=off globally because the gate fails closed and many suites mock the client.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Banner logic, the disk endpoint, and the Ingest Health line

**Files:**
- Create: `/home/cole/ulp-suite/lib/disk-banner.ts`
- Create: `/home/cole/ulp-suite/app/api/monitoring/disk/route.ts`
- Modify: `/home/cole/ulp-suite/app/api/monitoring/ingest-health/route.ts` (the final `NextResponse.json`)
- Modify: `/home/cole/ulp-suite/components/ingest-health-panel.tsx`
- Test: `/home/cole/ulp-suite/__tests__/disk-banner.test.ts`, `/home/cole/ulp-suite/__tests__/disk-route.test.ts`; extend `/home/cole/ulp-suite/__tests__/ingest-health-disk.test.ts` and `/home/cole/ulp-suite/__tests__/ingest-health-panel.test.ts`

**Interfaces:**
- Consumes: `DiskReading` from `@/lib/disk-watch` (`readDisk(): Promise<DiskReading>`), `IngestDiskGateState` and `getIngestDiskGate()` from Task 1.
- Produces:
  - `type DiskBannerLevel = 'warn' | 'critical' | 'paused'`
  - `interface DiskBanner { level: DiskBannerLevel; message: string }`
  - `interface DiskBannerPayload { disk: DiskReading | null; gate: IngestDiskGateState | null }`
  - `describeDiskBanner(disk: DiskReading | null, gate: IngestDiskGateState | null): DiskBanner | null`
  - `GET /api/monitoring/disk` -> `{ disk: DiskReading, gate: IngestDiskGateState }` (401 / 403 like the other monitoring routes)
  - `GET /api/monitoring/ingest-health` gains `ingestGate: IngestDiskGateState`

- [ ] **Step 1: Write the failing tests**

Create `/home/cole/ulp-suite/__tests__/disk-banner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeDiskBanner } from '@/lib/disk-banner'
import type { DiskReading } from '@/lib/disk-watch'
import type { IngestDiskGateState } from '@/lib/ingest-disk-gate'

const GiB = 1024 ** 3
const reading = (status: DiskReading['status'], freeGiB: number | null): DiskReading => ({
  status,
  freeBytes: freeGiB === null ? null : freeGiB * GiB,
  totalBytes: freeGiB === null ? null : 936.8 * GiB,
  freeRatio: freeGiB === null ? null : freeGiB / 936.8,
  thresholds: freeGiB === null ? null : { warnBytes: 187.4 * GiB, criticalBytes: 140.5 * GiB },
  checkedAt: 0,
})
const gate = (over: Partial<IngestDiskGateState> = {}): IngestDiskGateState => ({
  enabled: true, paused: false, since: null, waiters: 0, freeBytes: null, floorBytes: 50 * GiB, resumeBytes: 55 * GiB, checkedAt: null, ...over,
})

describe('describeDiskBanner', () => {
  it('shows nothing when the disk is fine, unknown, or not known yet', () => {
    expect(describeDiskBanner(reading('ok', 300), gate())).toBeNull()
    expect(describeDiskBanner(reading('unknown', null), gate())).toBeNull()
    expect(describeDiskBanner(null, null)).toBeNull()
  })

  it('critical: says how much is free, what is blocked and where imports pause', () => {
    expect(describeDiskBanner(reading('critical', 121.5), gate())).toEqual({
      level: 'critical',
      message: 'Disk critical: 121.5 GiB free of 936.8 GiB (13%). Dedup and projection jobs are blocked below 140.5 GiB; imports pause below 50.0 GiB.',
    })
  })

  it('warn: the same facts in a softer voice', () => {
    expect(describeDiskBanner(reading('warn', 150), gate())).toEqual({
      level: 'warn',
      message: 'Disk is getting low: 150.0 GiB free of 936.8 GiB (16%). Dedup and projection jobs stop below 140.5 GiB; imports pause below 50.0 GiB.',
    })
  })

  it('an older server that sends no gate state still gets a banner, without the imports clause', () => {
    expect(describeDiskBanner(reading('critical', 121.5), null)?.message).toBe(
      'Disk critical: 121.5 GiB free of 936.8 GiB (13%). Dedup and projection jobs are blocked below 140.5 GiB.',
    )
  })

  it('does not claim that imports pause when the gate is switched off', () => {
    expect(describeDiskBanner(reading('critical', 121.5), gate({ enabled: false }))?.message).toBe(
      'Disk critical: 121.5 GiB free of 936.8 GiB (13%). Dedup and projection jobs are blocked below 140.5 GiB.',
    )
    expect(describeDiskBanner(reading('warn', 150), gate({ enabled: false }))?.message).not.toContain('imports pause')
  })

  it('paused beats critical: imports are the thing the operator is waiting for', () => {
    expect(describeDiskBanner(reading('critical', 48.2), gate({ paused: true, waiters: 1, freeBytes: 48.2 * GiB }))).toEqual({
      level: 'paused',
      message: 'Imports are paused: 48.2 GiB free, floor 50.0 GiB. They resume by themselves above 55.0 GiB.',
    })
  })

  it('paused with an unreadable disk says why', () => {
    const b = describeDiskBanner(null, gate({ paused: true, waiters: 1, error: 'connection refused' }))
    expect(b).toEqual({
      level: 'paused',
      message: 'Imports are paused: free space could not be read (connection refused). They resume by themselves above 55.0 GiB.',
    })
  })
})
```

Create `/home/cole/ulp-suite/__tests__/disk-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn(), requireAdminRole: vi.fn() }))
vi.mock('@/lib/disk-watch', () => ({ readDisk: vi.fn() }))
vi.mock('@/lib/ingest-disk-gate', () => ({ getIngestDiskGate: vi.fn() }))

import { validateRequest, requireAdminRole } from '@/lib/auth'
import { readDisk } from '@/lib/disk-watch'
import { getIngestDiskGate } from '@/lib/ingest-disk-gate'
import { GET } from '@/app/api/monitoring/disk/route'

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  m(validateRequest).mockReset().mockResolvedValue({ role: 'admin' })
  m(requireAdminRole).mockReset().mockReturnValue(null)
  m(readDisk).mockReset().mockResolvedValue({ status: 'critical', freeBytes: 1 })
  m(getIngestDiskGate).mockReset().mockReturnValue({ paused: true, waiters: 1 })
})

describe('GET /api/monitoring/disk', () => {
  it('returns the disk reading and the gate state to an admin', async () => {
    const res = await GET({} as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disk: { status: 'critical', freeBytes: 1 }, gate: { paused: true, waiters: 1 } })
  })

  it.each([401, 403])('answers %i without touching the disk when the caller is refused', async status => {
    m(requireAdminRole).mockReturnValue(NextResponse.json({ success: false }, { status }))
    const res = await GET({} as any)
    expect(res.status).toBe(status)
    expect(readDisk).not.toHaveBeenCalled()
    expect(getIngestDiskGate).not.toHaveBeenCalled()
  })
})
```

Append to `/home/cole/ulp-suite/__tests__/ingest-health-disk.test.ts`, inside the existing `describe('GET /api/monitoring/ingest-health — free space on the data disk', ...)` block, before its closing `})`:

```ts
  test('reports whether imports are paused for lack of disk space', async () => {
    const json = await (await get()).json()
    expect(json.ingestGate).toMatchObject({ paused: false, waiters: 0, floorBytes: 50 * GiB })
  })
```

Append to `/home/cole/ulp-suite/__tests__/ingest-health-panel.test.ts` (new block at the end of the file):

```ts
describe('Ingest Health panel — imports paused for lack of disk space', () => {
  test('shows a red line while the ingest disk gate is holding imports back', () => {
    expect(panel).toContain('data-testid="ingest-paused"')
    expect(panel).toContain('Imports paused: waiting for disk space')
    expect(panel).toContain('free space unreadable')
  })

  test('the block is optional in the payload, so an older server response still renders', () => {
    expect(panel).toMatch(/ingestGate\?: \{/)
    expect(panel).toContain('{ingestGate?.paused && (')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/disk-banner.test.ts __tests__/disk-route.test.ts __tests__/ingest-health-disk.test.ts __tests__/ingest-health-panel.test.ts 2>&1 | tail -25`
Expected: FAIL: the banner and route modules cannot be resolved; the two extended files fail their new tests.

- [ ] **Step 3: Write the pure banner module**

Create `/home/cole/ulp-suite/lib/disk-banner.ts`:

```ts
/**
 * What the disk banner under the header says. Pure on purpose: the client component imports this file, so it may only
 * `import type` from server modules (a value import would pull the ClickHouse client into the browser bundle).
 *
 * Levels: `paused` (imports are waiting for disk space; wins over the rest, it is what the operator is waiting for),
 * `critical` and `warn` (the passive disk watcher's status, lib/disk-watch.ts). `ok`, `unknown` and "not known yet" show nothing:
 * a transient unreadable disk already logs and shows in the Ingest Health panel, and a permanent banner for it would teach the
 * operator to ignore banners.
 */
import type { DiskReading } from '@/lib/disk-watch'
import type { IngestDiskGateState } from '@/lib/ingest-disk-gate'

export type DiskBannerLevel = 'warn' | 'critical' | 'paused'

export interface DiskBanner {
  level: DiskBannerLevel
  message: string
}

/** The body of GET /api/monitoring/disk. */
export interface DiskBannerPayload {
  disk: DiskReading | null
  gate: IngestDiskGateState | null
}

const GiB = 1024 ** 3
const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`

export function describeDiskBanner(disk: DiskReading | null, gate: IngestDiskGateState | null): DiskBanner | null {
  if (gate?.paused) {
    const free =
      gate.freeBytes === null
        ? `free space could not be read${gate.error ? ` (${gate.error})` : ''}`
        : `${gib(gate.freeBytes)} free, floor ${gib(gate.floorBytes)}`
    return {
      level: 'paused',
      message: `Imports are paused: ${free}. They resume by themselves above ${gib(gate.resumeBytes)}.`,
    }
  }
  if (!disk || (disk.status !== 'warn' && disk.status !== 'critical')) return null
  if (disk.freeBytes === null || disk.totalBytes === null || disk.freeRatio === null || !disk.thresholds) return null

  const space = `${gib(disk.freeBytes)} free of ${gib(disk.totalBytes)} (${Math.round(disk.freeRatio * 100)}%)`
  const jobs = `Dedup and projection jobs ${disk.status === 'critical' ? 'are blocked' : 'stop'} below ${gib(disk.thresholds.criticalBytes)}`
  const imports = gate?.enabled ? `; imports pause below ${gib(gate.floorBytes)}` : ''
  return disk.status === 'critical'
    ? { level: 'critical', message: `Disk critical: ${space}. ${jobs}${imports}.` }
    : { level: 'warn', message: `Disk is getting low: ${space}. ${jobs}${imports}.` }
}
```

- [ ] **Step 4: Write the endpoint**

Create `/home/cole/ulp-suite/app/api/monitoring/disk/route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { readDisk } from '@/lib/disk-watch'
import { getIngestDiskGate } from '@/lib/ingest-disk-gate'

export const dynamic = 'force-dynamic'

/** What the disk banner under the header shows: free space on the ClickHouse data disk and the ingest gate's state. */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  // readDisk never throws: an unreadable disk comes back as status 'unknown'.
  return NextResponse.json({ disk: await readDisk(), gate: getIngestDiskGate() })
}
```

- [ ] **Step 5: Add the gate to Ingest Health (route and panel)**

In `/home/cole/ulp-suite/app/api/monitoring/ingest-health/route.ts` add the import next to the other lib imports:

```ts
import { getIngestDiskGate } from '@/lib/ingest-disk-gate'
```

and replace the last line of `GET`:

```ts
  return NextResponse.json({ app: getIngestMetrics(), clickhouse, diskBudget, disk, backup: readBackupStatus(), searchDictionary })
```

with:

```ts
  return NextResponse.json({
    app: getIngestMetrics(), clickhouse, diskBudget, disk, ingestGate: getIngestDiskGate(), backup: readBackupStatus(), searchDictionary,
  })
```

In `/home/cole/ulp-suite/components/ingest-health-panel.tsx`:

1. In `interface IngestHealth`, after the `disk?: { ... }` member, add:

```ts
  // Imports waiting for disk space (lib/ingest-disk-gate.ts).
  ingestGate?: {
    paused: boolean
    freeBytes: number | null
    floorBytes: number
    resumeBytes: number
    error?: string
  }
```

2. Change the destructuring line to include it:

```ts
  const { app, clickhouse, diskBudget, disk, ingestGate, backup, searchDictionary } = data
```

3. Directly above `{backup && (` add:

```tsx
        {ingestGate?.paused && (
          <div className="text-xs border-t pt-3 text-red-600 font-medium" data-testid="ingest-paused" role="status">
            Imports paused: waiting for disk space
            {ingestGate.freeBytes === null
              ? ` (free space unreadable${ingestGate.error ? `: ${ingestGate.error}` : ""})`
              : ` (${fmtGB(ingestGate.freeBytes)} free, floor ${fmtGB(ingestGate.floorBytes)})`}
          </div>
        )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/disk-banner.test.ts __tests__/disk-route.test.ts __tests__/ingest-health-disk.test.ts __tests__/ingest-health-panel.test.ts __tests__/ingest-health-route.test.ts 2>&1 | tail -15`
Expected: PASS for all five files.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && git add lib/disk-banner.ts app/api/monitoring/disk/route.ts app/api/monitoring/ingest-health/route.ts components/ingest-health-panel.tsx __tests__/disk-banner.test.ts __tests__/disk-route.test.ts __tests__/ingest-health-disk.test.ts __tests__/ingest-health-panel.test.ts && git commit -F - <<'EOF'
feat(monitoring): a disk endpoint, the banner's wording, and the ingest gate in Ingest Health

GET /api/monitoring/disk (admin) returns the disk reading and the gate state. describeDiskBanner turns them into one of
paused / critical / warn / nothing. The Ingest Health panel shows a red line while imports wait for disk space.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: The banner component and the layout

**Files:**
- Create: `/home/cole/ulp-suite/components/disk-banner.tsx`
- Modify: `/home/cole/ulp-suite/components/client-layout-with-sidebar.tsx`
- Test: `/home/cole/ulp-suite/__tests__/disk-banner-component.test.ts`

**Interfaces:**
- Consumes: `describeDiskBanner`, `DiskBanner`, `DiskBannerPayload` from `@/lib/disk-banner` (Task 3); `GET /api/monitoring/disk`.
- Produces: default export `DiskBanner` React component (no props).

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/disk-banner-component.test.ts` (source-contract style, like `ingest-health-panel.test.ts`; the repo has no DOM test environment):

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const banner = readFileSync(new URL('../components/disk-banner.tsx', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../components/client-layout-with-sidebar.tsx', import.meta.url), 'utf8')

describe('DiskBanner component', () => {
  test('is a client component that polls the disk endpoint every minute while the tab is visible', () => {
    expect(banner.startsWith('"use client"')).toBe(true)
    expect(banner).toContain('fetch("/api/monitoring/disk", { cache: "no-store" })')
    expect(banner).toContain('const POLL_MS = 60_000')
    expect(banner).toContain('document.visibilityState')
    expect(banner).toContain('visibilitychange')
  })

  test('shows nothing for a refusal (logged out, not an admin) and keeps the last banner through a network blip', () => {
    expect(banner).toContain('if (!res.ok) {')
    expect(banner).toContain('setBanner(null)')
    expect(banner).toMatch(/catch \{\s*\/\*/)
  })

  test('uses the pure wording module and imports nothing from the server side', () => {
    expect(banner).toContain('describeDiskBanner(data.disk, data.gate)')
    expect(banner).not.toMatch(/from "@\/lib\/(clickhouse|disk-watch|ingest-disk-gate|auth)"/)
  })

  test('is an alert for critical and paused, a status for warn, and links to Ingest Health', () => {
    expect(banner).toContain('role={banner.level === "warn" ? "status" : "alert"}')
    expect(banner).toContain('data-testid="disk-banner"')
    expect(banner).toContain('href="/upload"')
    expect(banner).toContain('Ingest Health')
  })
})

describe('layout', () => {
  test('renders the banner between the header and the page, and not on the standalone pages', () => {
    expect(layout).toContain('import DiskBanner from "@/components/disk-banner"')
    const header = layout.indexOf('<AppHeader title={title} />')
    const banner = layout.indexOf('<DiskBanner />')
    const main = layout.indexOf('<main className="flex-1 bg-background">{children}</main>', header)
    expect(header).toBeGreaterThan(-1)
    expect(banner).toBeGreaterThan(header)
    expect(main).toBeGreaterThan(banner)
    const standalone = layout.slice(layout.indexOf('if (pathname === "/login"'), layout.indexOf('return (\n    <>'))
    expect(standalone).not.toContain('DiskBanner')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/disk-banner-component.test.ts 2>&1 | tail -12`
Expected: FAIL: `ENOENT ... components/disk-banner.tsx`.

- [ ] **Step 3: Write the component**

Create `/home/cole/ulp-suite/components/disk-banner.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { describeDiskBanner, type DiskBanner as DiskBannerState, type DiskBannerPayload } from "@/lib/disk-banner"

const POLL_MS = 60_000

const STYLES: Record<DiskBannerState["level"], string> = {
  warn: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800",
  critical: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-100 dark:border-red-800",
  paused: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-100 dark:border-red-800",
}

/** A strip under the header, on every page, while the disk is low or imports are paused for lack of space. */
export default function DiskBanner() {
  const [banner, setBanner] = useState<DiskBannerState | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      if (document.visibilityState !== "visible") return
      try {
        const res = await fetch("/api/monitoring/disk", { cache: "no-store" })
        if (cancelled) return
        if (!res.ok) {
          // 401 (logged out) or 403 (not an admin): there is nothing to show this viewer.
          setBanner(null)
          return
        }
        const data = (await res.json()) as DiskBannerPayload
        if (!cancelled) setBanner(describeDiskBanner(data.disk, data.gate))
      } catch {
        /* a network blip keeps whatever the last poll showed */
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") poll()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  if (!banner) return null
  return (
    <div
      role={banner.level === "warn" ? "status" : "alert"}
      data-testid="disk-banner"
      data-level={banner.level}
      className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${STYLES[banner.level]}`}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{banner.message}</span>
      <Link href="/upload" className="shrink-0 underline underline-offset-2">
        Ingest Health
      </Link>
    </div>
  )
}
```

- [ ] **Step 4: Render it in the layout**

In `/home/cole/ulp-suite/components/client-layout-with-sidebar.tsx` add the import under the `AppHeader` import:

```tsx
import AppHeader from "@/components/app-header";
import DiskBanner from "@/components/disk-banner";
```

and change:

```tsx
        <AppHeader title={title} />
        <main className="flex-1 bg-background">{children}</main>
```

to:

```tsx
        <AppHeader title={title} />
        <DiskBanner />
        <main className="flex-1 bg-background">{children}</main>
```

- [ ] **Step 5: Run the test, typecheck and lint the two files**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/disk-banner-component.test.ts 2>&1 | tail -10 && npx tsc --noEmit && npx eslint components/disk-banner.tsx components/client-layout-with-sidebar.tsx`
Expected: PASS, `tsc` silent, eslint silent (if eslint reports the nested-worktree plugin conflict, run `npx eslint --no-eslintrc -c .eslintrc.json <files>`).

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && git add components/disk-banner.tsx components/client-layout-with-sidebar.tsx __tests__/disk-banner-component.test.ts && git commit -F - <<'EOF'
feat(ui): a disk banner under the header on every page

Amber for warn, red for critical and for "imports are paused", with the free space, the thresholds and a link to Ingest Health.
Polls GET /api/monitoring/disk once a minute while the tab is visible and shows nothing for a viewer the endpoint refuses.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `projection-scope` clears only what is there, and only when it can afford to

**Files:**
- Modify: `/home/cole/ulp-suite/lib/projection-scope.ts`
- Test: extend `/home/cole/ulp-suite/__tests__/projection-scope.test.ts`; create `/home/cole/ulp-suite/__tests__/projection-scope-tick.test.ts` and `/home/cole/ulp-suite/__tests__/projection-scope.live.test.ts`

**Interfaces:**
- Consumes: `checkDiskHeadroom()` and `formatBytes()` from `@/lib/clickhouse-disk-guard`; `getClient()` from `@/lib/clickhouse`.
- Produces:
  - `CLEAR_RESERVE_FACTOR = 1.1`, `CLEAR_RESERVE_MARGIN_BYTES = 5 GiB`
  - `clearProjectionNeedBytes(largestPartBytes: number): number`
  - `buildEligiblePartitionsSql(cutoff: string): string` now returns rows `{ partition, parts_with_projection, largest_part_bytes }`
  - `ProjectionScopeTickResult { cutoff: string; cleared: string[]; skipped: Array<{ partition: string; reason: string }> }`

- [ ] **Step 1: Write the failing tests**

Append to `/home/cole/ulp-suite/__tests__/projection-scope.test.ts` (new imports at the top of the file are `clearProjectionNeedBytes, CLEAR_RESERVE_MARGIN_BYTES` added to the existing import list from `@/lib/projection-scope`; the new block goes at the end):

```ts
describe('eligibility asks which parts really carry the projection', () => {
  test('reads system.projection_parts and joins the parent part for its size', () => {
    const sql = buildEligiblePartitionsSql('202605')
    expect(sql).toContain('FROM system.projection_parts AS pp')
    expect(sql).toContain('INNER JOIN system.parts AS pa ON pa.database = pp.database AND pa.table = pp.table AND pa.name = pp.parent_name')
    expect(sql).toContain(`pp.name = '${PROJECTION_NAME}'`)
    expect(sql).toContain('pp.active AND pa.active')
    expect(sql).toContain('max(pa.bytes_on_disk) AS largest_part_bytes')
  })
})

describe('clearProjectionNeedBytes', () => {
  test('is the largest part x 1.1 plus a 5 GiB margin', () => {
    const GiB = 1024 ** 3
    expect(CLEAR_RESERVE_MARGIN_BYTES).toBe(5 * GiB)
    expect(clearProjectionNeedBytes(58.64 * GiB)).toBe(Math.ceil(58.64 * GiB * 1.1) + 5 * GiB)
    expect(clearProjectionNeedBytes(0)).toBe(5 * GiB)
  })
})
```

Create `/home/cole/ulp-suite/__tests__/projection-scope-tick.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  eligible: [] as Array<{ partition: string; parts_with_projection: string; largest_part_bytes: string }>,
  free: 200 * 1024 ** 3,
  freeError: null as Error | null,
  exec: vi.fn(),
  query: vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ query: h.query, exec: h.exec }) }))

import { runProjectionScopeTick } from '@/lib/projection-scope'

const GiB = 1024 ** 3
const now = new Date('2026-10-11T05:00:00Z') // cutoff = 202608 with the default two-month window

beforeEach(() => {
  h.eligible = []
  h.free = 200 * GiB
  h.freeError = null
  h.exec.mockReset().mockResolvedValue(undefined)
  h.query.mockReset().mockImplementation(async ({ query }: { query: string }) => {
    if (query.includes('system.disks')) {
      if (h.freeError) throw h.freeError
      return { json: async () => [{ unreserved_space: h.free, total_space: 936.8 * GiB }] }
    }
    return { json: async () => h.eligible }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('runProjectionScopeTick', () => {
  it('issues no ALTER when no partition still carries the projection', async () => {
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res).toEqual({ cutoff: '202608', cleared: [], skipped: [] })
    expect(h.exec).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cleared=[none] skipped=[none]'))
  })

  it('queues the clear without waiting for it when there is room', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '3', largest_part_bytes: String(58.64 * GiB) }]
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.cleared).toEqual(['202607'])
    expect(res.skipped).toEqual([])
    expect(h.exec).toHaveBeenCalledTimes(1)
    expect(h.exec).toHaveBeenCalledWith({
      query: "ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '202607'",
      clickhouse_settings: { alter_sync: '0', mutations_sync: '0' },
    })
  })

  it('skips, and says why, when the disk cannot cover the part-sized reservation', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '3', largest_part_bytes: String(58.64 * GiB) }]
    h.free = 40 * GiB // needs about 69.5 GiB
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.cleared).toEqual([])
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0].partition).toBe('202607')
    expect(res.skipped[0].reason).toMatch(/needs about 6\d\.\d+ GiB free, has 40\.00 GiB/)
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('skips when free space cannot be read', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '1', largest_part_bytes: String(GiB) }]
    h.freeError = new Error('system.disks unavailable')
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.cleared).toEqual([])
    expect(res.skipped[0].reason).toContain('free space could not be read')
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('still goes on to the next partition after one is skipped', async () => {
    h.eligible = [
      { partition: '202606', parts_with_projection: '1', largest_part_bytes: String(300 * GiB) }, // cannot be afforded
      { partition: '202607', parts_with_projection: '1', largest_part_bytes: String(2 * GiB) },
    ]
    const res = await runProjectionScopeTick({ trigger: 'test', now })
    expect(res.skipped.map(s => s.partition)).toEqual(['202606'])
    expect(res.cleared).toEqual(['202607'])
  })

  it('never throws: a failing ALTER is logged and reported as an empty tick', async () => {
    h.eligible = [{ partition: '202607', parts_with_projection: '1', largest_part_bytes: String(GiB) }]
    h.exec.mockRejectedValue(new Error('Code: 517'))
    await expect(runProjectionScopeTick({ trigger: 'test', now })).resolves.toEqual({ cutoff: '', cleared: [], skipped: [] })
    expect(console.error).toHaveBeenCalled()
  })
})
```

Create `/home/cole/ulp-suite/__tests__/projection-scope.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

/**
 * LIVE, READ-ONLY check of the projection-scope eligibility query on a real ClickHouse of the production version. Skipped unless
 * PS_LIVE=1. It must run, and it may only name partitions that really carry proj_imported_desc, and never the newest one.
 *
 *   PS_LIVE=1 npx vitest run __tests__/projection-scope.live.test.ts
 */
const LIVE = process.env.PS_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

async function rows<T>(sql: string): Promise<T[]> {
  const { getClient } = await import('@/lib/clickhouse')
  const res = await getClient().query({ query: sql, format: 'JSONEachRow' })
  return (await res.json()) as T[]
}

describe.skipIf(!LIVE)('projection-scope eligibility on the live table', () => {
  test('with the cutoff pushed to the future, it names only partitions that carry the projection, and never the newest', async () => {
    const { buildEligiblePartitionsSql, PROJECTION_NAME } = await import('@/lib/projection-scope')
    const eligible = await rows<{ partition: string; largest_part_bytes: string }>(buildEligiblePartitionsSql('999999'))
    const carrying = new Set(
      (await rows<{ partition: string }>(
        `SELECT DISTINCT partition FROM system.projection_parts WHERE database = 'ulp' AND table = 'credentials' AND name = '${PROJECTION_NAME}' AND active`,
      )).map(r => r.partition),
    )
    const [{ newest }] = await rows<{ newest: string }>(
      "SELECT max(partition) AS newest FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active",
    )
    for (const r of eligible) {
      expect(carrying.has(r.partition), `${r.partition} carries the projection`).toBe(true)
      expect(r.partition).not.toBe(newest)
      expect(Number(r.largest_part_bytes)).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/projection-scope.test.ts __tests__/projection-scope-tick.test.ts 2>&1 | tail -25`
Expected: FAIL: `clearProjectionNeedBytes` is not exported; the SQL assertions on `system.projection_parts` fail; the tick tests fail on missing `skipped` and on the ALTER settings.

- [ ] **Step 3: Rewrite `lib/projection-scope.ts`**

Replace the whole of `/home/cole/ulp-suite/lib/projection-scope.ts` with (the cron-hours, window-months, cutoff and clear-SQL helpers are the existing ones, unchanged):

```ts
/**
 * Scopes the proj_imported_desc projection (DDL v14, lib/clickhouse-migrations.ts) to
 * recent partitions only, so the "browse by newest" speedup keeps costing storage
 * only where it's actually used. New inserts always land in the current month's
 * partition (imported_at DEFAULT now()), so recent data keeps the projection
 * automatically; this clears it from partitions once they age out of the window.
 *
 * CLEAR PROJECTION removes only the projection's redundant stored copy for that
 * partition -- the underlying rows in the base table are completely untouched, so
 * unlike lib/archive-old-partitions this needs no apply-gate: nothing unique is
 * ever at risk.
 *
 * It IS a replicated ALTER, though: it bumps the table's metadata version, and its mutation reserves the size of the part it
 * hard-links. So since 2026-10-11 the job only touches partitions whose parts still carry the projection
 * (system.projection_parts), skips a partition when free space cannot cover that reservation, and queues the ALTER without
 * waiting for it. See docs/superpowers/specs/2026-10-11-disk-safety-and-hygiene-design.md.
 */
import { getClient } from '@/lib/clickhouse'
import { checkDiskHeadroom, formatBytes } from '@/lib/clickhouse-disk-guard'

export const PROJECTION_NAME = 'proj_imported_desc'

const GiB = 1024 ** 3
/**
 * A CLEAR PROJECTION mutation reserves its part's size times this although it only hard-links (ClickHouse's own estimate).
 * On 2026-10-08 it kept two mutations postponed, and the table's ALTER queue behind them, once free space fell under that figure.
 */
export const CLEAR_RESERVE_FACTOR = 1.1
/** Headroom kept on top of the reservation. */
export const CLEAR_RESERVE_MARGIN_BYTES = 5 * GiB

/** Free space needed before a clear is worth queueing for a partition whose largest carrying part is `largestPartBytes`. */
export function clearProjectionNeedBytes(largestPartBytes: number): number {
  return Math.ceil(largestPartBytes * CLEAR_RESERVE_FACTOR) + CLEAR_RESERVE_MARGIN_BYTES
}

/** Cron interval in hours; 0 (or invalid) disables the scheduled job. Default 24. */
export function projectionScopeCronHours(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.PROJECTION_SCOPE_CRON_HOURS ?? '24', 10)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** How many months of the most recent data keep the projection. Default 2. */
export function projectionScopeWindowMonths(env: NodeJS.ProcessEnv = process.env): number {
  const m = parseInt(env.PROJECTION_SCOPE_WINDOW_MONTHS ?? '2', 10)
  return Number.isFinite(m) && m > 0 ? m : 2
}

/** First partition (YYYYMM string) that should KEEP the projection. Anything older is cleared. */
export function cutoffPartition(windowMonths: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - windowMonths, 1))
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Partitions to clear: older than the cutoff, NEVER the newest one, and only those whose active parts still carry the
 * projection (system.projection_parts). Before 2026-10-11 this listed every old partition, so the daily tick re-issued a
 * replicated ALTER that had nothing to do: it bumped the table's metadata version and, below the reservation, wedged the queue.
 * The cutoff is counted from the calendar, and nothing may have been imported for months (the newest row is 2026-08-28): without
 * the newest-partition rule the projection would be cleared from the only partition lib/newest-first.ts needs it on, as soon as
 * the calendar moved two months past it. `largest_part_bytes` is the size of the biggest part that would be rewritten, for the
 * free-space check.
 */
export function buildEligiblePartitionsSql(cutoff: string): string {
  return `SELECT pp.partition AS partition, count() AS parts_with_projection, max(pa.bytes_on_disk) AS largest_part_bytes
    FROM system.projection_parts AS pp
    INNER JOIN system.parts AS pa ON pa.database = pp.database AND pa.table = pp.table AND pa.name = pp.parent_name
    WHERE pp.database = 'ulp' AND pp.table = 'credentials' AND pp.name = '${PROJECTION_NAME}' AND pp.active AND pa.active
      AND pp.partition < '${cutoff}'
      AND pp.partition < (SELECT max(partition) FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active)
    GROUP BY pp.partition
    ORDER BY pp.partition`
}

export function buildClearProjectionSql(partition: string): string {
  return `ALTER TABLE ulp.credentials CLEAR PROJECTION ${PROJECTION_NAME} IN PARTITION '${partition}'`
}

let tickInFlight = false

export interface ProjectionScopeTickResult {
  cutoff: string
  cleared: string[]
  /** Partitions left alone this tick, with the reason. */
  skipped: Array<{ partition: string; reason: string }>
}

/** Clear proj_imported_desc from every partition older than the recency window that still carries it. Never throws. */
export async function runProjectionScopeTick(
  opts: { trigger?: string; now?: Date } = {},
): Promise<ProjectionScopeTickResult> {
  const trigger = opts.trigger ?? 'tick'
  const now = opts.now ?? new Date()
  if (tickInFlight) return { cutoff: '', cleared: [], skipped: [] }
  tickInFlight = true
  try {
    const cutoff = cutoffPartition(projectionScopeWindowMonths(), now)
    const client = getClient()
    const res = await client.query({ query: buildEligiblePartitionsSql(cutoff), format: 'JSONEachRow' })
    const rows = (await res.json()) as Array<{ partition: string; largest_part_bytes: string | number }>
    const cleared: string[] = []
    const skipped: Array<{ partition: string; reason: string }> = []
    for (const { partition, largest_part_bytes } of rows) {
      const need = clearProjectionNeedBytes(Number(largest_part_bytes))
      let reason: string | null = null
      try {
        const { freeBytes } = await checkDiskHeadroom()
        if (freeBytes < need) reason = `needs about ${formatBytes(need)} free, has ${formatBytes(freeBytes)}`
      } catch (err) {
        reason = `free space could not be read (${err instanceof Error ? err.message : String(err)})`
      }
      if (reason !== null) {
        console.warn(`[projection-scope] skipping ${partition}: ${reason}`)
        skipped.push({ partition, reason })
        continue
      }
      // Queue the mutation and return: it hard-links part by part and can sit behind other ALTERs, and the cron must not hold a
      // request open on it (before this it timed out at 60 s, and once waited 14.8 h on a wedged queue).
      await client.exec({
        query: buildClearProjectionSql(partition),
        clickhouse_settings: { alter_sync: '0', mutations_sync: '0' },
      })
      cleared.push(partition)
    }
    console.warn(
      `[projection-scope] ${trigger}: cutoff=${cutoff} cleared=[${cleared.join(', ') || 'none'}] ` +
        `skipped=[${skipped.map(s => s.partition).join(', ') || 'none'}]`,
    )
    return { cutoff, cleared, skipped }
  } catch (err) {
    console.error('[projection-scope] tick failed:', err)
    return { cutoff: '', cleared: [], skipped: [] }
  } finally {
    tickInFlight = false
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/projection-scope.test.ts __tests__/projection-scope-tick.test.ts __tests__/projection-scope.live.test.ts 2>&1 | tail -20`
Expected: PASS; the live file is reported as skipped. The three original SQL assertions in `projection-scope.test.ts` pass unchanged.

- [ ] **Step 5: Run the live, read-only check against the real server**

Run: `cd /home/cole/ulp-suite && PS_LIVE=1 npx vitest run __tests__/projection-scope.live.test.ts 2>&1 | tail -10`
Expected: PASS (today the eligible set is empty, so the loop asserts nothing; it proves the query runs on ClickHouse 26.3).

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && git add lib/projection-scope.ts __tests__/projection-scope.test.ts __tests__/projection-scope-tick.test.ts __tests__/projection-scope.live.test.ts && git commit -F - <<'EOF'
fix(projection-scope): clear only partitions that still carry the projection, and only when the reservation fits

The daily CLEAR PROJECTION on a partition that no longer had the projection was a pure no-op, yet a replicated ALTER: it bumped
the metadata version and reserved part size x 1.1, which on a nearly full disk postponed it and the table's whole ALTER queue.
Eligibility now comes from system.projection_parts, a partition is skipped (and logged) when free space is under
largest part x 1.1 + 5 GiB, and the ALTER is queued with alter_sync=0 so the cron never holds a request on it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Crons that really fire at their anchor hour

**Files:**
- Create: `/home/cole/ulp-suite/lib/daily-schedule.ts`
- Modify: `/home/cole/ulp-suite/lib/dedup-cron.ts`, `/home/cole/ulp-suite/lib/projection-scope-cron.ts`
- Test: create `/home/cole/ulp-suite/__tests__/daily-schedule.test.ts`; modify `/home/cole/ulp-suite/__tests__/dedup-cron.test.ts` and `/home/cole/ulp-suite/__tests__/projection-scope-cron.test.ts`

**Interfaces:**
- Produces:
  - `msUntilNextRun(hourUtc: number, now: Date): number` (moved here; still re-exported by `lib/dedup-cron.ts`)
  - `scheduleEveryHoursFromAnchor(opts: { anchorHourUtc: number; everyHours: number; run: () => unknown; now?: () => number; pollMs?: number }): { cancel(): void; nextRunAt(): number }`

- [ ] **Step 1: Write the failing tests**

Create `/home/cole/ulp-suite/__tests__/daily-schedule.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { msUntilNextRun, scheduleEveryHoursFromAnchor } from '@/lib/daily-schedule'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('msUntilNextRun', () => {
  it('is the delay until the anchor hour later today', () => {
    expect(msUntilNextRun(4, new Date('2026-06-27T02:31:00Z'))).toBe(89 * 60_000)
  })
  it('rolls over to tomorrow when the hour has passed or is exactly now', () => {
    expect(msUntilNextRun(4, new Date('2026-06-27T05:00:00Z'))).toBe(Date.parse('2026-06-28T04:00:00Z') - Date.parse('2026-06-27T05:00:00Z'))
    expect(msUntilNextRun(4, new Date('2026-06-27T04:00:00.000Z'))).toBe(24 * 3_600_000)
  })
})

describe('scheduleEveryHoursFromAnchor', () => {
  it('runs at the anchor hour, then every N hours from it, not from when it was armed', async () => {
    vi.setSystemTime(new Date('2026-10-06T02:31:00Z'))
    const run = vi.fn()
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    expect(new Date(s.nextRunAt()).toISOString()).toBe('2026-10-06T04:00:00.000Z')

    await vi.advanceTimersByTimeAsync(88 * 60_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(new Date(s.nextRunAt()).toISOString()).toBe('2026-10-07T04:00:00.000Z')

    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(run).toHaveBeenCalledTimes(2)
    s.cancel()
  })

  it('never drifts to the arming time of day', async () => {
    vi.setSystemTime(new Date('2026-10-05T23:32:59Z')) // the app's real start time on 2026-10-05
    const times: string[] = []
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 5, everyHours: 24, run: () => { times.push(new Date().toISOString().slice(0, 13)) } })
    await vi.advanceTimersByTimeAsync(3 * 24 * 3_600_000)
    expect(times).toEqual(['2026-10-06T05', '2026-10-07T05', '2026-10-08T05'])
    s.cancel()
  })

  it('honours a period shorter than a day, anchored to the first slot', async () => {
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
    const times: string[] = []
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 5, everyHours: 6, run: () => { times.push(new Date().toISOString().slice(11, 13)) } })
    await vi.advanceTimersByTimeAsync(18 * 3_600_000)
    expect(times).toEqual(['05', '11', '17'])
    s.cancel()
  })

  it('after a long suspend it runs once, not once per missed slot, and re-arms for the next future slot', async () => {
    vi.setSystemTime(new Date('2026-10-06T02:00:00Z'))
    const run = vi.fn()
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z')) // the laptop slept for three days
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(new Date(s.nextRunAt()).toISOString()).toBe('2026-10-10T04:00:00.000Z')
    s.cancel()
  })

  it('cancel stops it', async () => {
    vi.setSystemTime(new Date('2026-10-06T02:00:00Z'))
    const run = vi.fn()
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    s.cancel()
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('a failing run is logged and the schedule goes on', async () => {
    vi.setSystemTime(new Date('2026-10-06T03:59:00Z'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('run failed'), expect.any(Error))
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(run).toHaveBeenCalledTimes(2)
    s.cancel()
  })
})
```

Replace the two source-contract blocks in `/home/cole/ulp-suite/__tests__/dedup-cron.test.ts`:

- the block `describe('dedup-cron source contract', ...)` becomes:

```ts
describe('dedup-cron source contract', () => {
  const source = readFileSync(new URL('../lib/dedup-cron.ts', import.meta.url), 'utf8')

  test('schedules through scheduleEveryHoursFromAnchor, not a boot-relative setTimeout + setInterval pair', () => {
    expect(source).toContain('scheduleEveryHoursFromAnchor(')
    expect(source).not.toContain('setInterval(')
    expect(source).not.toContain('setTimeout(')
  })

  test('still exports msUntilNextRun for its callers', () => {
    expect(source).toMatch(/export \{ msUntilNextRun \}/)
  })
})
```

- the test inside `describe('dedup-cron idle short-circuit contract', ...)` becomes:

```ts
  test('the cron call site opts into the idle short-circuit', () => {
    const calls = source.match(/runContentDedupTick\(\{[^}]*\}\)/g) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('skipIfUnchanged: true')
  })
```

Replace the whole of `/home/cole/ulp-suite/__tests__/projection-scope-cron.test.ts` with:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('projection-scope-cron source contract', () => {
  const source = readFileSync(new URL('../lib/projection-scope-cron.ts', import.meta.url), 'utf8')

  test('uses the shared scheduler instead of its own timers', () => {
    expect(source).toContain("import { msUntilNextRun, scheduleEveryHoursFromAnchor } from '@/lib/daily-schedule'")
    expect(source).toContain('scheduleEveryHoursFromAnchor(')
    expect(source).not.toContain('setInterval(')
    expect(source).not.toContain('setTimeout(')
  })
  test('anchors to 05:00 UTC, one hour after the dedup cron', () => {
    expect(source).toContain('anchorHourUtc: 5')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/daily-schedule.test.ts __tests__/dedup-cron.test.ts __tests__/projection-scope-cron.test.ts 2>&1 | tail -20`
Expected: FAIL: `@/lib/daily-schedule` cannot be resolved; the two cron contracts fail.

- [ ] **Step 3: Write the scheduler**

Create `/home/cole/ulp-suite/lib/daily-schedule.ts`:

```ts
/**
 * Runs a job every N hours, counted from an anchor hour of the UTC day.
 *
 * lib/dedup-cron.ts and lib/projection-scope-cron.ts used to arm `setTimeout(first tick at the anchor hour)` and
 * `setInterval(24 h)` side by side at boot. The interval starts at boot, so after the first anchored tick both fired at the
 * boot time of day instead (observed: 23:32:59Z on 2026-10-06..09 instead of 04:00Z and 05:00Z). This keeps the next slot as a
 * wall-clock time and compares it with the clock every 30 s. That also survives a laptop suspend: Node timers run on the
 * monotonic clock, which does not advance while the machine sleeps, so one long timer would land late by the length of the sleep.
 * After a long gap it runs once (not once per missed slot) and re-arms for the next slot still in the future.
 */

/** Ms from `now` until the next `hourUtc:00 UTC` (today if still ahead, else tomorrow). */
export function msUntilNextRun(hourUtc: number, now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

export interface DailyScheduleOptions {
  /** Hour of the UTC day of the first run. */
  anchorHourUtc: number
  /** Hours between runs, counted from the first run. */
  everyHours: number
  /** The job. Its result is ignored; a returned promise is awaited only so that a rejection is logged. */
  run: () => unknown
  /** Wall clock in ms; tests replace it. */
  now?: () => number
  pollMs?: number
}

export interface DailySchedule {
  cancel(): void
  /** When the next run is due (epoch ms). */
  nextRunAt(): number
}

export function scheduleEveryHoursFromAnchor(opts: DailyScheduleOptions): DailySchedule {
  const now = opts.now ?? Date.now
  const stepMs = opts.everyHours * 3_600_000
  let next = now() + msUntilNextRun(opts.anchorHourUtc, new Date(now()))

  const check = () => {
    const t = now()
    if (t < next) return
    do next += stepMs
    while (next <= t)
    Promise.resolve()
      .then(() => opts.run())
      .catch(err => console.error('[daily-schedule] run failed:', err))
  }

  const timer = setInterval(check, opts.pollMs ?? 30_000)
  timer.unref?.()
  return { cancel: () => clearInterval(timer), nextRunAt: () => next }
}
```

- [ ] **Step 4: Use it in both crons**

Replace the whole of `/home/cole/ulp-suite/lib/dedup-cron.ts` with:

```ts
/**
 * Scheduled content-dedup re-run.
 *
 * Ticks every DEDUP_CRON_HOURS hours (default 24; 0 disables) and runs
 * runContentDedupTick() — report-only unless CONTENT_DEDUP_APPLY=true. The NODE_ENV
 * guard in instrumentation.ts prevents dev hot-reload double-registration.
 *
 * The first tick is anchored to a fixed UTC hour (DEDUP_CRON_HOUR_UTC, default
 * 04:00) rather than firing 60s after container start — a startup-relative
 * timer lands its daily recurrence at whatever wall-clock time the container
 * last happened to (re)start, which on 2026-06-27 put it in the middle of a
 * heavy-query window. SETTINGS still bound the stats query itself. Cron ticks pass
 * skipIfUnchanged: the tick skips its heavy stats scan while the table's row count is
 * unchanged since the last pass (see runContentDedupTick).
 *
 * Until 2026-10-11 only the FIRST tick was anchored: the 24 h interval was armed at boot, so every later tick fired at the
 * boot time of day. lib/daily-schedule.ts keeps every slot on the anchor hour, through restarts and laptop suspends.
 */
import { dedupCronHours, dedupCronHourUtc, runContentDedupTick } from '@/lib/content-dedup'
import { msUntilNextRun, scheduleEveryHoursFromAnchor } from '@/lib/daily-schedule'

// Existing callers and tests import it from here.
export { msUntilNextRun }

let started = false

export function startDedupCron(): void {
  if (started) return
  const hours = dedupCronHours()
  if (hours <= 0) {
    console.log('[content-dedup] cron disabled (DEDUP_CRON_HOURS=0)')
    return
  }
  started = true
  const hourUtc = dedupCronHourUtc()
  const initialDelay = msUntilNextRun(hourUtc, new Date())
  console.warn(
    `[content-dedup] cron started — first tick in ${Math.round(initialDelay / 60_000)}m ` +
      `(anchored to ${String(hourUtc).padStart(2, '0')}:00 UTC), then every ${hours}h`,
  )
  scheduleEveryHoursFromAnchor({
    anchorHourUtc: hourUtc,
    everyHours: hours,
    run: () => runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true }),
  })
}
```

Replace the whole of `/home/cole/ulp-suite/lib/projection-scope-cron.ts` with:

```ts
/**
 * Scheduled proj_imported_desc scoping.
 *
 * Ticks every PROJECTION_SCOPE_CRON_HOURS hours (default 24; 0 disables) and runs runProjectionScopeTick() to clear the recency
 * projection from partitions that have aged out of the window and still carry it. Anchored to 05:00 UTC (one hour after the dedup
 * cron's 04:00) so the two crons don't compete for ClickHouse resources at the same instant. The schedule is
 * lib/daily-schedule.ts, shared with the dedup cron, so the recurrence stays on the anchor hour after a restart or a suspend.
 */
import { msUntilNextRun, scheduleEveryHoursFromAnchor } from '@/lib/daily-schedule'
import { projectionScopeCronHours, runProjectionScopeTick } from '@/lib/projection-scope'

let started = false

export function startProjectionScopeCron(): void {
  if (started) return
  const hours = projectionScopeCronHours()
  if (hours <= 0) {
    console.log('[projection-scope] cron disabled (PROJECTION_SCOPE_CRON_HOURS=0)')
    return
  }
  started = true
  const initialDelay = msUntilNextRun(5, new Date())
  console.warn(
    `[projection-scope] cron started — first tick in ${Math.round(initialDelay / 60_000)}m ` +
      `(anchored to 05:00 UTC), then every ${hours}h`,
  )
  scheduleEveryHoursFromAnchor({
    anchorHourUtc: 5,
    everyHours: hours,
    run: () => runProjectionScopeTick({ trigger: 'cron' }),
  })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/daily-schedule.test.ts __tests__/dedup-cron.test.ts __tests__/projection-scope-cron.test.ts __tests__/content-dedup-stats-skip.test.ts 2>&1 | tail -15`
Expected: PASS for all four files.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && git add lib/daily-schedule.ts lib/dedup-cron.ts lib/projection-scope-cron.ts __tests__/daily-schedule.test.ts __tests__/dedup-cron.test.ts __tests__/projection-scope-cron.test.ts && git commit -F - <<'EOF'
fix(cron): the dedup and projection-scope crons stay on their anchor hour

Both armed setTimeout(anchor) and setInterval(24h) at boot, so after the first anchored tick they fired at the boot time of day
(23:32:59Z on 2026-10-06..09 instead of 04:00Z / 05:00Z). A shared scheduler keeps the next slot as a wall-clock time and checks
it every 30 s, which also survives a laptop suspend; after a long gap it runs once, not once per missed slot.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Configuration and documentation of the gate

**Files:**
- Modify: `/home/cole/ulp-suite/docker-compose.yml` (app service environment, after `UPLOAD_SPOOL_MIN_FREE_BYTES`)
- Modify: `/home/cole/ulp-suite/.env.example`, `/home/cole/ulp-suite/README.md`
- Test: `/home/cole/ulp-suite/__tests__/ingest-disk-gate-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ingest-disk-gate-config.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** The `app:` service block (up to the next top-level service). */
const appService = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  # ─── clickhouse-backup'))

describe('ingest disk gate settings reach the container', () => {
  test.each(['INGEST_MIN_FREE_BYTES', 'INGEST_DISK_GATE'])(
    '%s is forwarded with an empty default (so the code default applies) and documented',
    name => {
      expect(appService).toContain(`${name}: \${${name}:-}`)
      expect(envExample).toContain(name)
      expect(readme).toContain(name)
    },
  )
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-disk-gate-config.test.ts 2>&1 | tail -10`
Expected: FAIL (compose does not forward the variables yet).

- [ ] **Step 3: Forward the variables in compose**

In `/home/cole/ulp-suite/docker-compose.yml`, directly after the line `      UPLOAD_SPOOL_MIN_FREE_BYTES: ${UPLOAD_SPOOL_MIN_FREE_BYTES:-}` add:

```yaml
      # Ingest disk gate (lib/ingest-disk-gate.ts) -- optional; forwarded explicitly (see above). An import pauses, and resumes by
      # itself, while free space on the ClickHouse data disk is under INGEST_MIN_FREE_BYTES (empty = 50 GiB). INGEST_DISK_GATE=off
      # switches the gate off.
      INGEST_MIN_FREE_BYTES: ${INGEST_MIN_FREE_BYTES:-}
      INGEST_DISK_GATE: ${INGEST_DISK_GATE:-}
```

- [ ] **Step 4: Document them**

In `/home/cole/ulp-suite/.env.example`, directly after the `# UPLOAD_SPOOL_MIN_FREE_BYTES=21474836480` line add:

```
# ─── Ingest disk gate ───────────────────────────────
# An import pauses before its next batch, and resumes by itself, while free space on the ClickHouse data disk is under this many
# bytes (default 50 GiB; it resumes above 1.1x that). The Ingest Health panel and a banner under the header on every page say
# so. It never fails an import and has no timeout. INGEST_DISK_GATE=off switches it off.
# INGEST_MIN_FREE_BYTES=53687091200
# INGEST_DISK_GATE=off
```

In `/home/cole/ulp-suite/README.md`, in the `## Operations` section, replace this bullet:

```markdown
- **Disk space.** The app checks free space on the ClickHouse data disk every 10 minutes
  (`lib/disk-watch.ts`), logs a warning when it gets low, and shows it in the Ingest Health panel
  (Upload and Inbox pages). Optional: `DISK_ALERT_WEBHOOK_URL` also POSTs each alert to a
  Slack-compatible webhook; nothing is sent anywhere unless you set it. Heavy jobs (dedup, projection
  restores) refuse to start below the same floor.
```

with:

```markdown
- **Disk space.** The app checks free space on the ClickHouse data disk every 10 minutes
  (`lib/disk-watch.ts`), logs a warning when it gets low, and shows it in the Ingest Health panel
  (Upload and Inbox pages) and, for admins, in a banner under the header of every page (amber when low, red when critical or
  when imports are paused). Optional: `DISK_ALERT_WEBHOOK_URL` also POSTs each alert to a
  Slack-compatible webhook; nothing is sent anywhere unless you set it. Heavy jobs (dedup, projection
  restores) refuse to start below the same floor. **Imports pause, and resume by themselves,** while free space is under
  `INGEST_MIN_FREE_BYTES` (default 50 GiB; they resume above 1.1x that); a paused import never fails and has no timeout, and
  `INGEST_DISK_GATE=off` switches the gate off (`lib/ingest-disk-gate.ts`).
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-disk-gate-config.test.ts __tests__/upload-reliability-config.test.ts __tests__/compose-hardening.test.ts 2>&1 | tail -10`
Expected: PASS for all three files.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && git add docker-compose.yml .env.example README.md __tests__/ingest-disk-gate-config.test.ts && git commit -F - <<'EOF'
docs(ingest): forward and document INGEST_MIN_FREE_BYTES and INGEST_DISK_GATE

Compose forwards both with an empty default (the code default applies); .env.example and the README Operations section say
what the gate does, that a paused import never fails, and how to switch it off.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: The rehearsal check for the gate (`scripts/e2e-disk-gate.ts`)

**Files:**
- Modify: `/home/cole/ulp-suite/docker-compose.rehearsal.yml` (two env passthroughs on `app`)
- Create: `/home/cole/ulp-suite/scripts/e2e-disk-gate.ts`
- Test: the existing `/home/cole/ulp-suite/__tests__/rehearsal-isolation.test.ts` must keep passing

**Interfaces:**
- Consumes: the running rehearsal stack (`npx tsx scripts/e2e-alert-rehearsal.ts --keep`), `GET /api/monitoring/disk`, `GET /api/monitoring/ingest-health`, `POST /api/upload`.
- Produces: exit code 0 / 1 / 2 like the other e2e scripts.

- [ ] **Step 1: Let the rehearsal app take gate settings**

In `/home/cole/ulp-suite/docker-compose.rehearsal.yml`, after the `SEARCH_DICT_SETTLE_SECONDS: "5"` line in the `app` service, add:

```yaml
      # lib/ingest-disk-gate.ts: scripts/e2e-disk-gate.ts recreates the app with a floor taken from the host's real free space
      # (empty = the production defaults: a 50 GiB floor, the gate on).
      INGEST_MIN_FREE_BYTES: ${REHEARSAL_INGEST_MIN_FREE_BYTES:-}
      INGEST_DISK_GATE: ${REHEARSAL_INGEST_DISK_GATE:-}
```

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/rehearsal-isolation.test.ts 2>&1 | tail -8`
Expected: PASS (the isolation test pins names, mounts, ports and secrets; none of those changed).

- [ ] **Step 2: Write the script**

Create `/home/cole/ulp-suite/scripts/e2e-disk-gate.ts`:

```ts
/**
 * End-to-end check of the ingest disk gate (lib/ingest-disk-gate.ts) on the production image, against the ISOLATED rehearsal
 * stack (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * It recreates the rehearsal app with a floor derived from the host's real free space, then proves that an import
 *   1. goes straight through while free space is above the floor,
 *   2. waits once a filler file pushes free space under the floor, without failing (the stall watchdog is fed by the gate's
 *      heartbeat) and without inserting anything, while the banner endpoint and Ingest Health say so,
 *   3. carries on by itself when the filler is removed, importing every row exactly once,
 *   4. is not held at all with INGEST_DISK_GATE=off.
 * The floor is (free - 2 GiB) / 1.1, so the resume level (floor x 1.1) sits 2 GiB under the starting free space; the filler is
 * start free - floor + 1 GiB (about 13 GiB on a 120 GiB-free disk). It lives inside the rehearsal ClickHouse volume and is
 * removed in a `finally`; `docker compose down -v` removes it too.
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-disk-gate.ts                 # about 5 minutes; needs about 40 GiB of free host disk
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Exit 0 when every check passes, 1 when one fails, 2 when the stack is not ready or there is not enough room to run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const GiB = 1024 ** 3
const FILLER = '/var/lib/clickhouse/zz_disk_gate_filler'

if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_')) {
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

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-4).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

// --async_insert=0: the default profile buffers inserts, and this script reads what was written straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
const rowsFor = (source: string) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file = '${source}'`))
const freeBytes = () => Number(chQuery("SELECT unreserved_space FROM system.disks WHERE name = 'default'"))
/** The app's log, stdout and stderr (the gate logs with console.warn, which goes to stderr). */
const appLog = () => {
  const r = spawnSync('docker', ['logs', APP], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 1000): Promise<T | null> {
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
  console.log(`  ... gave up waiting for: ${label}`)
  return null
}

const RUN = Date.now().toString(36)
const work = mkdtempSync(join(tmpdir(), 'e2e-diskgate-'))
const dockerCfg = mkdtempSync(join(tmpdir(), 'e2e-diskgate-docker-'))
writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore

const genLines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `https://shop${i % 500}.example-store.test/login:${tag}${i}@probe-mail.test:Pw-${tag}${i}-Xy!`).join('\n') + '\n'

// ── the filler ──────────────────────────────────────────────────────────────────────────────
function fillDisk(bytes: number): void {
  const mib = Math.ceil(bytes / (1024 * 1024))
  try {
    sh('docker', ['exec', CH, 'fallocate', '-l', `${mib}M`, FILLER])
  } catch {
    sh('docker', ['exec', CH, 'sh', '-c', `dd if=/dev/zero of=${FILLER} bs=1M count=${mib} 2>/dev/null`])
  }
}

function removeFiller(): void {
  try {
    sh('docker', ['exec', CH, 'rm', '-f', FILLER])
  } catch {
    /* already gone, or the container is */
  }
}

// ── the app: recreate with the settings under test, log in, call it ────────────────────────────
let cookie = ''

const appEnv = (name: string) => sh('docker', ['exec', APP, 'printenv', name])

/** Recreates only the rehearsal app, keeping its data volume and its secrets, with the gate settings under test. */
async function recreateApp(settings: { floorBytes: number; gate: string }): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerCfg,
    REHEARSAL_JWT_SECRET: appEnv('JWT_SECRET'),
    REHEARSAL_ADMIN_EMAIL: appEnv('ADMIN_EMAIL'),
    REHEARSAL_ADMIN_PASSWORD: appEnv('ADMIN_PASSWORD'),
    REHEARSAL_WEBHOOK_SECRET: 'unused-here', // the compose file interpolates it; the receiver is not touched
    REHEARSAL_INGEST_MIN_FREE_BYTES: String(settings.floorBytes),
    REHEARSAL_INGEST_DISK_GATE: settings.gate,
  }
  sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, 'up', '-d', '--no-deps', '--force-recreate', 'app'], env)
  const up = await waitFor('app healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000, 2000)
  if (!up) return false
  await login()
  return true
}

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: appEnv('ADMIN_EMAIL'), password: appEnv('ADMIN_PASSWORD') }),
  })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}

const gate = async () => (await getJson('/api/monitoring/disk')).json?.gate

/** POST a small file with curl (the body is received into the spool before the server answers, so this returns quickly). */
function upload(name: string, text: string): { status: number; jobId: string | null } {
  const path = join(work, name)
  writeFileSync(path, text)
  const out = sh('curl', [
    '-sS', '-m', '120', '-w', '\n%{http_code}', '-X', 'POST',
    '-H', `cookie: ${cookie}`, '-H', 'content-type: application/octet-stream',
    '--data-binary', `@${path}`, `${BASE}/api/upload?filename=${encodeURIComponent(name)}`,
  ])
  const lines = out.split('\n')
  const status = Number(lines.pop())
  return { status, jobId: /"jobId":"([^"]+)"/.exec(lines.join('\n'))?.[1] ?? null }
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

// ── scenarios ───────────────────────────────────────────────────────────────────────────────
async function run(): Promise<number> {
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

  const start = freeBytes()
  const floor = Math.floor(((start - 2 * GiB) * 10) / 11)
  const resume = floor + Math.floor(floor / 10)
  const fillerBytes = start - floor + GiB
  info('free space at the start', `${(start / GiB).toFixed(1)} GiB`)
  info('floor / resume level', `${(floor / GiB).toFixed(1)} GiB / ${(resume / GiB).toFixed(1)} GiB`)
  info('filler', `${(fillerBytes / GiB).toFixed(1)} GiB`)
  if (start - fillerBytes < 20 * GiB) {
    console.error('Not enough free host disk space to run this safely: it would leave less than 20 GiB with the filler in place.')
    return 2
  }

  console.log('\n1. Free space above the floor: an upload goes straight through')
  if (!check('the rehearsal app restarted with the test floor', await recreateApp({ floorBytes: floor, gate: '' }))) return 1
  const probe = await getJson('/api/monitoring/disk')
  if (!check('the disk endpoint exists in this image (rebuild it with `docker compose build app` if not)', probe.status === 200, `HTTP ${probe.status}`)) return 2
  const nameA = `e2e-gate-a-${RUN}.txt`
  const a = upload(nameA, genLines(20_000, 'ga'))
  check('the upload was accepted', a.status === 200 && !!a.jobId, `HTTP ${a.status}`)
  const finalA = a.jobId ? await waitJob(a.jobId, 120_000) : null
  check('...and imported (status done)', finalA?.status === 'done', JSON.stringify(finalA))
  check('all 20000 rows are in ClickHouse', rowsFor(nameA) === 20_000, `rows ${rowsFor(nameA)}`)
  const g1 = await gate()
  check('the gate is idle and reports the configured floor and resume level', g1?.paused === false && g1?.floorBytes === floor && g1?.resumeBytes === resume, JSON.stringify(g1))

  console.log('\n2. A filler pushes free space under the floor: the next upload waits')
  fillDisk(fillerBytes)
  const low = await waitFor('free space under the floor', () => freeBytes() < floor, 60_000, 500)
  check('free space is now under the floor', !!low, `free ${freeBytes()} floor ${floor}`)
  // The gate reuses a free-space reading younger than 5 s (a batch every few seconds would otherwise cost a query each). Wait that
  // out, or the next job's first batch could be waved through on the reading taken before the filler existed.
  await sleep(6_000)
  const nameB = `e2e-gate-b-${RUN}.txt`
  const b = upload(nameB, genLines(30_000, 'gb'))
  check('the upload was accepted (the file is received into the spool first)', b.status === 200 && !!b.jobId, `HTTP ${b.status}`)
  const paused = await waitFor('the gate to pause', async () => (await gate())?.paused === true, 60_000)
  check('the disk endpoint reports the gate paused', !!paused)
  const health = await getJson('/api/monitoring/ingest-health')
  check('Ingest Health reports it too', health.json?.ingestGate?.paused === true, JSON.stringify(health.json?.ingestGate))
  await sleep(45_000) // longer than the rehearsal's 30 s stall timeout: only the gate's heartbeat keeps the job alive
  const during = b.jobId ? await jobSnapshot(b.jobId) : null
  check('after 45 s the job is still waiting: not failed by the stall watchdog, not finished', during !== null && during.status !== 'error' && during.status !== 'done', JSON.stringify(during))
  check('nothing was imported meanwhile', rowsFor(nameB) === 0, `rows ${rowsFor(nameB)}`)
  check('the log has a "pausing imports" line', /pausing imports/.test(appLog()))

  console.log('\n3. The filler is removed: the same upload finishes by itself')
  removeFiller()
  const resumed = await waitFor('the gate to resume', async () => (await gate())?.paused === false, 90_000)
  check('the gate resumed by itself', !!resumed)
  const finalB = b.jobId ? await waitJob(b.jobId, 120_000) : null
  check('the import finished (status done)', finalB?.status === 'done', JSON.stringify(finalB))
  check('every row arrived exactly once (30000)', rowsFor(nameB) === 30_000, `rows ${rowsFor(nameB)}`)
  check('the log has a "resuming imports" line', /resuming imports/.test(appLog()))

  console.log('\n4. INGEST_DISK_GATE=off: a floor above the free space holds nothing back')
  if (!check('the rehearsal app restarted with the gate off', await recreateApp({ floorBytes: freeBytes() + 10 * GiB, gate: 'off' }))) return 1
  const nameD = `e2e-gate-d-${RUN}.txt`
  const d = upload(nameD, genLines(10_000, 'gd'))
  const finalD = d.jobId ? await waitJob(d.jobId, 120_000) : null
  check('the import finished although free space is under the (ignored) floor', finalD?.status === 'done' && rowsFor(nameD) === 10_000, JSON.stringify(finalD))
  check('the disk endpoint reports no pause', (await gate())?.paused === false)
  return 0
}

async function main(): Promise<number> {
  process.on('SIGINT', () => {
    removeFiller()
    process.exit(130)
  })
  let code = 1
  try {
    code = await run()
  } catch (err) {
    check('the scenarios ran without an unexpected error', false, err instanceof Error ? err.message : String(err))
  } finally {
    removeFiller()
    rmSync(work, { recursive: true, force: true })
    rmSync(dockerCfg, { recursive: true, force: true })
  }
  if (code === 2) return 2
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  return failed.length === 0 && code === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(2)
  },
)
```

- [ ] **Step 3: Typecheck and lint the script**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit && npx eslint scripts/e2e-disk-gate.ts`
Expected: both silent. (The script is exercised for real in Task 11.)

- [ ] **Step 4: Commit**

```bash
cd /home/cole/ulp-suite && git add docker-compose.rehearsal.yml scripts/e2e-disk-gate.ts && git commit -F - <<'EOF'
test(e2e): rehearse the ingest disk gate on the production image

scripts/e2e-disk-gate.ts recreates the isolated rehearsal app with a floor derived from the host's free space, pushes free space
under it with a filler, and checks that an upload waits (no failure, no rows, the stall watchdog fed), the banner endpoint and
Ingest Health say so, the same upload finishes by itself when the filler goes, and INGEST_DISK_GATE=off holds nothing back.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9: CI runner pin, the action majors, and the fixable audit findings

**Files:**
- Modify: `/home/cole/ulp-suite/.github/workflows/ci.yml`
- Modify: `/home/cole/ulp-suite/package-lock.json` (and `package.json` only if `npm audit fix` changes a range)
- Test: create `/home/cole/ulp-suite/__tests__/ci-workflow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ci-workflow.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

describe('CI workflow', () => {
  test('pins the runner image: ubuntu-latest moves to Ubuntu 26 on 2026-10-19', () => {
    expect(ci).toContain('runs-on: ubuntu-24.04')
    expect(ci).not.toContain('ubuntu-latest')
  })

  test('uses action majors that run on Node 24 natively', () => {
    expect(ci).toContain('actions/checkout@v7')
    expect(ci).toContain('actions/setup-node@v7')
    expect(ci).not.toMatch(/actions\/(checkout|setup-node)@v[1-4]\b/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ci-workflow.test.ts 2>&1 | tail -10`
Expected: FAIL (`ubuntu-latest` and `@v4` are still there).

- [ ] **Step 3: Change the workflow**

In `/home/cole/ulp-suite/.github/workflows/ci.yml` change the three lines:

```yaml
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
```

to:

```yaml
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
```

- [ ] **Step 4: Run the test to verify it passes, then commit the workflow**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ci-workflow.test.ts 2>&1 | tail -6`
Expected: PASS.

```bash
cd /home/cole/ulp-suite && git add .github/workflows/ci.yml __tests__/ci-workflow.test.ts && git commit -F - <<'EOF'
ci: pin ubuntu-24.04 and move to checkout@v7 and setup-node@v7

ubuntu-latest becomes Ubuntu 26 on 2026-10-19; the v4 actions are Node 20 actions forced onto Node 24. v7 of both run on Node 24.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: Record the audit before the fix**

Run:
```bash
cd /home/cole/ulp-suite && npm audit --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.metadata.vulnerabilities));for(const v of Object.values(j.vulnerabilities))console.log(v.severity.padEnd(8),String(v.fixAvailable&&v.fixAvailable.isSemVerMajor?"MAJOR":v.fixAvailable?"fix":"none").padEnd(6),v.name)})'
```
Expected: `{"info":0,"low":0,"moderate":3,"high":9,"critical":0,"total":12}` followed by one line per package; `next`, `sharp`, `source-map-js`, `postcss-nested` show `fix`.

- [ ] **Step 6: Apply the non-major fixes**

Run: `cd /home/cole/ulp-suite && npm audit fix 2>&1 | tail -8`
Expected: a summary of added/changed packages. It must NOT run with `--force`, and `package.json` must not gain a new major (`git diff --stat package.json package-lock.json` shows the lockfile, and at most patch/minor range edits in `package.json`).

- [ ] **Step 7: Prove it on disk, not by the command's own report**

Run:
```bash
cd /home/cole/ulp-suite && npm ci 2>&1 | tail -3 && for p in next sharp source-map-js postcss-nested; do node -p "'$p ' + require('$p/package.json').version"; done && git diff -U0 package-lock.json | grep -E '^[+-]\s+"version": ' | head -20
```
Expected: `npm ci` succeeds; the four versions printed from `node_modules` are the NEW ones and match the lockfile diff (compare with `git show HEAD:package-lock.json | grep -A2 '"node_modules/next"'`). If a version on disk is still the old one, the fix did not land: stop and investigate before committing.

- [ ] **Step 8: Re-audit and run every gate**

Run: `cd /home/cole/ulp-suite && npm audit --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.metadata.vulnerabilities));console.log(Object.keys(j.vulnerabilities).sort().join(" "))})'`
Expected: `next`, `sharp`, `source-map-js` and `postcss-nested` are gone; what remains is the dev-tooling chain that needs majors (`@next/eslint-plugin-next`, `braces`, `chokidar`, `eslint-config-next`, `fast-glob`, `micromatch`, `postcss-selector-parser`, `tailwindcss`: about 8).

Then: `cd /home/cole/ulp-suite && npx tsc --noEmit && npm run lint 2>&1 | tail -5 && npx vitest run 2>&1 | tail -6`
Expected: tsc silent, lint clean, every test file passing.

- [ ] **Step 9: Commit the dependency fix**

```bash
cd /home/cole/ulp-suite && git add package.json package-lock.json && git commit -F - <<'EOF'
chore(deps): npm audit fix for next, sharp, source-map-js and postcss-nested (non-major only)

next (SSG/ISR cache poisoning, GHSA-4jqv-mc3x-m676), sharp (GHSA-wq5f-xc86-pv6w), source-map-js (GHSA-68fv-2mgg-jv7q) and
postcss-nested. Verified after `npm ci` by reading each package.json under node_modules. The remaining findings are the dev-tooling
chain behind tailwindcss and eslint-config-next, which needs major upgrades.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Debris

**Files:**
- Delete: `/home/cole/ulp-suite/styles/globals.css`, `/home/cole/ulp-suite/public/placeholder.jpg`, `placeholder-logo.png`, `placeholder-logo.svg`, `placeholder.svg`, `placeholder-user.jpg`
- Modify: `/home/cole/ulp-suite/.gitignore`
- Add: `/home/cole/ulp-suite/.claude/launch.json`
- Remove (local, not tracked): the worktree `/home/cole/ulp-suite/.claude/worktrees/search-dictionary` and the branch `worktree-search-dictionary`

- [ ] **Step 1: Re-prove the files are unreferenced**

Run:
```bash
cd /home/cole/ulp-suite && echo "--- styles/globals.css:" && grep -rnE "styles/globals" --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --include=*.json --include=*.css --include=*.md . 2>/dev/null | grep -vE "node_modules|^./.next|^./docs/superpowers|^./.claude/worktrees" ; echo "--- placeholder files:" && grep -rnE "placeholder(-logo|-user)?\.(jpg|png|svg)" --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --include=*.json --include=*.css --include=*.md . 2>/dev/null | grep -vE "node_modules|^./.next|^./docs/superpowers|^./.claude/worktrees"; echo "(nothing above = unreferenced)"
```
Expected: no output between the headings other than the headings themselves. If anything is listed, keep that file and say so in the commit.

- [ ] **Step 2: Delete them and make sure the app still builds its CSS and types**

```bash
cd /home/cole/ulp-suite && git rm -q styles/globals.css public/placeholder.jpg public/placeholder-logo.png public/placeholder-logo.svg public/placeholder.svg public/placeholder-user.jpg && ls styles 2>/dev/null; npx tsc --noEmit && echo tsc-ok
```
Expected: `git rm` lists nothing wrong, `tsc-ok`. (An empty `styles/` directory disappears with its last file.)

- [ ] **Step 3: Ignore the local settings file and track the preview config**

In `/home/cole/ulp-suite/.gitignore`, directly after the line `.claude/worktrees/` add:

```
.claude/settings.local.json
```

Then:
```bash
cd /home/cole/ulp-suite && git add .gitignore .claude/launch.json && git status --short | head
```
Expected: `M  .gitignore`, `A  .claude/launch.json` and the five-plus deletions; no other `.claude` path appears (the worktree directory is ignored, `settings.local.json` is ignored).

- [ ] **Step 4: Commit**

```bash
cd /home/cole/ulp-suite && git commit -F - <<'EOF'
chore: remove an unreferenced stylesheet and five placeholder images, track the preview config

app/layout.tsx imports app/globals.css, never styles/globals.css; nothing references the placeholder images. .claude/launch.json
(the dev-server preview config) is tracked; .claude/settings.local.json is ignored.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: Remove the orphan worktree and its merged branch**

Run:
```bash
cd /home/cole/ulp-suite && git -C .claude/worktrees/search-dictionary status --short | head -3; echo "(blank = clean)"; ls .git/worktrees/search-dictionary | grep -c '^locked$' || true; git merge-base --is-ancestor worktree-search-dictionary main && echo "merged into main"
```
Expected: blank status, `0` (no lock file), `merged into main`. Only then:

```bash
cd /home/cole/ulp-suite && git worktree remove .claude/worktrees/search-dictionary && git branch -d worktree-search-dictionary && git worktree list
```
Expected: `Deleted branch worktree-search-dictionary (was affe60f).` and `git worktree list` shows only `/home/cole/ulp-suite`.

---

### Task 11: Full gates, the production image, and the rehearsals

**Files:** none (verification only; fix and re-run on any failure, and note the fix in the plan).

- [ ] **Step 1: All gates on the branch**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit && npm run lint 2>&1 | tail -4 && npx vitest run 2>&1 | tail -6`
Expected: tsc silent, lint clean, all test files pass. The file and test counts are higher than the Task 0 baseline by the files this plan added (about 11 files).

- [ ] **Step 2: Memory preflight for the build**

Run: `free -m | sed -n 2p`
Expected: at least 6000 MiB available (the image build runs `next build` with a multi-GiB heap). If less, STOP and ask the operator to close heavy tools; do not build.

- [ ] **Step 3: Tag the running image as the rollback BEFORE the build moves `:latest`**

```bash
cd /home/cole/ulp-suite && TAG=ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz) && docker tag ulp-suite-app:latest "$TAG" && echo "$TAG" && docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E 'ulp-suite-app:(latest|rollback-2026101)' | head
```
Expected: the new rollback tag points at the same image id as `:latest` (the one currently deployed). Write the tag down.

- [ ] **Step 4: Build the image from this branch**

```bash
mkdir -p /tmp/claude-1000/dockercfg && echo '{}' > /tmp/claude-1000/dockercfg/config.json && cd /home/cole/ulp-suite && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose build app 2>&1 | tail -15
```
Expected: ends with `Image ulp-suite-app Built`; this takes about 3-5 minutes and runs `next build` (so it is also the build gate). `docker images | grep ulp-suite-app:latest` now shows a new image id. The running production containers are not touched.

- [ ] **Step 5: Bring up the rehearsal stack and run the existing alert rehearsal on the new image**

Run: `cd /home/cole/ulp-suite && npx tsx scripts/e2e-alert-rehearsal.ts --keep 2>&1 | tail -45`
Expected: about 4 minutes; ends `36 of 36 checks passed.` (or the current total) and "Stack left running (--keep)". Any FAIL: stop and diagnose (this exercises the new image with the gate ON at its production default).

- [ ] **Step 6: Run the upload-resilience rehearsal (the gate sits in the batch loop it guards)**

Run: `cd /home/cole/ulp-suite && npx tsx scripts/e2e-upload-resilience.ts 2>&1 | tail -45`
Expected: about 6 minutes; ends `33 of 33 checks passed.` In particular the "ClickHouse is frozen for 45 s" scenario must still fail the job with the stall reason: it proves the gate's free-space read is abortable.

- [ ] **Step 7: Run the new gate rehearsal**

Run: `cd /home/cole/ulp-suite && npx tsx scripts/e2e-disk-gate.ts 2>&1 | tail -45`
Expected: about 5 minutes; every check PASS and `N of N checks passed.`, exit 0. Confirm afterwards that the filler is gone: `docker exec ulprehearsal_clickhouse ls /var/lib/clickhouse/zz_disk_gate_filler` must say `No such file`.

- [ ] **Step 8: Tear the rehearsal stack down**

```bash
cd /home/cole/ulp-suite && DOCKER_CONFIG=/tmp/claude-1000/dockercfg REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v --remove-orphans 2>&1 | tail -6 && docker ps -a --format '{{.Names}}' | grep -c ulprehearsal || true
```
Expected: containers and volumes removed; the count is `0`. (Dummy secrets: compose interpolates them even for `down`.)

---

### Task 12: Merge, push, deploy, verify

**Files:** none.

- [ ] **Step 1: Fast-forward merge and push**

```bash
cd /home/cole/ulp-suite && git switch main && git merge --ff-only sp1-disk-safety-hygiene && git push origin main 2>&1 | tail -3 && git log --oneline -12
```
Expected: fast-forward, push accepted, the SP1 commits on top of `4ac1817`.

- [ ] **Step 2: Watch CI on the pushed commit**

Run: `cd /home/cole/ulp-suite && gh run list --branch main --limit 1 --json databaseId,status && gh run watch "$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status 2>&1 | tail -12`
Expected: the run succeeds on `ubuntu-24.04` with the v7 actions; the previous warnings ("Node.js 20 is deprecated", "ubuntu-latest will migrate") are gone from its annotations. If it fails, fix forward on `main` with a new commit (never force-push).

- [ ] **Step 3: Pick a quiet moment**

Run: `docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.query_log WHERE type = 'QueryFinish' AND interface = 2 AND event_time > now() - INTERVAL 3 MINUTE AND query LIKE 'SELECT%' AND query NOT LIKE '%system.%'"`
Expected: `0` or a small number. The app restarts for about 30 s; if the operator is mid-search (a larger number), wait a few minutes and re-check.

- [ ] **Step 4: Recreate only the app container**

```bash
cd /home/cole/ulp-suite && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose up -d --no-deps app 2>&1 | tail -4 && sleep 45 && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep ulpsuite
```
Expected: `ulpsuite_app` restarted (`Up ... (healthy)` within about a minute), `ulpsuite_clickhouse` untouched (its uptime unchanged), the app image is the new `:latest` id.

- [ ] **Step 5: Check the deployed code and the start-up log**

```bash
cd /home/cole/ulp-suite && docker inspect ulpsuite_app --format '{{.Image}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}' && docker exec ulpsuite_app printenv INGEST_DISK_GATE INGEST_MIN_FREE_BYTES; docker logs --since 3m ulpsuite_app 2>&1 | grep -E "cron started|disk-watch|Ready in|ERROR|error" | cut -c1-160
```
Expected: the working dir is `/home/cole/ulp-suite`; both variables print empty (code defaults); the log shows the content-dedup, projection-scope, disk-watch and search-dictionary crons started and no errors. Then confirm the new endpoint exists and refuses an anonymous caller:

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/monitoring/disk`
Expected: `401`.

- [ ] **Step 6: Note what to check at the next anchors**

Expected at 04:00Z and 05:00Z the next day (not now): `docker logs ulpsuite_app 2>&1 | grep -E "content-dedup\] cron|projection-scope\] cron"` shows lines stamped at those hours, not at the container start time, and `projection-scope ... cleared=[none] skipped=[none]`. Record the result in the memory note.

---

### Task 13: Close out

**Files:**
- Modify: `/home/cole/ulp-suite/docs/superpowers/specs/2026-10-11-disk-safety-and-hygiene-design.md` (status line)
- Modify: this plan (tick the boxes; note any deviation)

- [ ] **Step 1: Update the spec's status line**

Change the line beginning `Status: **approved 2026-10-11, not implemented.**` to `Status: **implemented and deployed locally on 2026-10-11 (plan `docs/superpowers/plans/2026-10-11-disk-safety-and-hygiene.md`).**` followed by the existing sentence about sub-project 2, and add one line to the Rollout section naming the image id and the rollback tag.

- [ ] **Step 2: Tick this plan's boxes and list deviations**

Replace `- [ ]` with `- [x]` for every completed step, and add a short "Deviations" paragraph at the end of this file for anything done differently from the text above.

- [ ] **Step 3: Commit and push**

```bash
cd /home/cole/ulp-suite && git add docs/superpowers && git commit -F - <<'EOF'
docs: mark the disk-safety and hygiene work implemented and record the release

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
git push origin main 2>&1 | tail -2
```

- [ ] **Step 4: Update the project memory**

Update `project_disk_full_incident_2026_10_10.md` and the open-items ledger: SP1 done (commits, image id, rollback tag), the banner and gate are live, what remains (SP2 novelty-aware ingest, the owner's items, the 04:00Z/05:00Z cron check), and the lessons from the execution.
