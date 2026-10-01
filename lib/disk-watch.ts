/**
 * Passive disk-space watcher.
 *
 * lib/clickhouse-disk-guard.ts stops the heavy write jobs (content-dedup, projection restores)
 * from starting on a nearly-full disk, but nothing told a person the disk was filling: the
 * 2026-09-26 incident went from 937 GB to 311 MB free with no warning. This module turns the same
 * `system.disks` reading into a status -- ok / warn / critical -- and reports every CHANGE of status
 * (plus a reminder while it stays bad) to the log and, when DISK_ALERT_WEBHOOK_URL is set, to that
 * URL as a Slack-compatible `{ "text": ... }` JSON POST. Nothing is sent anywhere unless the
 * operator sets that variable.
 *
 * Levels (free space on the ClickHouse data disk):
 *   critical  below the disk guard's floor (the stricter of DISK_GUARD_MIN_FREE_BYTES, default 50 GiB,
 *             and DISK_GUARD_MIN_FREE_RATIO, default 15% of the disk) -- the heavy jobs already refuse
 *             to run here, so this is "act now".
 *   warn      below the largest of DISK_WARN_FREE_BYTES (default 100 GiB), DISK_WARN_FREE_RATIO
 *             (default 20% of the disk) and 1.25x the critical floor -- "act soon".
 *
 * The latest reading is kept on globalThis because instrumentation.ts and the API routes are compiled
 * into separate chunks (see the note there), so plain module state would not be shared with the route
 * that shows it.
 */
import {
  checkDiskHeadroom,
  computeEffectiveFloorBytes,
  formatBytes,
  resolveDiskGuardOptions,
  type DiskHeadroom,
} from '@/lib/clickhouse-disk-guard'

export type DiskStatus = 'ok' | 'warn' | 'critical' | 'unknown'

export interface DiskThresholds {
  /** Free space below which the status is `warn`. */
  warnBytes: number
  /** Free space below which the status is `critical` (the disk guard's effective floor). */
  criticalBytes: number
}

export interface DiskReading {
  status: DiskStatus
  freeBytes: number | null
  totalBytes: number | null
  freeRatio: number | null
  thresholds: DiskThresholds | null
  checkedAt: number
  /** Why the status is `unknown`. */
  error?: string
}

const DEFAULT_WARN_FREE_BYTES = 100 * 1024 ** 3
const DEFAULT_WARN_FREE_RATIO = 0.2
const DEFAULT_REMINDER_HOURS = 6

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function diskThresholds(totalBytes: number, env: NodeJS.ProcessEnv = process.env): DiskThresholds {
  const criticalBytes = computeEffectiveFloorBytes(resolveDiskGuardOptions({}, env), totalBytes)
  const warnBytes = Math.max(
    envNumber(env.DISK_WARN_FREE_BYTES, DEFAULT_WARN_FREE_BYTES),
    envNumber(env.DISK_WARN_FREE_RATIO, DEFAULT_WARN_FREE_RATIO) * totalBytes,
    criticalBytes * 1.25,
  )
  return { warnBytes, criticalBytes }
}

/** Pure: classify one `system.disks` reading. */
export function evaluateDisk(headroom: DiskHeadroom, env: NodeJS.ProcessEnv = process.env, now = Date.now()): DiskReading {
  const thresholds = diskThresholds(headroom.totalBytes, env)
  const status: DiskStatus =
    headroom.freeBytes < thresholds.criticalBytes ? 'critical'
    : headroom.freeBytes < thresholds.warnBytes ? 'warn'
    : 'ok'
  return {
    status,
    freeBytes: headroom.freeBytes,
    totalBytes: headroom.totalBytes,
    freeRatio: headroom.ratio,
    thresholds,
    checkedAt: now,
  }
}

function unknownReading(err: unknown, now: number): DiskReading {
  return {
    status: 'unknown',
    freeBytes: null,
    totalBytes: null,
    freeRatio: null,
    thresholds: null,
    checkedAt: now,
    error: err instanceof Error ? err.message : String(err),
  }
}

