/**
 * Snapshots of the app's SQLite database (./data/ulp.db): users, password hashes, 2FA secrets, API
 * keys, domain monitors, webhooks, audit log and the ClickHouse DDL version.
 *
 * clickhouse-backup (docs/clickhouse-backup-runbook.md) covers ClickHouse only, and this file lives
 * outside it, so losing it would lose every login and monitor even with a perfect ClickHouse backup.
 * It is 320 KB (+ a few MB of WAL), so the app keeps its own rolling set instead of relying on a host
 * cron nobody has set up: SQLite's online backup API into <data dir>/backups/ulp-YYYYMMDD-HHMMSS.db,
 * each snapshot opened and integrity-checked before it counts, the newest SQLITE_BACKUP_KEEP (default
 * 7) kept, and `sqlite-last.json` updated for lib/backup-status.ts.
 *
 * The snapshots sit on the same disk as the live file: they cover a bad migration or a corrupted
 * database, not loss of the disk. Copy ./data/backups off the machine for that.
 */
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { backupDb } from '@/lib/sqlite'

const FILE_RE = /^ulp-\d{8}-\d{6}\.db$/

export function sqliteBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SQLITE_BACKUP_DIR?.trim()) return env.SQLITE_BACKUP_DIR.trim()
  const dbPath = env.SQLITE_PATH || path.join(process.cwd(), 'data', 'ulp.db')
  return path.join(path.dirname(dbPath), 'backups')
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function sqliteBackupKeep(env: NodeJS.ProcessEnv = process.env): number {
  const keep = envInt(env.SQLITE_BACKUP_KEEP, 7)
  return keep < 1 ? 7 : keep
}

export function sqliteBackupHours(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.SQLITE_BACKUP_HOURS, 24)
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

/** Snapshot file names in the directory, oldest first. */
export function listSqliteBackups(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => FILE_RE.test(f)).sort()
  } catch {
    return []
  }
}

/** Open the snapshot read-only and run SQLite's integrity check; throws unless it answers `ok`. */
export function verifySqliteSnapshot(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
      throw new Error(`integrity_check failed: ${rows.map(r => r.integrity_check).join('; ').slice(0, 200)}`)
    }
  } finally {
    db.close()
  }
}

export interface SqliteBackupResult {
  file: string
  bytes: number
  pruned: string[]
}

export async function runSqliteBackup(
  deps: {
    env?: NodeJS.ProcessEnv
    now?: () => Date
    backup?: (dest: string) => Promise<unknown>
    verify?: (file: string) => void
  } = {},
): Promise<SqliteBackupResult> {
  const env = deps.env ?? process.env
  const dir = sqliteBackupDir(env)
  const keep = sqliteBackupKeep(env)
  const now = deps.now ?? (() => new Date())
  const backup = deps.backup ?? backupDb
  const verify = deps.verify ?? verifySqliteSnapshot

  fs.mkdirSync(dir, { recursive: true })
  // A crash between the backup and the rename leaves a .partial file (and, if it was opened for
  // verification, its -wal/-shm companions); nothing else ever reads one.
  for (const f of fs.readdirSync(dir)) if (f.includes('.db.partial')) fs.rmSync(path.join(dir, f), { force: true })
  const name = `ulp-${stamp(now())}.db`
  const final = path.join(dir, name)
  const partial = `${final}.partial`

  try {
    await backup(partial)
    verify(partial)
    fs.renameSync(partial, final)
  } catch (err) {
    for (const f of [partial, `${partial}-wal`, `${partial}-shm`]) fs.rmSync(f, { force: true })
    throw err
  }
  for (const f of [`${partial}-wal`, `${partial}-shm`]) fs.rmSync(f, { force: true })

  const bytes = fs.statSync(final).size
  const all = listSqliteBackups(dir)
  const pruned = all.slice(0, Math.max(0, all.length - keep))
  for (const f of pruned) fs.rmSync(path.join(dir, f), { force: true })

  // Written last, atomically: status only ever names a snapshot that exists and verified.
  const status = path.join(dir, 'sqlite-last.json')
  fs.writeFileSync(`${status}.tmp`, JSON.stringify({ at: now().toISOString(), file: name, bytes }))
  fs.renameSync(`${status}.tmp`, status)

  return { file: final, bytes, pruned }
}

/** Newest snapshot's age in hours, or null when there is none. */
export function newestSqliteBackupAgeHours(dir: string, nowMs = Date.now()): number | null {
  const newest = listSqliteBackups(dir).at(-1)
  if (!newest) return null
  try {
    return (nowMs - fs.statSync(path.join(dir, newest)).mtimeMs) / 3_600_000
  } catch {
    return null
  }
}

/** Back up only when the newest snapshot is older than `hours` (so restarts do not pile up snapshots). */
export async function runSqliteBackupIfDue(
  deps: Parameters<typeof runSqliteBackup>[0] & { hours?: number } = {},
): Promise<SqliteBackupResult | null> {
  const env = deps.env ?? process.env
  const hours = deps.hours ?? sqliteBackupHours(env)
  const age = newestSqliteBackupAgeHours(sqliteBackupDir(env), (deps.now ?? (() => new Date()))().getTime())
  if (age !== null && age < hours) return null
  return runSqliteBackup(deps)
}
