/**
 * Scheduled SQLite snapshot (lib/sqlite-backup.ts).
 *
 * Checks hourly whether the newest snapshot is older than SQLITE_BACKUP_HOURS (default 24; 0
 * disables) and takes one if so; the first check is 2 minutes after start, so a fresh deploy has a
 * snapshot almost at once while repeated restarts do not pile up snapshots. Mirrors
 * lib/dedup-cron.ts: a `started` guard, setInterval, and the NODE_ENV guard in instrumentation.ts.
 */
import { runSqliteBackupIfDue, sqliteBackupHours } from '@/lib/sqlite-backup'

let started = false

export function startSqliteBackupCron(): void {
  if (started) return
  const hours = sqliteBackupHours()
  if (hours <= 0) {
    console.log('[sqlite-backup] cron disabled (SQLITE_BACKUP_HOURS=0)')
    return
  }
  started = true
  const tick = () => {
    runSqliteBackupIfDue()
      .then(result => {
        if (result) console.warn(`[sqlite-backup] snapshot written: ${result.file} (${result.bytes} bytes, pruned ${result.pruned.length})`)
      })
      .catch(err => console.error('[sqlite-backup] snapshot failed:', err instanceof Error ? err.message : err))
  }
  setTimeout(tick, 2 * 60_000)
  setInterval(tick, 60 * 60_000)
  console.warn(`[sqlite-backup] cron started — a snapshot whenever the newest is older than ${hours}h (checked hourly)`)
}
