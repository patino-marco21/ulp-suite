/**
 * Scheduled proj_imported_desc scoping.
 *
 * Ticks every PROJECTION_SCOPE_CRON_HOURS hours (default 24; 0 disables) and runs
 * runProjectionScopeTick() to clear the recency projection from partitions that have
 * aged out of the window. Mirrors lib/dedup-cron.ts exactly, including reusing its
 * msUntilNextRun anchor helper -- no reason to duplicate that logic. Anchored to
 * 05:00 UTC (one hour after the dedup cron's 04:00) so the two crons don't compete
 * for ClickHouse resources at the same instant.
 */
import { msUntilNextRun } from '@/lib/dedup-cron'
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
  const ms = hours * 60 * 60 * 1000
  const initialDelay = msUntilNextRun(5, new Date())
  console.log(
    `[projection-scope] cron started — first tick in ${Math.round(initialDelay / 60_000)}m ` +
      `(anchored to 05:00 UTC), then every ${hours}h`,
  )
  setTimeout(() => { runProjectionScopeTick({ trigger: 'cron' }).catch(console.error) }, initialDelay)
  setInterval(() => { runProjectionScopeTick({ trigger: 'cron' }).catch(console.error) }, ms)
}