/** One live reading; never throws. */
export async function readDisk(
  deps: { check?: () => Promise<DiskHeadroom>; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<DiskReading> {
  const now = deps.now ?? Date.now
  try {
    return evaluateDisk(await (deps.check ?? (() => checkDiskHeadroom()))(), deps.env ?? process.env, now())
  } catch (err) {
    return unknownReading(err, now())
  }
}

export function describeReading(reading: DiskReading): string {
  if (reading.status === 'unknown') return `disk space could not be read: ${reading.error ?? 'unknown error'}`
  const free = `${formatBytes(reading.freeBytes!)} free of ${formatBytes(reading.totalBytes!)} (${(reading.freeRatio! * 100).toFixed(1)}%)`
  if (reading.status === 'ok') return `disk space is fine: ${free}`
  const t = reading.thresholds!
  return reading.status === 'critical'
    ? `CRITICAL: ${free}, below the ${formatBytes(t.criticalBytes)} floor under which dedup and projection jobs refuse to run`
    : `WARNING: ${free}, below the ${formatBytes(t.warnBytes)} warning level`
}

interface WatchState {
  last: DiskReading | null
  lastStatus: DiskStatus | null
  lastAlertAt: number
}

const globalForDiskWatch = globalThis as unknown as { __ulpDiskWatch?: WatchState }

function state(): WatchState {
  return (globalForDiskWatch.__ulpDiskWatch ??= { last: null, lastStatus: null, lastAlertAt: 0 })
}

/** The most recent reading the watcher took, or null before its first tick. */
export function getLastDiskReading(): DiskReading | null {
  return state().last
}

/** Test seam. */
export function resetDiskWatch(): void {
  globalForDiskWatch.__ulpDiskWatch = undefined
}

export type Notify = (message: string, reading: DiskReading) => Promise<void> | void

/** Log line, plus the webhook when DISK_ALERT_WEBHOOK_URL is set. A failing webhook never throws. */
export function defaultNotify(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Notify {
  return async (message, reading) => {
    const line = `[disk-watch] ${message}`
    if (reading.status === 'critical' || reading.status === 'unknown') console.error(line)
    else console.warn(line)

    const url = env.DISK_ALERT_WEBHOOK_URL?.trim()
    if (!url) return
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `ulp-suite: ${message}`,
          status: reading.status,
          free_bytes: reading.freeBytes,
          total_bytes: reading.totalBytes,
        }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) console.error(`[disk-watch] alert webhook answered HTTP ${res.status}`)
    } catch (err) {
      console.error('[disk-watch] alert webhook failed:', err instanceof Error ? err.message : err)
    }
  }
}

/**
 * Take one reading and report it if the status changed since the last tick, or (while the status is
 * not ok) every DISK_ALERT_REMINDER_HOURS hours. The very first tick reports a bad status but stays
 * quiet about a good one.
 */
export async function runDiskWatchTick(
  deps: {
    check?: () => Promise<DiskHeadroom>
    notify?: Notify
    env?: NodeJS.ProcessEnv
    now?: () => number
  } = {},
): Promise<DiskReading> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const notify = deps.notify ?? defaultNotify(env)

  const reading = await readDisk({ check: deps.check, env, now })
  const s = state()
  const previous = s.lastStatus
  s.last = reading
  s.lastStatus = reading.status

  const reminderMs = envNumber(env.DISK_ALERT_REMINDER_HOURS, DEFAULT_REMINDER_HOURS) * 3_600_000
  const bad = reading.status !== 'ok'
  const changed = previous !== reading.status
  // The first tick has no previous status: say so only if it is bad. Afterwards any change is
  // reported, recovery included.
  const report = changed && (bad || previous !== null)
  const reminder = !changed && bad && reminderMs > 0 && now() - s.lastAlertAt >= reminderMs

  if (report || reminder) {
    s.lastAlertAt = now()
    await notify(describeReading(reading), reading)
  }
  return reading
}
