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
