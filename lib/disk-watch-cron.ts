/**
 * Scheduled disk-space check (lib/disk-watch.ts).
 *
 * Ticks every DISK_WATCH_MINUTES minutes (default 10; 0 disables), the first one 30 s after start so
 * a container that boots into a full disk says so straight away. Mirrors lib/dedup-cron.ts: a `started`
 * guard, setInterval, and the NODE_ENV guard in instrumentation.ts against dev hot-reload duplicates.
 */
import { runDiskWatchTick } from '@/lib/disk-watch'

let started = false

export function diskWatchMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DISK_WATCH_MINUTES
  if (raw === undefined || raw.trim() === '') return 10
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10
}

export function startDiskWatchCron(): void {
  if (started) return
  const minutes = diskWatchMinutes()
  if (minutes <= 0) {
    console.log('[disk-watch] cron disabled (DISK_WATCH_MINUTES=0)')
    return
  }
  started = true
  const tick = () => { runDiskWatchTick().catch(err => console.error('[disk-watch] tick failed:', err)) }
  setTimeout(tick, 30_000)
  setInterval(tick, minutes * 60_000)
  console.warn(`[disk-watch] cron started — first check in 30s, then every ${minutes}m`)
}
