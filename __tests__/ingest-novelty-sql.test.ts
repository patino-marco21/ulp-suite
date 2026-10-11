import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ command: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ command: h.command, query: h.query }) }))

import {
  acquireCommitLock,
  clickhouseNoveltyDb,
  commitInsertSql,
  knownCountSql,
  knownFillSql,
  knownResetSql,
  monitorStageSql,
  resetCommitLock,
  slabDistinctSql,
  slabPredicate,
  stageCountSql,
} from '@/lib/ingest-novelty'
import { stageTables } from '@/lib/ingest-stage'

const t = stageTables('0123456789ab')
const never = new AbortController().signal

beforeEach(() => {
  h.command.mockReset()
  h.query.mockReset()
  resetCommitLock()
})

describe('SQL builders', () => {
  it('slabPredicate selects the rows whose hash falls in slab k of K', () => {
    expect(slabPredicate(1, 0)).toBe('content_key_hash % 1 = 0')
    expect(slabPredicate(15, 14)).toBe('content_key_hash % 15 = 14')
  })

  it.each([[0, 0], [3, 3], [3, -1], [2.5, 0], [3, 0.5], [Number.NaN, 0]])('slabPredicate rejects slab %s of %s', (K, k) => {
    expect(() => slabPredicate(K as number, k as number)).toThrow(/bad slab/)
  })

  it('counts the stage and the slab\'s distinct hashes', () => {
    expect(stageCountSql(t)).toBe('SELECT count() AS c FROM ulp.zz_import_stage_0123456789ab')
    expect(slabDistinctSql(t, 3, 1)).toBe(
      'SELECT uniqExact(content_key_hash) AS c FROM ulp.zz_import_stage_0123456789ab WHERE content_key_hash % 3 = 1',
    )
  })

  it('resets and fills the known table by probing the table with the slab\'s hashes (the small side)', () => {
    expect(knownResetSql(t)).toBe('TRUNCATE TABLE ulp.zz_import_known_0123456789ab')
    expect(knownFillSql(t, 'ulp.credentials', 3, 1)).toBe(
      'INSERT INTO ulp.zz_import_known_0123456789ab\n' +
      'SELECT DISTINCT content_key_hash FROM ulp.credentials\n' +
      'WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.zz_import_stage_0123456789ab WHERE content_key_hash % 3 = 1)',
    )
    expect(knownCountSql(t)).toBe('SELECT count() AS c FROM ulp.zz_import_known_0123456789ab')
  })

  it('inserts one row per new hash, in the six insert columns only', () => {
    expect(commitInsertSql(t, 'ulp.credentials', 3, 1)).toBe(
      'INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name)\n' +
      'SELECT url, email, password, domain, source_file, breach_name FROM ulp.zz_import_stage_0123456789ab\n' +
      'WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)\n' +
      'LIMIT 1 BY content_key_hash',
    )
  })

  it.each(['credentials', 'ulp.credentials; DROP TABLE ulp.sources', 'ulp.', '.credentials', 'a.b.c', "ulp.x'y"])('refuses the table name %j', name => {
    expect(() => commitInsertSql(t, name, 1, 0)).toThrow(/invalid table name/)
    expect(() => knownFillSql(t, name, 1, 0)).toThrow(/invalid table name/)
  })

  describe('monitorStageSql', () => {
    it('matches the not-yet-known rows of the slab with one normalisation per row', () => {
      const q = monitorStageSql(t, 3, 1, { domains: [' Example.test ', 'other.test'], match_mode: 'both' }, 50)!
      expect(q.sql).toContain('FROM ulp.zz_import_stage_0123456789ab')
      expect(q.sql).toContain('WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')
      expect(q.sql).toContain('arrayExists')
      expect(q.sql).toMatch(/LIMIT 1 BY content_key_hash\nLIMIT 50$/)
      expect(q.params).toEqual({ matchDomains: ['example.test', 'other.test'], matchSuffixes: ['.example.test', '.other.test'] })
    })

    it('has no match to make for an empty domain list or an exhausted cap', () => {
      expect(monitorStageSql(t, 1, 0, { domains: [], match_mode: 'url' }, 10)).toBeNull()
      expect(monitorStageSql(t, 1, 0, { domains: ['  '], match_mode: 'url' }, 10)).toBeNull()
      expect(monitorStageSql(t, 1, 0, { domains: ['a.test'], match_mode: 'url' }, 0)).toBeNull()
    })

    it.each(['url', 'credential', 'both'] as const)('builds a query for the %s mode', mode => {
      const q = monitorStageSql(t, 1, 0, { domains: ['a.test'], match_mode: mode }, 5)!
      expect(q.sql).toMatch(/SELECT url, email, password, domain, content_key_hash, \S/)
    })
  })
})

