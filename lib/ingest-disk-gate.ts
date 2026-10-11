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
