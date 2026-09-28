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