describe('clickhouseNoveltyDb', () => {
  it('runs a statement with the commit settings (not the client default of 60 s) and reports the written rows', async () => {
    h.command.mockResolvedValue({ query_id: 'q', summary: { written_rows: '2452248', read_rows: '1' } })
    const db = clickhouseNoveltyDb()
    const out = await db.exec('INSERT INTO ulp.x SELECT 1', { queryId: 'novelty-q1', signal: never })
    expect(out).toEqual({ writtenRows: 2452248 })
    const call = h.command.mock.calls[0][0]
    expect(call.query).toBe('INSERT INTO ulp.x SELECT 1')
    expect(call.query_id).toBe('novelty-q1')
    expect(call.abort_signal).toBe(never)
    expect(call.clickhouse_settings).toEqual({ max_execution_time: 3300, insert_deduplicate: 0, async_insert: 0, use_query_cache: 0 })
  })

  it('reports no written-rows count when the server sent no summary or a malformed one', async () => {
    const db = clickhouseNoveltyDb()
    h.command.mockResolvedValueOnce({ query_id: 'q' })
    expect(await db.exec('TRUNCATE TABLE ulp.x', { queryId: 'novelty-q2', signal: never })).toEqual({ writtenRows: null })
    h.command.mockResolvedValueOnce({ query_id: 'q', summary: { written_rows: 'n/a' } })
    expect(await db.exec('TRUNCATE TABLE ulp.x', { queryId: 'novelty-q3', signal: never })).toEqual({ writtenRows: null })
  })

  it('selects rows as JSON with the same settings and the query parameters', async () => {
    const json = vi.fn().mockResolvedValue([{ c: '7' }])
    h.query.mockResolvedValue({ json, close: vi.fn() })
    const db = clickhouseNoveltyDb()
    const rows = await db.select<{ c: string }>('SELECT {a:UInt8} AS c', { queryId: 'novelty-q4', signal: never, params: { a: 1 } })
    expect(rows).toEqual([{ c: '7' }])
    const call = h.query.mock.calls[0][0]
    expect(call.format).toBe('JSONEachRow')
    expect(call.query_params).toEqual({ a: 1 })
    expect(call.query_id).toBe('novelty-q4')
    expect(call.clickhouse_settings.max_execution_time).toBe(3300)
    expect(call.clickhouse_settings.use_query_cache).toBe(0)
  })

  it('closes a result set whose signal aborts instead of waiting for the body', async () => {
    const ctrl = new AbortController()
    const close = vi.fn()
    h.query.mockResolvedValue({ json: () => new Promise(() => {}), close })
    const db = clickhouseNoveltyDb()
    const pending = db.select('SELECT 1', { queryId: 'novelty-q5', signal: ctrl.signal })
    await new Promise(r => setTimeout(r, 10))
    ctrl.abort(new Error('stalled'))
    expect(close).toHaveBeenCalled()
    pending.catch(() => {}) // the unresolved body promise is the fake's; nothing more to wait for
  })

  it('kills a statement by its query id, synchronously, and refuses any other id', async () => {
    h.command.mockResolvedValue({ query_id: 'k' })
    const db = clickhouseNoveltyDb()
    await db.kill('novelty-0123abcd-0123-4abc-8abc-0123456789ab')
    expect(h.command.mock.calls[0][0].query).toBe("KILL QUERY WHERE query_id = 'novelty-0123abcd-0123-4abc-8abc-0123456789ab' SYNC")
    expect(h.command.mock.calls[0][0].abort_signal).toBeInstanceOf(AbortSignal) // bounded: a frozen server must not hold the lock
    await expect(db.kill("novelty-x' OR 1=1 --")).rejects.toThrow(/invalid query id/)
    await expect(db.kill('something-else')).rejects.toThrow(/invalid query id/)
  })
})

describe('acquireCommitLock', () => {
  it('hands the lock to one holder at a time, in arrival order', async () => {
    const order: string[] = []
    const first = await acquireCommitLock(never)
    const second = acquireCommitLock(never).then(release => { order.push('second'); return release })
    const third = acquireCommitLock(never).then(release => { order.push('third'); return release })
    await new Promise(r => setTimeout(r, 10))
    expect(order).toEqual([])
    first()
    const secondRelease = await second
    expect(order).toEqual(['second'])
    secondRelease()
    ;(await third)()
    expect(order).toEqual(['second', 'third'])
  })

  it('release is idempotent', async () => {
    const release = await acquireCommitLock(never)
    release()
    release()
    const next = await Promise.race([acquireCommitLock(never), new Promise<null>(r => setTimeout(() => r(null), 100))])
    expect(next).not.toBeNull()
  })

  it('a waiter that is aborted gives up its place without blocking those behind it', async () => {
    const holder = await acquireCommitLock(never)
    const ctrl = new AbortController()
    const abandoned = acquireCommitLock(ctrl.signal)
    const behind = acquireCommitLock(never)
    ctrl.abort(new Error('stalled'))
    await expect(abandoned).rejects.toThrow('stalled')
    holder()
    const release = await Promise.race([behind, new Promise<null>(r => setTimeout(() => r(null), 200))])
    expect(release).not.toBeNull()
  })

  it('refuses at once when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('already'))
    await expect(acquireCommitLock(ctrl.signal)).rejects.toThrow('already')
    const release = await Promise.race([acquireCommitLock(never), new Promise<null>(r => setTimeout(() => r(null), 100))])
    expect(release).not.toBeNull()
  })
})
