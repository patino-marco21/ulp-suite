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
