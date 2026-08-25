import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-monitor-matches-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

async function loadAgainstFreshDb() {
  process.env.SQLITE_PATH = freshDbPath()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  vi.resetModules()
  return import('@/lib/sqlite')
}

beforeEach(() => {
  originalSqlitePath = process.env.SQLITE_PATH
})

afterEach(async () => {
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

describe('monitor_matches / monitor_rescan_status schema', () => {
  test('both tables exist with the expected columns after initSchema runs', async () => {
    const { dbQuery } = await loadAgainstFreshDb()

    const matchesCols = (dbQuery(`PRAGMA table_info(monitor_matches)`) as Array<{ name: string }>).map(c => c.name)
    expect(matchesCols).toEqual(['monitor_id', 'url', 'email', 'password', 'domain', 'fetched_at'])

    const statusCols = (dbQuery(`PRAGMA table_info(monitor_rescan_status)`) as Array<{ name: string }>).map(c => c.name)
    expect(statusCols).toEqual(['monitor_id', 'status', 'error', 'attempted_at', 'last_success_at'])
  })

  test('monitor_matches allows two rows with the same (monitor_id, url, email) but different password', async () => {
    const { dbRun, dbQuery } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)

    dbRun(`INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at) VALUES (1, 'https://aave.com', 'u@aave.com', 'pw1', 'aave.com', datetime('now'))`)
    dbRun(`INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at) VALUES (1, 'https://aave.com', 'u@aave.com', 'pw2', 'aave.com', datetime('now'))`)

    const rows = dbQuery(`SELECT password FROM monitor_matches WHERE monitor_id = 1 ORDER BY password`) as Array<{ password: string }>
    expect(rows.map(r => r.password)).toEqual(['pw1', 'pw2'])
  })

  test('deleting a monitor cascades to both new tables', async () => {
    const { dbRun, dbGet } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)
    dbRun(`INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at) VALUES (1, 'https://aave.com', 'u@aave.com', 'pw1', 'aave.com', datetime('now'))`)
    dbRun(`INSERT INTO monitor_rescan_status (monitor_id, status, error, attempted_at, last_success_at) VALUES (1, 'ok', NULL, datetime('now'), datetime('now'))`)

    dbRun(`DELETE FROM domain_monitors WHERE id = 1`)

    expect(dbGet(`SELECT * FROM monitor_matches WHERE monitor_id = 1`)).toBeUndefined()
    expect(dbGet(`SELECT * FROM monitor_rescan_status WHERE monitor_id = 1`)).toBeUndefined()
  })
})

describe('startup domain normalization fixup', () => {
  test('re-normalizes a previously-stored monitor whose domains have trailing slashes', async () => {
    process.env.SQLITE_PATH = freshDbPath()
    ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
    vi.resetModules()

    // First load: insert a monitor the way the OLD (buggy) route code would
    // have — trailing slashes intact — bypassing normalizeDomainInput
    // entirely, simulating data written before this fix existed.
    const sqlite1 = await import('@/lib/sqlite')
    sqlite1.dbRun(
      `INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', ?)`,
      [JSON.stringify(['trezor.io/', 'ledger.com/'])]
    )
    const db1 = (globalThis as unknown as { _sqliteDb?: { close(): void } })._sqliteDb
    if (db1) db1.close()
    ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
    vi.resetModules()

    // Second load re-runs initSchema (and the fixup pass) against the same
    // file, the way a real process restart would.
    const sqlite2 = await import('@/lib/sqlite')
    const row = sqlite2.dbGet(`SELECT domains FROM domain_monitors WHERE id = 1`) as { domains: string }
    expect(JSON.parse(row.domains)).toEqual(['trezor.io', 'ledger.com'])
  })
})
