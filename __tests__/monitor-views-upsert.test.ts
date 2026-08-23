/**
 * Regression guard for the monitor_views upsert SQL used by
 * lib/domain-monitor.ts's recordMonitorViewed.
 *
 * __tests__/domain-monitor.test.ts's 'recordMonitorViewed upserts keyed on
 * (monitor_id, user_id)' test mocks dbRun and only asserts the SQL *text*
 * contains 'ON CONFLICT(monitor_id, user_id) DO UPDATE' — it never executes
 * that SQL, so a subtly wrong conflict target (wrong columns) or action
 * (e.g. DO NOTHING instead of DO UPDATE) would still pass that test.
 *
 * This file runs the exact upsert statement against a real, file-backed
 * better-sqlite3 database (mirroring __tests__/sqlite-admin-seed-race.test.ts's
 * temp-file setup/teardown) to prove the ON CONFLICT clause actually works:
 * viewing the same monitor twice updates one row in place instead of
 * erroring or duplicating, and different (monitor_id, user_id) pairs stay
 * independent.
 */

import { describe, test, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Exact copy of the monitor_views DDL from lib/sqlite.ts's initSchema —
// this is the table under test, so it must not be hand-simplified.
const MONITOR_VIEWS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS monitor_views (
      monitor_id     INTEGER NOT NULL,
      user_id        INTEGER NOT NULL,
      last_viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (monitor_id, user_id),
      FOREIGN KEY (monitor_id) REFERENCES domain_monitors(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
`

// Minimal stand-ins for the parent tables monitor_views' foreign keys point
// at — NOT the real domain_monitors/users DDL (that's exercised elsewhere).
// lib/sqlite.ts's getDb() runs with `PRAGMA foreign_keys = ON`, so this test
// enables it too and gives each FK an id to reference, rather than letting
// FK enforcement silently be a no-op.
const DOMAIN_MONITORS_SCHEMA = `CREATE TABLE domain_monitors (id INTEGER PRIMARY KEY)`
const USERS_SCHEMA = `CREATE TABLE users (id INTEGER PRIMARY KEY)`

// Exact upsert SQL copied from lib/domain-monitor.ts's recordMonitorViewed.
const UPSERT_SQL = `INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(monitor_id, user_id) DO UPDATE SET last_viewed_at = datetime('now')`

function openConn(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return db
}

function setUpSchema(db: Database.Database): void {
  db.exec(DOMAIN_MONITORS_SCHEMA)
  db.exec(USERS_SCHEMA)
  db.exec(MONITOR_VIEWS_SCHEMA)
}

const tmpFiles: string[] = []
function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-monitor-views-upsert-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true })
  }
})

type MonitorViewRow = { monitor_id: number; user_id: number; last_viewed_at: string }

describe('monitor_views upsert SQL (recordMonitorViewed, run against a real database)', () => {
  test('viewing the same (monitor_id, user_id) pair twice updates one row in place', () => {
    const db = openConn(freshDbPath())
    setUpSchema(db)
    db.prepare('INSERT INTO domain_monitors (id) VALUES (1)').run()
    db.prepare('INSERT INTO users (id) VALUES (7)').run()

    // First view: inserts a new row.
    expect(() => db.prepare(UPSERT_SQL).run(1, 7)).not.toThrow()
    let rows = db.prepare('SELECT * FROM monitor_views WHERE monitor_id = ? AND user_id = ?').all(1, 7) as MonitorViewRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].last_viewed_at).toBeTruthy()

    // Backdate the row directly (bypassing the upsert) to a fixed sentinel
    // far in the past. This — not comparing two live datetime('now') calls,
    // which can collide within the same second — is what makes the
    // "did the second call actually UPDATE" check below deterministic.
    const SENTINEL = '2000-01-01 00:00:00'
    db.prepare('UPDATE monitor_views SET last_viewed_at = ? WHERE monitor_id = ? AND user_id = ?').run(SENTINEL, 1, 7)

    // Second view of the same monitor by the same user: the ON CONFLICT
    // target is the (monitor_id, user_id) primary key, so this must hit
    // DO UPDATE and leave exactly one row — not throw a PRIMARY KEY
    // violation (which a wrong conflict target would cause), not leave a
    // duplicate row, and not leave last_viewed_at pinned at the sentinel
    // (which DO NOTHING — the other bug variant this guards against —
    // would do, since it would skip the SET entirely and silently keep
    // one row with the stale value).
    expect(() => db.prepare(UPSERT_SQL).run(1, 7)).not.toThrow()
    rows = db.prepare('SELECT * FROM monitor_views WHERE monitor_id = ? AND user_id = ?').all(1, 7) as MonitorViewRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].last_viewed_at).toBeTruthy()
    expect(rows[0].last_viewed_at).not.toBe(SENTINEL)

    db.close()
  })

  test('a different (monitor_id, user_id) pair creates an independent second row', () => {
    const db = openConn(freshDbPath())
    setUpSchema(db)
    db.prepare('INSERT INTO domain_monitors (id) VALUES (1)').run()
    db.prepare('INSERT INTO domain_monitors (id) VALUES (2)').run()
    db.prepare('INSERT INTO users (id) VALUES (7)').run()
    db.prepare('INSERT INTO users (id) VALUES (8)').run()

    db.prepare(UPSERT_SQL).run(1, 7)
    db.prepare(UPSERT_SQL).run(2, 8)

    const all = db.prepare('SELECT monitor_id, user_id FROM monitor_views ORDER BY monitor_id').all() as Array<Pick<MonitorViewRow, 'monitor_id' | 'user_id'>>
    expect(all).toEqual([
      { monitor_id: 1, user_id: 7 },
      { monitor_id: 2, user_id: 8 },
    ])

    // Viewing pair (1, 7) again must not disturb (2, 8)'s row.
    db.prepare(UPSERT_SQL).run(1, 7)
    const total = db.prepare('SELECT COUNT(*) as c FROM monitor_views').get() as { c: number }
    expect(total.c).toBe(2)

    db.close()
  })
})
