/**
 * Scheduled content-dedup re-run.
 *
 * Ticks every DEDUP_CRON_HOURS hours (default 24; 0 disables) and runs
 * runContentDedupTick() — report-only unless CONTENT_DEDUP_APPLY=true. Mirrors
 * lib/monitor-rescan-cron.ts (setInterval, `started` guard); the NODE_ENV guard in
 * instrumentation.ts prevents dev hot-reload double-registration.
 */
import { dedupCronHours, runContentDedupTick } from '@/lib/content-dedup'

let started = false

export function startDedupCron(): void {
  if (started) return
  const hours = dedupCronHours()
  if (hours <= 0) {
    console.log('[content-dedup] cron disabled (DEDUP_CRON_HOURS=0)')
    return
  }
  started = true
  const ms = hours * 60 * 60 * 1000
  console.log(`[content-dedup] cron started — tick every ${hours}h`)
  // First tick after 60s (let the server warm up); then on the interval.
  setTimeout(() => { runContentDedupTick({ trigger: 'cron' }).catch(console.error) }, 60_000)
  setInterval(() => { runContentDedupTick({ trigger: 'cron' }).catch(console.error) }, ms)
}
