import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-monitor-matches-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

async function loadAgainstFreshDb() {
  process.env.SQLITE_PATH = freshDbPath()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  vi.resetModules()
  const sqlite = await import('@/lib/sqlite')
  const dm = await import('@/lib/domain-monitor')
  return { ...sqlite, ...dm }
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

const ROW_A = { url: 'https://trezor.io/a', email: 'a@trezor.io', password: 'pw1', domain: 'trezor.io' }
const ROW_B = { url: 'https://trezor.io/b', email: 'b@trezor.io', password: 'pw2', domain: 'trezor.io' }

describe('getMonitorMatchesCache', () => {
  test('never_scanned when no rescan has ever run', async () => {
    const { dbRun, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    const cache = await getMonitorMatchesCache(1)
    expect(cache).toEqual({ rows: [], status: 'never_scanned', checkedAt: null, lastError: null })
  })

  test('writeMonitorMatchCache stores rows and marks status ok', async () => {
    const { dbRun, writeMonitorMatchCache, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [ROW_A, ROW_B])
    const cache = await getMonitorMatchesCache(1)

    expect(cache.status).toBe('ok')
    expect(cache.lastError).toBeNull()
    expect(cache.checkedAt).not.toBeNull()
    expect(cache.rows).toEqual(
      expect.arrayContaining([expect.objectContaining(ROW_A), expect.objectContaining(ROW_B)])
    )
    expect(cache.rows.length).toBe(2)
  })

  test('writeMonitorMatchCache fully replaces the previous snapshot (delete-then-insert)', async () => {
    const { dbRun, writeMonitorMatchCache, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [ROW_A])
    await writeMonitorMatchCache(1, [ROW_B])
    const cache = await getMonitorMatchesCache(1)

    expect(cache.rows).toEqual([expect.objectContaining(ROW_B)])
  })

  test('recordMonitorRescanFailure marks status failed but does not touch monitor_matches', async () => {
    const { dbRun, writeMonitorMatchCache, recordMonitorRescanFailure, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [ROW_A])
    const firstCheckedAt = (await getMonitorMatchesCache(1)).checkedAt

    await recordMonitorRescanFailure(1, 'Timeout exceeded: elapsed 60049ms, maximum: 60000ms.')
    const cache = await getMonitorMatchesCache(1)

    expect(cache.status).toBe('failed')
    expect(cache.lastError).toBe('Timeout exceeded: elapsed 60049ms, maximum: 60000ms.')
    // The last GOOD snapshot survives a subsequent failure — a cache is more
    // useful stale than empty.
    expect(cache.rows).toEqual([expect.objectContaining(ROW_A)])
    expect(cache.checkedAt).toBe(firstCheckedAt)
  })

  test('a monitor with zero genuine matches after a successful scan still has a checkedAt', async () => {
    const { dbRun, writeMonitorMatchCache, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [])
    const cache = await getMonitorMatchesCache(1)

    expect(cache.status).toBe('ok')
    expect(cache.rows).toEqual([])
    expect(cache.checkedAt).not.toBeNull()
  })
})
