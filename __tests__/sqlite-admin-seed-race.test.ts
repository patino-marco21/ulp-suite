import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { seedDefaultAdmin } from '@/lib/sqlite'

const USERS_SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','analyst')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`

function openConn(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}

const tmpFiles: string[] = []
function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-admin-seed-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true })
  }
})

describe('admin-seed race (lib/sqlite.ts initSchema, the bug behind the known test flake)', () => {
  it('characterizes the historical bug: plain check-then-act races under WAL (readers do not block on an open writer)', () => {
    // No mocking/timing needed — this is deterministic SQLite/WAL behavior:
    // a plain SELECT from db2 is not blocked by db1's still-open, uncommitted
    // write transaction. That is exactly the window the old code (SELECT
    // COUNT, then INSERT with no lock) fell into when two processes both
    // called getDb() for the first time against the same fresh file.
    const dbPath = freshDbPath()
    const db1 = openConn(dbPath)
    const db2 = openConn(dbPath)
    db1.exec(USERS_SCHEMA)

    db1.exec('BEGIN IMMEDIATE')
    expect((db1.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c).toBe(0)
    // db2's unguarded read during db1's open transaction — this is the stale
    // read the old check-then-act code would have acted on.
    expect((db2.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c).toBe(0)

    db1.prepare(`INSERT INTO users (email, password_hash, name, role) VALUES ('admin@ulp.local','h','Admin','admin')`).run()
    db1.exec('COMMIT')

    // db2 now acts on its stale (pre-commit) read, as the old code did.
    expect(() => {
      db2.prepare(`INSERT INTO users (email, password_hash, name, role) VALUES ('admin@ulp.local','h','Admin','admin')`).run()
    }).toThrowError(/UNIQUE/)

    db1.close()
    db2.close()
  })

  it('BEGIN IMMEDIATE — the mechanism seedDefaultAdmin relies on — blocks on a held write lock where plain BEGIN would not', () => {
    // Isolates *why* .immediate() (not the default deferred mode) is required:
    // deferred BEGIN doesn't take the write lock until its first write
    // statement, so it can start and read while another writer holds an open
    // transaction (reproducing the stale-read window from the test above).
    // IMMEDIATE takes the write lock at BEGIN itself, so it cannot even start
    // until the other writer releases it.
    const dbPath = freshDbPath()
    const db1 = openConn(dbPath)
    const db2 = openConn(dbPath)
    db2.pragma('busy_timeout = 150') // keep the test fast; production uses 5000
    db1.exec(USERS_SCHEMA)

    db1.exec('BEGIN IMMEDIATE') // db1 holds the write lock, uncommitted

    // Deferred BEGIN succeeds anyway, and so does a read inside it — this is
    // the exact gap the old check-then-act code fell into.
    expect(() => db2.exec('BEGIN')).not.toThrow()
    expect(() => db2.prepare('SELECT COUNT(*) as c FROM users').get()).not.toThrow()
    db2.exec('ROLLBACK')

    // IMMEDIATE cannot start at all while db1 holds the lock — it fails
    // closed instead of proceeding on a stale read.
    expect(() => db2.exec('BEGIN IMMEDIATE')).toThrowError(/SQLITE_BUSY|database is locked/i)

    db1.exec('ROLLBACK')
    db1.close()
    db2.close()
  })

  it('seedDefaultAdmin acquires a real write lock before reading, so it cannot race past a concurrent holder', () => {
    const dbPath = freshDbPath()
    const db1 = openConn(dbPath)
    const db2 = openConn(dbPath)
    db2.pragma('busy_timeout = 150') // keep the test fast; production uses 5000
    db1.exec(USERS_SCHEMA)

    // db1 holds an open, uncommitted write transaction with a row already
    // inserted — simulating "another process is mid-seed right now".
    db1.exec('BEGIN IMMEDIATE')
    db1.prepare(`INSERT INTO users (email, password_hash, name, role) VALUES ('admin@ulp.local','h','Admin','admin')`).run()

    // seedDefaultAdmin must not race past db1's lock with a stale read — it
    // should fail closed (SQLITE_BUSY) rather than throw a UNIQUE constraint
    // error or silently insert a duplicate.
    let caught: unknown
    try {
      seedDefaultAdmin(db2)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect((caught as { code?: string }).code).toBe('SQLITE_BUSY')

    db1.exec('ROLLBACK')
    // db2's failed attempt must not have left a partial/duplicate row behind.
    expect((db2.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c).toBe(0)

    db1.close()
    db2.close()
  })

  it('seedDefaultAdmin is correct and idempotent with no contention', () => {
    const dbPath = freshDbPath()
    const db = openConn(dbPath)
    db.exec(USERS_SCHEMA)

    seedDefaultAdmin(db)
    expect((db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c).toBe(1)

    seedDefaultAdmin(db) // second call must be a no-op, not a duplicate/error
    expect((db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c).toBe(1)

    db.close()
  })
})
