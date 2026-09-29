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
 *
 * REVISED 2026-09-29: the growth signal used to be system-wide free-space
 * delta (startFreeBytes - currentFreeBytes). Confirmed live against content-
 * dedup's actual populate step (argMin GROUP BY, disk-spilling): each
 * bucket's real persisted growth (the target table's own bytes_on_disk) was
 * a steady ~18 GiB, but the SAME bucket's free-space delta was ~44-48 GiB --
 * an extra ~28-30 GiB of per-query transient overhead (disk-spill temp
 * files / not-yet-merged parts across this table's many monthly partitions)
 * that does NOT compound (bucket 2's free-space delta was close to bucket
 * 1's, not double it -- confirmed by a live 2-bucket test with no drop
 * between them) but which free-space-delta-based projection has no way to
 * tell apart from real growth. Extrapolating the full ~48 GiB/bucket figure
 * across a bucket count made the projection unsatisfiable regardless of how
 * much headroom was freed (46 GiB * 16 buckets alone exceeds most of this
 * disk's total capacity), even though the operation's true final size (~18
 * GiB * 16 buckets) fits comfortably. Growth is now measured directly from
 * the target table's own on-disk size, which only reflects real, cumulative
 * growth -- transient overhead never gets attributed to it in the first
 * place, so it can't be mistaken for compounding growth. The immediate
 * floor check (currentFreeBytes < effectiveFloorBytes) is UNCHANGED -- it
 * must still reflect true current free space, transient overhead included,
 * because a genuinely-full disk right now is a real trip regardless of why.
 *
 * index === 0 means no iteration has completed yet, so only the immediate
 * floor check applies; the projection only activates from index > 0, using
 * the running average table growth across all completed iterations so far
 * (not just the most recent one, so one anomalous iteration can't dominate).
 */
export function checkProjection(params: {
  currentFreeBytes: number
  effectiveFloorBytes: number
  startTableBytes: number
  currentTableBytes: number
  index: number
  total: number
}): ProjectionResult {
  const { currentFreeBytes, effectiveFloorBytes, startTableBytes, currentTableBytes, index, total } = params

  if (currentFreeBytes < effectiveFloorBytes) return { trip: true, reason: 'floor-breached' }

  if (index > 0) {
    const grownSoFar = Math.max(0, currentTableBytes - startTableBytes)
    const avgPerIteration = grownSoFar / index
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

/**
 * One live snapshot of a table's current on-disk size (base data + every
 * secondary index + every projection -- all counted in system.parts'
 * bytes_on_disk for that table), in bytes. No caching. tableName must be
 * `database.table` (matches how AUTO_DEDUP_TABLE etc. are already written
 * throughout lib/content-dedup.ts) -- interpolated directly into the query,
 * same as this codebase's other internal-constant-only SQL construction;
 * never pass user input here.
 */
export async function checkTableBytes(tableName: string, signal?: AbortSignal): Promise<number> {
  const [database, table] = tableName.split('.')
  const res = await getClient().query({
    query: `SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE database = '${database}' AND table = '${table}' AND active`,
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: { use_query_cache: 0 },
  })
  const rows = await res.json() as Array<{ bytes: string | number | null }>
  return Number(rows[0]?.bytes ?? 0)
}

export interface DiskGuard {
  preflight(signal?: AbortSignal): Promise<void>
  checkBeforeIteration(signal: AbortSignal | undefined, ctx: IterationContext): Promise<void>
}

/**
 * targetTable is the table whose own growth backs the projection (see
 * checkProjection's comment) -- deliberately a required positional
 * parameter, not folded into DiskGuardOptions, since DiskGuardOptions is
 * also consumed by resolveDiskGuardOptions on its own (which has nothing to
 * do with any particular table).
 */
export function createDiskGuard(targetTable: string, opts: DiskGuardOptions = {}): DiskGuard {
  const resolved = resolveDiskGuardOptions(opts)
  let startTableBytes: number | null = null

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

  async function safeTableBytes(signal?: AbortSignal): Promise<number> {
    try {
      return await checkTableBytes(targetTable, signal)
    } catch (err) {
      throw new DiskHeadroomError(
        'check-failed',
        `[clickhouse-disk-guard] ${targetTable} size check failed, treating as a trip: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    async preflight(signal?: AbortSignal): Promise<void> {
      const headroom = await safeCheck(signal)
      startTableBytes = await safeTableBytes(signal)
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
      if (startTableBytes === null) {
        throw new Error('[clickhouse-disk-guard] checkBeforeIteration called before preflight')
      }
      const headroom = await safeCheck(signal)
      const currentTableBytes = await safeTableBytes(signal)
      const effectiveFloorBytes = computeEffectiveFloorBytes(resolved, headroom.totalBytes)
      const result = checkProjection({
        currentFreeBytes: headroom.freeBytes,
        effectiveFloorBytes,
        startTableBytes,
        currentTableBytes,
        index: ctx.index,
        total: ctx.total,
      })
      if (result.trip) {
        const detail = result.reason === 'floor-breached'
          ? `${formatBytes(headroom.freeBytes)} free < ${formatBytes(effectiveFloorBytes)} floor`
          : `projected to breach ${formatBytes(effectiveFloorBytes)} floor before iteration ${ctx.total} of ${ctx.total} completes (currently ${formatBytes(headroom.freeBytes)} free, ${targetTable} at ${formatBytes(currentTableBytes)}, iteration ${ctx.index} of ${ctx.total})`
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
