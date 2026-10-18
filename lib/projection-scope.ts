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
export function projectionScopeCronHours(env: NodeJS.Dict<string> = process.env): number {
  const h = parseInt(env.PROJECTION_SCOPE_CRON_HOURS ?? '24', 10)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** How many months of the most recent data keep the projection. Default 2. */
export function projectionScopeWindowMonths(env: NodeJS.Dict<string> = process.env): number {
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
