/**
 * Behavioral coverage for the "NEW since your last view" cross-reference that
 * app/api/monitoring/monitors/[id]/matches/route.ts renders a badge from —
 * lib/domain-monitor.ts's markMatchesNewSinceLastView.
 *
 * __tests__/monitor-matches-route.test.ts asserts the route's *source text*,
 * which is the right tool for pinning the SQL shape but proves nothing about
 * whether a fingerprint recorded before an admin's cursor actually comes back
 * flagged not-new. This file runs the real function against a real, file-backed
 * better-sqlite3 database — the same "don't trust a mock, prove the real logic"
 * pattern as __tests__/monitor-views-upsert.test.ts and
 * __tests__/sqlite-admin-seed-race.test.ts — driving it through lib/sqlite.ts's
 * own connection by pointing SQLITE_PATH at a temp file, so the production
 * schema (not a hand-simplified copy) is what the query runs against.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { credentialFingerprint } from '@/lib/domain-match'

const CUTOFF = '2026-08-20 12:00:00'
const BEFORE_CUTOFF = '2026-08-19 09:00:00'
const AFTER_CUTOFF = '2026-08-21 09:00:00'

const MONITOR_ID = 1
const USER_ID = 7

// Three distinct credentials: one recorded as seen before the admin's cursor,
// one recorded after it, one never recorded at all.
const SEEN_BEFORE = { email: 'old@aave.com', password: 'oldpass', domain: 'aave.com' }
const SEEN_AFTER = { email: 'recent@aave.com', password: 'recentpass', domain: 'aave.com' }
const NEVER_RECORDED = { email: 'unrecorded@aave.com', password: 'unrecordedpass', domain: 'aave.com' }

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-monitor-is-new-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

/**
 * Point lib/sqlite.ts at a fresh temp database and hand back its (freshly
 * imported) helpers plus the function under test. lib/sqlite.ts reads
 * SQLITE_PATH once at module load and memoizes the connection on `global`, so
 * both have to be cleared for the new path to take effect.
 */
async function loadAgainstFreshDb() {
  process.env.SQLITE_PATH = freshDbPath()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  vi.resetModules()
  const sqlite = await import('@/lib/sqlite')
  const { markMatchesNewSinceLastView } = await import('@/lib/domain-monitor')
  return { ...sqlite, markMatchesNewSinceLastView }
}

beforeEach(() => {
  originalSqlitePath = process.env.SQLITE_PATH
})

afterEach(() => {
  const db = (globalThis as unknown as { _sqliteDb?: { close(): void } })._sqliteDb
  if (db) db.close()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH
  else process.env.SQLITE_PATH = originalSqlitePath
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true })
  }
  vi.resetModules()
})

describe('markMatchesNewSinceLastView (run against a real database)', () => {
  test('flags matches by whether they were recorded seen at or before the admin cursor', async () => {
    const { dbRun, markMatchesNewSinceLastView } = await loadAgainstFreshDb()

    // Real parent rows: monitor_views' foreign keys are enforced (getDb runs
    // PRAGMA foreign_keys = ON), so these cannot be skipped.
    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (?, 'admin@test.local', 'x', 'Admin')`, [USER_ID])
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (?, 'Test', '["aave.com"]')`, [MONITOR_ID])

    dbRun(`INSERT INTO monitor_credential_seen (monitor_id, fingerprint, seen_at) VALUES (?, ?, ?)`, [
      MONITOR_ID,
      credentialFingerprint(SEEN_BEFORE.email, SEEN_BEFORE.password, SEEN_BEFORE.domain),
      BEFORE_CUTOFF,
    ])
    dbRun(`INSERT INTO monitor_credential_seen (monitor_id, fingerprint, seen_at) VALUES (?, ?, ?)`, [
      MONITOR_ID,
      credentialFingerprint(SEEN_AFTER.email, SEEN_AFTER.password, SEEN_AFTER.domain),
      AFTER_CUTOFF,
    ])

    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (?, ?, ?)`, [
      MONITOR_ID, USER_ID, CUTOFF,
    ])

    const results = await markMatchesNewSinceLastView(MONITOR_ID, USER_ID, [
      { url: 'https://aave.com/a', ...SEEN_BEFORE },
      { url: 'https://aave.com/b', ...SEEN_AFTER },
      { url: 'https://aave.com/c', ...NEVER_RECORDED },
    ])

    expect(results.map(r => ({ email: r.email, is_new: r.is_new }))).toEqual([
      // Recorded before this admin looked → they have already seen it.
      { email: SEEN_BEFORE.email, is_new: false },
      // Recorded after this admin looked → new to them.
      { email: SEEN_AFTER.email, is_new: true },
      // Never recorded at all (e.g. the rescan cron hasn't caught up) → new.
      // Absent must NOT be conflated with already-seen.
      { email: NEVER_RECORDED.email, is_new: true },
    ])

    // Non-fingerprint fields must survive untouched — the route returns these
    // rows straight to the client.
    expect(results[0].url).toBe('https://aave.com/a')
    expect(results[0].password).toBe(SEEN_BEFORE.password)
  })

  test('another admin who has never viewed the monitor sees every match as new', async () => {
    const { dbRun, markMatchesNewSinceLastView } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (?, 'admin@test.local', 'x', 'Admin')`, [USER_ID])
    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (99, 'other@test.local', 'x', 'Other')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (?, 'Test', '["aave.com"]')`, [MONITOR_ID])
    dbRun(`INSERT INTO monitor_credential_seen (monitor_id, fingerprint, seen_at) VALUES (?, ?, ?)`, [
      MONITOR_ID,
      credentialFingerprint(SEEN_BEFORE.email, SEEN_BEFORE.password, SEEN_BEFORE.domain),
      BEFORE_CUTOFF,
    ])
    // Only USER_ID has a cursor; user 99 has never opened this monitor.
    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (?, ?, ?)`, [
      MONITOR_ID, USER_ID, CUTOFF,
    ])

    const rows = [{ url: 'https://aave.com/a', ...SEEN_BEFORE }]

    // Unread state is per-admin: the same credential is old for USER_ID and
    // new for the admin who has never looked.
    expect((await markMatchesNewSinceLastView(MONITOR_ID, USER_ID, rows))[0].is_new).toBe(false)
    expect((await markMatchesNewSinceLastView(MONITOR_ID, 99, rows))[0].is_new).toBe(true)
  })

  test('a fingerprint recorded for a DIFFERENT monitor does not mark this one seen', async () => {
    const { dbRun, markMatchesNewSinceLastView } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (?, 'admin@test.local', 'x', 'Admin')`, [USER_ID])
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (?, 'Test', '["aave.com"]')`, [MONITOR_ID])
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (2, 'Other', '["aave.com"]')`)
    // Same credential, recorded before the cutoff but against monitor 2.
    dbRun(`INSERT INTO monitor_credential_seen (monitor_id, fingerprint, seen_at) VALUES (2, ?, ?)`, [
      credentialFingerprint(SEEN_BEFORE.email, SEEN_BEFORE.password, SEEN_BEFORE.domain),
      BEFORE_CUTOFF,
    ])
    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (?, ?, ?)`, [
      MONITOR_ID, USER_ID, CUTOFF,
    ])

    const results = await markMatchesNewSinceLastView(MONITOR_ID, USER_ID, [
      { url: 'https://aave.com/a', ...SEEN_BEFORE },
    ])
    expect(results[0].is_new).toBe(true)
  })
})
