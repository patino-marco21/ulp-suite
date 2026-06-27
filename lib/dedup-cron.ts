/**
 * Scheduled content-dedup re-run.
 *
 * Ticks every DEDUP_CRON_HOURS hours (default 24; 0 disables) and runs
 * runContentDedupTick() — report-only unless CONTENT_DEDUP_APPLY=true. Mirrors
 * lib/monitor-rescan-cron.ts (setInterval, `started` guard); the NODE_ENV guard in
 * instrumentation.ts prevents dev hot-reload double-registration.
 *
 * The first tick is anchored to a fixed UTC hour (DEDUP_CRON_HOUR_UTC, default
 * 04:00) rather than firing 60s after container start — a startup-relative
 * timer lands its daily recurrence at whatever wall-clock time the container
 * last happened to (re)start, which on 2026-06-27 put it in the middle of a
 * heavy-query window. SETTINGS still bound the stats query itself.
 */
import { dedupCronHours, dedupCronHourUtc, runContentDedupTick } from '@/lib/content-dedup'

let started = false

/** Ms from `now` until the next `hourUtc:00 UTC` (today if still ahead, else tomorrow). */
export function msUntilNextRun(hourUtc: number, now: Date): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0,
  ))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

export function startDedupCron(): void {
  if (started) return
  const hours = dedupCronHours()
  if (hours <= 0) {
    console.log('[content-dedup] cron disabled (DEDUP_CRON_HOURS=0)')
    return
  }
  started = true
  const ms = hours * 60 * 60 * 1000
  const hourUtc = dedupCronHourUtc()
  const initialDelay = msUntilNextRun(hourUtc, new Date())
  console.log(
    `[content-dedup] cron started — first tick in ${Math.round(initialDelay / 60_000)}m ` +
      `(anchored to ${String(hourUtc).padStart(2, '0')}:00 UTC), then every ${hours}h`,
  )
  setTimeout(() => { runContentDedupTick({ trigger: 'cron' }).catch(console.error) }, initialDelay)
  setInterval(() => { runContentDedupTick({ trigger: 'cron' }).catch(console.error) }, ms)
}
