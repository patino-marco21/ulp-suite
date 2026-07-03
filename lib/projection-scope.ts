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
 */
import { getClient } from '@/lib/clickhouse'

export const PROJECTION_NAME = 'proj_imported_desc'

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

export function buildEligiblePartitionsSql(cutoff: string): string {
  return `SELECT DISTINCT partition FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active
      AND partition < '${cutoff}'
    ORDER BY partition`
}

export function buildClearProjectionSql(partition: string): string {
  return `ALTER TABLE ulp.credentials CLEAR PROJECTION ${PROJECTION_NAME} IN PARTITION '${partition}'`
}

let tickInFlight = false

export interface ProjectionScopeTickResult {
  cutoff: string
  cleared: string[]
}

/** Clear proj_imported_desc from every partition older than the recency window. Never throws. */
export async function runProjectionScopeTick(
  opts: { trigger?: string; now?: Date } = {},
): Promise<ProjectionScopeTickResult> {
  const trigger = opts.trigger ?? 'tick'
  const now = opts.now ?? new Date()
  if (tickInFlight) return { cutoff: '', cleared: [] }
  tickInFlight = true
  try {
    const cutoff = cutoffPartition(projectionScopeWindowMonths(), now)
    const client = getClient()
    const res = await client.query({ query: buildEligiblePartitionsSql(cutoff), format: 'JSONEachRow' })
    const rows = (await res.json()) as Array<{ partition: string }>
    const cleared: string[] = []
    for (const { partition } of rows) {
      await client.exec({ query: buildClearProjectionSql(partition) })
      cleared.push(partition)
    }
    console.log(
      `[projection-scope] ${trigger}: cutoff=${cutoff} cleared=[${cleared.join(', ') || 'none'}]`,
    )
    return { cutoff, cleared }
  } catch (err) {
    console.error('[projection-scope] tick failed:', err)
    return { cutoff: '', cleared: [] }
  } finally {
    tickInFlight = false
  }
}
