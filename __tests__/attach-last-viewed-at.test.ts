/**
 * Behavioral coverage for lib/domain-monitor.ts's attachLastViewedAt — the
 * enrichment GET /api/monitoring/monitors uses to add a per-user
 * last_viewed_at to each monitor for the saved-searches hub page. Runs
 * against a real, file-backed better-sqlite3 database via lib/sqlite.ts's
 * own SQLITE_PATH-pointed connection (the same pattern as
 * __tests__/monitor-is-new.test.ts), since a mocked dbGet can't catch a
 * wrong join/param order.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  return path.join(os.tmpdir(), `ulp-attach-last-viewed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

/**
 * Point lib/sqlite.ts at a fresh temp database and hand back its (freshly
 * imported) helpers plus the function under test. lib/sqlite.ts reads
 * SQLITE_PATH once at module load and memoizes the connection on `global`,
 * so both have to be cleared for the new path to take effect.
 */
async function loadAgainstFreshDb() {
  const p = freshDbPath()
  tmpFiles.push(p)
  process.env.SQLITE_PATH = p
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  vi.resetModules()
  const sqlite = await import('@/lib/sqlite')
  const { attachLastViewedAt } = await import('@/lib/domain-monitor')
  return { ...sqlite, attachLastViewedAt }
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

describe('attachLastViewedAt (run against a real database)', () => {
  test('null for a monitor this user has never viewed, populated after a view', async () => {
    const { dbRun, attachLastViewedAt } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (7, 'admin@test.local', 'x', 'Admin')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)

    const before = await attachLastViewedAt([{ id: 1, name: 'Test' }], 7)
    expect(before).toEqual([{ id: 1, name: 'Test', last_viewed_at: null }])

    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (1, 7, '2026-08-24 10:00:00')`)

    const after = await attachLastViewedAt([{ id: 1, name: 'Test' }], 7)
    expect(after).toEqual([{ id: 1, name: 'Test', last_viewed_at: '2026-08-24 10:00:00' }])
  })

  test('is scoped per-user — one admin viewing does not affect another admin\'s value', async () => {
    const { dbRun, attachLastViewedAt } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (7, 'admin@test.local', 'x', 'Admin')`)
    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (8, 'other@test.local', 'x', 'Other')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)
    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (1, 7, '2026-08-24 10:00:00')`)

    const forViewer = await attachLastViewedAt([{ id: 1, name: 'Test' }], 7)
    const forOther = await attachLastViewedAt([{ id: 1, name: 'Test' }], 8)
    expect(forViewer[0].last_viewed_at).toBe('2026-08-24 10:00:00')
    expect(forOther[0].last_viewed_at).toBeNull()
  })

  test('preserves every other field on each monitor, across a list of several', async () => {
    const { dbRun, attachLastViewedAt } = await loadAgainstFreshDb()

    dbRun(`INSERT INTO users (id, email, password_hash, name) VALUES (7, 'admin@test.local', 'x', 'Admin')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'First', '["a.com"]')`)
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (2, 'Second', '["b.com"]')`)
    dbRun(`INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at) VALUES (2, 7, '2026-08-24 09:00:00')`)

    const result = await attachLastViewedAt(
      [{ id: 1, name: 'First', match_mode: 'both' }, { id: 2, name: 'Second', match_mode: 'url' }],
      7
    )
    expect(result).toEqual([
      { id: 1, name: 'First', match_mode: 'both', last_viewed_at: null },
      { id: 2, name: 'Second', match_mode: 'url', last_viewed_at: '2026-08-24 09:00:00' },
    ])
  })
})
