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
