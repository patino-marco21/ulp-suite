import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

// lib/sqlite opens (and seeds) the app database on first use; these tests only need the backup
// helpers' own logic, against a private database in a temp dir.
vi.mock('@/lib/sqlite', () => ({ backupDb: vi.fn() }))

import {
  runSqliteBackup,
  runSqliteBackupIfDue,
  listSqliteBackups,
  sqliteBackupDir,
  sqliteBackupKeep,
  sqliteBackupHours,
  verifySqliteSnapshot,
} from '@/lib/sqlite-backup'
import { readBackupStatus, backupMaxAgeHours } from '@/lib/backup-status'

let tmp: string
let src: Database.Database
let env: NodeJS.ProcessEnv
const backupFromSrc = (dest: string) => src.backup(dest)
const at = (iso: string) => () => new Date(iso)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-sqlite-backup-'))
  src = new Database(path.join(tmp, 'live.db'))
  src.pragma('journal_mode = WAL')
  src.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); INSERT INTO users (email) VALUES ('a@example.test'), ('b@example.test');`)
  env = { SQLITE_BACKUP_DIR: path.join(tmp, 'backups'), SQLITE_BACKUP_KEEP: '3' }
})

afterEach(() => {
  src.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('runSqliteBackup', () => {
  test('writes a verified, restorable snapshot named by UTC time', async () => {
    const result = await runSqliteBackup({ env, now: at('2026-10-01T05:06:07Z'), backup: backupFromSrc })
    expect(path.basename(result.file)).toBe('ulp-20261001-050607.db')
    expect(result.bytes).toBeGreaterThan(0)
    const copy = new Database(result.file, { readonly: true })
    expect(copy.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 })
    copy.close()
  })

  test('keeps a consistent snapshot of rows still in the WAL', async () => {
    src.exec(`INSERT INTO users (email) VALUES ('wal@example.test')`) // in the WAL, not yet checkpointed
    const { file } = await runSqliteBackup({ env, now: at('2026-10-01T05:00:00Z'), backup: backupFromSrc })
    const copy = new Database(file, { readonly: true })
    expect(copy.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 3 })
    copy.close()
  })

  test('prunes to the newest SQLITE_BACKUP_KEEP and leaves unrelated files alone', async () => {
    const dir = sqliteBackupDir(env)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
    for (const h of ['01', '02', '03', '04']) await runSqliteBackup({ env, now: at(`2026-10-01T${h}:00:00Z`), backup: backupFromSrc })
    expect(listSqliteBackups(dir)).toEqual(['ulp-20261001-020000.db', 'ulp-20261001-030000.db', 'ulp-20261001-040000.db'])
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
  })

  test('a snapshot that fails verification is discarded and never recorded', async () => {
    await runSqliteBackup({ env, now: at('2026-10-01T01:00:00Z'), backup: backupFromSrc })
    const dir = sqliteBackupDir(env)
    const before = fs.readFileSync(path.join(dir, 'sqlite-last.json'), 'utf8')
    await expect(
      runSqliteBackup({
        env,
        now: at('2026-10-01T02:00:00Z'),
        backup: backupFromSrc,
        verify: () => { throw new Error('integrity_check failed') },
      }),
    ).rejects.toThrow('integrity_check failed')
    expect(listSqliteBackups(dir)).toEqual(['ulp-20261001-010000.db'])
    expect(fs.readdirSync(dir).some(f => f.endsWith('.partial'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'sqlite-last.json'), 'utf8')).toBe(before)
  })

  test('a failing backup call leaves nothing behind', async () => {
    await expect(runSqliteBackup({ env, backup: async () => { throw new Error('disk full') } })).rejects.toThrow('disk full')
    expect(listSqliteBackups(sqliteBackupDir(env))).toEqual([])
  })

  test('a stale .partial file from a crash (and its WAL companions) is cleaned up', async () => {
    const dir = sqliteBackupDir(env)
    fs.mkdirSync(dir, { recursive: true })
    for (const f of ['ulp-20260101-000000.db.partial', 'ulp-20260101-000000.db.partial-wal', 'ulp-20260101-000000.db.partial-shm']) {
      fs.writeFileSync(path.join(dir, f), 'torn')
    }
    await runSqliteBackup({ env, now: at('2026-10-01T01:00:00Z'), backup: backupFromSrc })
    expect(fs.readdirSync(dir).filter(f => f.includes('.partial'))).toEqual([])
  })

  test('a successful run leaves only the snapshot and the status file behind', async () => {
    await runSqliteBackup({ env, now: at('2026-10-01T01:00:00Z'), backup: backupFromSrc })
    expect(fs.readdirSync(sqliteBackupDir(env)).sort()).toEqual(['sqlite-last.json', 'ulp-20261001-010000.db'])
  })

  test('verifySqliteSnapshot rejects a file that is not a database', () => {
    const bad = path.join(tmp, 'bad.db')
    fs.writeFileSync(bad, 'this is not sqlite '.repeat(200))
    expect(() => verifySqliteSnapshot(bad)).toThrow()
  })
})

describe('runSqliteBackupIfDue', () => {
  test('skips while the newest snapshot is younger than the interval, then runs', async () => {
    const first = await runSqliteBackupIfDue({ env, hours: 24, now: () => new Date(), backup: backupFromSrc })
    expect(first).not.toBeNull()
    const second = await runSqliteBackupIfDue({ env, hours: 24, now: () => new Date(Date.now() + 3 * 3_600_000), backup: backupFromSrc })
    expect(second).toBeNull()
    const third = await runSqliteBackupIfDue({ env, hours: 24, now: () => new Date(Date.now() + 25 * 3_600_000), backup: backupFromSrc })
    expect(third).not.toBeNull()
  })
})

describe('settings', () => {
  test('defaults and fallbacks', () => {
    expect(sqliteBackupKeep({})).toBe(7)
    expect(sqliteBackupKeep({ SQLITE_BACKUP_KEEP: '0' })).toBe(7)
    expect(sqliteBackupKeep({ SQLITE_BACKUP_KEEP: 'x' })).toBe(7)
    expect(sqliteBackupHours({})).toBe(24)
    expect(sqliteBackupHours({ SQLITE_BACKUP_HOURS: '0' })).toBe(0)
    expect(sqliteBackupDir({ SQLITE_PATH: '/app/data/ulp.db' })).toBe('/app/data/backups')
    expect(backupMaxAgeHours({})).toBe(72)
    expect(backupMaxAgeHours({ BACKUP_MAX_AGE_HOURS: '6' })).toBe(6)
  })
})

describe('readBackupStatus', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')

  test('nothing recorded yet: both items are empty and stale', () => {
    const s = readBackupStatus(env, now)
    expect(s.sqlite).toEqual({ lastAt: null, ageHours: null, stale: true })
    expect(s.clickhouse).toMatchObject({ lastAt: null, ageHours: null, stale: true, name: null, offHost: null })
  })

  test('reads the status files both jobs write', async () => {
    await runSqliteBackup({ env, now: at('2026-10-01T06:00:00Z'), backup: backupFromSrc })
    const dir = sqliteBackupDir(env)
    fs.writeFileSync(path.join(dir, 'clickhouse-last.json'), JSON.stringify({ at: '2026-09-28T12:00:00Z', name: 'ulp-full-x', kind: 'full', offHost: true }))
    const s = readBackupStatus(env, now)
    expect(s.sqlite.ageHours).toBeCloseTo(6, 5)
    expect(s.sqlite.stale).toBe(false)
    expect(s.clickhouse).toMatchObject({ name: 'ulp-full-x', offHost: true, stale: false })
    expect(s.clickhouse.ageHours).toBeCloseTo(72, 5)
    expect(readBackupStatus({ ...env, BACKUP_MAX_AGE_HOURS: '48' }, now).clickhouse.stale).toBe(true)
  })

  test('a local-only ClickHouse backup is reported as not off-host', () => {
    const dir = sqliteBackupDir(env)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'clickhouse-last.json'), JSON.stringify({ at: '2026-10-01T11:00:00Z', name: 'ulp-local-x', kind: 'local', offHost: false }))
    expect(readBackupStatus(env, now).clickhouse).toMatchObject({ offHost: false, stale: false })
  })

  test('falls back to the newest snapshot file when the status file is missing, and survives garbage', async () => {
    const dir = sqliteBackupDir(env)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ulp-20260101-000000.db'), 'x')
    fs.writeFileSync(path.join(dir, 'sqlite-last.json'), '{not json')
    fs.writeFileSync(path.join(dir, 'clickhouse-last.json'), '[]')
    const s = readBackupStatus(env, Date.now())
    expect(s.sqlite.lastAt).not.toBeNull()
    expect(s.clickhouse.lastAt).toBeNull()
  })
})
