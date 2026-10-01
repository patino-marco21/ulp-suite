/**
 * What the Ingest Health panel says about backups.
 *
 * Two small status files in the backup directory (<data dir>/backups, see lib/sqlite-backup.ts):
 *   sqlite-last.json      { at, file, bytes }          written by the app's own SQLite snapshot job
 *   clickhouse-last.json  { at, name, kind, offHost }  written by scripts/clickhouse-backup.sh after a
 *                                                       backup it completed (offHost: it reached S3)
 * A missing file means "never", which the panel shows as a standing warning: until this system has a
 * ClickHouse backup that reached another machine, losing the disk loses every credential.
 */
import fs from 'fs'
import path from 'path'
import { sqliteBackupDir, newestSqliteBackupAgeHours } from '@/lib/sqlite-backup'

export interface BackupItem {
  lastAt: string | null
  ageHours: number | null
  stale: boolean
}

export interface BackupStatus {
  sqlite: BackupItem
  clickhouse: BackupItem & { name: string | null; offHost: boolean | null }
  maxAgeHours: number
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function item(at: unknown, nowMs: number, maxAgeHours: number): BackupItem {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return { lastAt: null, ageHours: null, stale: true }
  const ageHours = Math.max(0, (nowMs - ms) / 3_600_000)
  return { lastAt: new Date(ms).toISOString(), ageHours, stale: ageHours > maxAgeHours }
}

export function backupMaxAgeHours(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.BACKUP_MAX_AGE_HOURS)
  return env.BACKUP_MAX_AGE_HOURS && Number.isFinite(parsed) && parsed > 0 ? parsed : 72
}

export function readBackupStatus(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): BackupStatus {
  const dir = sqliteBackupDir(env)
  const maxAgeHours = backupMaxAgeHours(env)

  const sqliteJson = readJson(path.join(dir, 'sqlite-last.json'))
  let sqlite = item(sqliteJson?.at, nowMs, maxAgeHours)
  if (sqlite.lastAt === null) {
    // No status file (e.g. snapshots taken by hand): fall back to the newest snapshot's mtime.
    const age = newestSqliteBackupAgeHours(dir, nowMs)
    if (age !== null) sqlite = { lastAt: new Date(nowMs - age * 3_600_000).toISOString(), ageHours: age, stale: age > maxAgeHours }
  }

  const chJson = readJson(path.join(dir, 'clickhouse-last.json'))
  const ch = item(chJson?.at, nowMs, maxAgeHours)
  return {
    sqlite,
    clickhouse: {
      ...ch,
      name: typeof chJson?.name === 'string' ? chJson.name : null,
      offHost: ch.lastAt === null ? null : chJson?.offHost === true,
    },
    maxAgeHours,
  }
}
