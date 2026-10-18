import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import {
  acquireCommitLock,
  commitStage,
  NoveltyAccountingError,
  resetCommitLock,
  type CommitGates,
  type CommitOptions,
  type NoveltyDb,
} from '@/lib/ingest-novelty'
import { stageTables } from '@/lib/ingest-stage'

const tables = stageTables('0123456789ab')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Call { kind: 'select' | 'exec' | 'kill'; sql: string; queryId: string; settings?: Record<string, number> }

interface FakeConfig {
  stageRows: number
  distinct: number[]
  known: number[]
  written?: (k: number, expected: number) => number | null
  monitorRows?: Array<{ url: string; email: string; password: string; domain: string }>
  monitorError?: Error
  execDelayMs?: number
  hang?: RegExp
  onSlabStart?: () => void
  onSlabEnd?: () => void
}

function makeDb(cfg: FakeConfig) {
  const calls: Call[] = []
  let slab = 0
  const slabOf = (sql: string) => Number(/% \d+ = (\d+)/.exec(sql)?.[1] ?? 0)
  const db: NoveltyDb & { calls: Call[] } = {
    calls,
    async select<T>(sql: string) {
      const typed = (rows: unknown) => rows as T[]
      calls.push({ kind: 'select', sql, queryId: '' })
      if (cfg.execDelayMs) await sleep(cfg.execDelayMs)
      if (sql.startsWith('SELECT count() AS c FROM ulp.zz_import_stage_')) return typed([{ c: String(cfg.stageRows) }])
      if (sql.startsWith('SELECT uniqExact')) return typed([{ c: String(cfg.distinct[slabOf(sql)]) }])
      if (sql.startsWith('SELECT count() AS c FROM ulp.zz_import_known_')) return typed([{ c: String(cfg.known[slab]) }])
      if (sql.startsWith('SELECT url, email, password, domain FROM (')) {
        if (cfg.monitorError) throw cfg.monitorError
        return typed(cfg.monitorRows ?? [])
      }
      throw new Error(`unexpected select: ${sql}`)
    },
    async exec(sql, { queryId, signal, settings }) {
      calls.push({ kind: 'exec', sql, queryId, settings })
      if (cfg.execDelayMs) await sleep(cfg.execDelayMs)
      if (cfg.hang?.test(sql)) {
        await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      if (sql.startsWith('TRUNCATE TABLE')) return { writtenRows: null }
      if (sql.startsWith('INSERT INTO ulp.zz_import_known_')) {
        slab = slabOf(sql)
        cfg.onSlabStart?.()
        return { writtenRows: cfg.known[slab] }
      }
      if (sql.startsWith('INSERT INTO ulp.')) {
        const k = slabOf(sql)
        const expected = cfg.distinct[k] - cfg.known[k]
        const out = { writtenRows: cfg.written ? cfg.written(k, expected) : expected }
        cfg.onSlabEnd?.()
        return out
      }
      throw new Error(`unexpected exec: ${sql}`)
    },
    async kill(queryId) {
      calls.push({ kind: 'kill', sql: '', queryId })
    },
  }
  return db
}

const gates = (events: string[]): CommitGates => ({
  disk: async () => { events.push('disk') },
  memory: async () => { events.push('memory') },
})

let counter = 0
const options = (db: NoveltyDb, extra: Partial<CommitOptions> = {}): CommitOptions => ({
  tables,
  target: 'ulp.credentials',
  noveltyAgainst: 'ulp.credentials',
  parsedRows: 0,
  slabRows: 20_000_000,
  signal: new AbortController().signal,
  db,
  gates: gates([]),
  newQueryId: () => `novelty-test-${++counter}`,
  ...extra,
})

// A readable name for each statement the commit sends, so a test can assert the order without matching SQL text.
const label = (c: Call): string => {
  if (c.kind === 'kill') return 'kill'
  if (c.sql.startsWith('SELECT count() AS c FROM ulp.zz_import_stage_')) return 'select stage count'
  if (c.sql.startsWith('SELECT uniqExact')) return 'select slab distinct'
  if (c.sql.startsWith('TRUNCATE TABLE')) return 'truncate known'
  if (c.sql.startsWith('INSERT INTO ulp.zz_import_known_')) return 'fill known'
  if (c.sql.startsWith('SELECT count() AS c FROM ulp.zz_import_known_')) return 'select known count'
  if (c.sql.startsWith('INSERT INTO ulp.')) return 'insert new rows'
  if (c.sql.startsWith('SELECT url, email, password, domain FROM (')) return 'select monitor matches'
  return c.sql
}
const shape = (db: { calls: Call[] }) => db.calls.map(label)

beforeEach(() => {
  counter = 0
  resetCommitLock()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('commitStage', () => {
  it('writes a file of new rows in one slab and accounts for every parsed row', async () => {
    const db = makeDb({ stageRows: 1000, distinct: [900], known: [0] })
    const out = await commitStage(options(db, { parsedRows: 1000 }))
    expect(out).toMatchObject({ rows: 1000, distinct: 900, known: 0, inserted: 900, inFileDuplicates: 100, slabs: 1, matches: [] })
    expect(out.rows).toBe(out.inserted + out.known + out.inFileDuplicates)
    expect(shape(db)).toEqual([
      'select stage count',
      'select slab distinct',
      'truncate known',
      'fill known',
      'select known count',
      'insert new rows',
    ])
  })

  it('writes only what the table does not hold', async () => {
    const db = makeDb({ stageRows: 1000, distinct: [1000], known: [400] })
    const out = await commitStage(options(db, { parsedRows: 1000 }))
    expect(out).toMatchObject({ distinct: 1000, known: 400, inserted: 600, inFileDuplicates: 0 })
    expect(out.rows).toBe(out.inserted + out.known + out.inFileDuplicates)
    const insert = db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.credentials'))!
    expect(insert.sql).toContain('NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')
    expect(insert.sql).toContain('LIMIT 1 BY content_key_hash')
  })

  it('reads one table and writes another when they differ (the read-only parity check)', async () => {
    const db = makeDb({ stageRows: 10, distinct: [10], known: [0] })
    await commitStage(options(db, { parsedRows: 10, target: 'ulp.zz_clone', noveltyAgainst: 'ulp.credentials' }))
    const fill = db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.zz_import_known_'))!
    expect(fill.sql).toContain('FROM ulp.credentials\n')
    expect(db.calls.some(c => c.sql.startsWith('INSERT INTO ulp.zz_clone (url'))).toBe(true)
    expect(db.calls.some(c => c.sql.startsWith('INSERT INTO ulp.credentials'))).toBe(false)
  })

  it('commits in slabs by hash, skips the insert of a slab that is entirely known, and reports running totals', async () => {
    const db = makeDb({ stageRows: 2500, distinct: [800, 850, 850], known: [0, 100, 850] })
    const slabs: Array<{ slab: number; slabs: number; known: number; inserted: number }> = []
    const phases: string[] = []
    const out = await commitStage(options(db, {
      parsedRows: 2600,
      slabRows: 1000,
      onSlab: e => slabs.push(e),
      onPhase: e => phases.push(`${e.slab}/${e.slabs} ${e.phase}`),
    }))
    expect(out).toMatchObject({ slabs: 3, distinct: 2500, known: 950, inserted: 1550, inFileDuplicates: 100 })
    expect(slabs).toEqual([
      { slab: 1, slabs: 3, known: 0, inserted: 800 },
      { slab: 2, slabs: 3, known: 100, inserted: 1550 },
      { slab: 3, slabs: 3, known: 950, inserted: 1550 },
    ])
    expect(phases).toEqual(['1/3 checking', '1/3 inserting', '2/3 checking', '2/3 inserting', '3/3 checking'])
    const inserts = db.calls.filter(c => c.sql.startsWith('INSERT INTO ulp.credentials'))
    expect(inserts).toHaveLength(2) // slab 3 is entirely known
    expect(inserts[0].sql).toContain('content_key_hash % 3 = 0')
    expect(inserts[1].sql).toContain('content_key_hash % 3 = 1')
    expect(db.calls.filter(c => c.sql.startsWith('TRUNCATE')).length).toBe(3)
  })

  it('does nothing, and asks nothing of the gates, for an empty stage', async () => {
    const events: string[] = []
    const db = makeDb({ stageRows: 0, distinct: [], known: [] })
    const out = await commitStage(options(db, { parsedRows: 0, gates: gates(events) }))
    expect(out).toMatchObject({ rows: 0, distinct: 0, known: 0, inserted: 0, inFileDuplicates: 0, slabs: 1 })
    expect(shape(db)).toEqual(['select stage count'])
    expect(events).toEqual([])
  })

  it('waits for the disk gate and the memory guard before every slab, and before taking the lock', async () => {
    const events: string[] = []
    const db = makeDb({ stageRows: 2000, distinct: [1000, 1000], known: [0, 0], onSlabStart: () => events.push('slab-sql') })
    await commitStage(options(db, { parsedRows: 2000, slabRows: 1000, gates: gates(events) }))
    expect(events).toEqual(['disk', 'memory', 'slab-sql', 'disk', 'memory', 'slab-sql'])
  })

  it('asks the gates before it waits for the lock, so a paused import never holds the lock', async () => {
    const events: string[] = []
    const holder = await acquireCommitLock(new AbortController().signal)
    const db = makeDb({ stageRows: 10, distinct: [10], known: [0], onSlabStart: () => events.push('slab-sql') })
    const run = commitStage(options(db, { parsedRows: 10, gates: gates(events) }))
    await sleep(30)
    expect(events).toEqual(['disk', 'memory']) // the gates are done, the import is still waiting for the lock
    holder()
    await run
    expect(events).toEqual(['disk', 'memory', 'slab-sql'])
  })

  it('passes the heartbeat to the gates and beats after every statement', async () => {
    const beat = vi.fn()
    let polled: (() => void) | undefined
    const db = makeDb({ stageRows: 10, distinct: [10], known: [0] })
    await commitStage(options(db, {
      parsedRows: 10,
      beat,
      gates: { disk: async (_s, o) => { polled = o.onPoll }, memory: async () => {} },
    }))
    expect(polled).toBe(beat)
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(6) // one per statement
  })

  it('fails the job, keeping the rows already written, when ClickHouse reports a different count', async () => {
    const db = makeDb({ stageRows: 1000, distinct: [1000], known: [400], written: (_k, expected) => expected + 1 })
    await expect(commitStage(options(db, { parsedRows: 1000 }))).rejects.toThrow(NoveltyAccountingError)
    await expect(commitStage(options(db, { parsedRows: 1000 }))).rejects.toThrow(/reported 601 rows written but 600 were expected \(1000 distinct - 400 known\)/)
    // the lock is free again
    const release = await Promise.race([acquireCommitLock(new AbortController().signal), sleep(100).then(() => null)])
    expect(release).not.toBeNull()
  })

  it('skips the check, with a warning, when the server sent no written-rows count', async () => {
    const db = makeDb({ stageRows: 100, distinct: [100], known: [0], written: () => null })
    const out = await commitStage(options(db, { parsedRows: 100 }))
    expect(out.inserted).toBe(100)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no written-rows count'))
  })

  it('refuses a known count larger than the slab itself', async () => {
    const db = makeDb({ stageRows: 100, distinct: [100], known: [101] })
    await expect(commitStage(options(db, { parsedRows: 100 }))).rejects.toThrow(NoveltyAccountingError)
  })

  it('kills the running statement and frees the lock when the import is aborted mid-insert', async () => {
    const ctrl = new AbortController()
    const db = makeDb({ stageRows: 100, distinct: [100], known: [0], hang: /^INSERT INTO ulp\.credentials/ })
    const run = commitStage(options(db, { parsedRows: 100, signal: ctrl.signal }))
    run.catch(() => {})
    await sleep(20)
    ctrl.abort(new Error('stalled'))
    await expect(run).rejects.toThrow('stalled')
    const killed = db.calls.find(c => c.kind === 'kill')!
    const commitInsert = db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.credentials'))!
    expect(killed.queryId).toBe(commitInsert.queryId)
    const release = await Promise.race([acquireCommitLock(new AbortController().signal), sleep(100).then(() => null)])
    expect(release).not.toBeNull()
  })

  it('does not start a slab once the signal has aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('already'))
    const db = makeDb({ stageRows: 100, distinct: [100], known: [0] })
    await expect(commitStage(options(db, { parsedRows: 100, signal: ctrl.signal }))).rejects.toThrow('already')
    expect(db.calls.some(c => c.sql.startsWith('TRUNCATE'))).toBe(false)
  })

  it('never lets two files commit a slab at the same time', async () => {
    let inSlab = 0
    let maxInSlab = 0
    const probe = {
      onSlabStart: () => { inSlab++; maxInSlab = Math.max(maxInSlab, inSlab) },
      onSlabEnd: () => { inSlab-- },
    }
    const a = makeDb({ stageRows: 2000, distinct: [1000, 1000], known: [0, 0], execDelayMs: 3, ...probe })
    const b = makeDb({ stageRows: 2000, distinct: [1000, 1000], known: [0, 0], execDelayMs: 3, ...probe })
    const [ra, rb] = await Promise.all([
      commitStage(options(a, { parsedRows: 2000, slabRows: 1000 })),
      commitStage(options(b, { parsedRows: 2000, slabRows: 1000 })),
    ])
    expect(ra.inserted).toBe(2000)
    expect(rb.inserted).toBe(2000)
    expect(maxInSlab).toBe(1)
  })

  describe('monitors', () => {
    const monitor = (id: number) => ({ id, domains: ['example.test'], match_mode: 'both' as const })
    const row = (n: number) => ({ url: `https://example.test/${n}`, email: `u${n}@example.test`, password: `pw${n}`, domain: 'example.test' })

    it('matches the new rows of each slab on the stage, tagged with the monitor, within the cap', async () => {
      const db = makeDb({ stageRows: 100, distinct: [100], known: [10], monitorRows: [row(1), row(2), row(3)] })
      const out = await commitStage(options(db, { parsedRows: 100, monitors: [monitor(7)], matchCap: 5 }))
      expect(out.matches).toEqual([
        { monitorId: 7, ...row(1) },
        { monitorId: 7, ...row(2) },
        { monitorId: 7, ...row(3) },
      ])
      const q = db.calls.find(c => c.sql.startsWith('SELECT url, email, password, domain FROM ('))!
      expect(q.sql).toContain('NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')
      expect(q.sql).toMatch(/LIMIT 5$/)
    })

    it('asks the next monitor only for what is left of the cap, and stops at the cap', async () => {
      const db = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorRows: [row(1), row(2), row(3)] })
      const out = await commitStage(options(db, { parsedRows: 100, monitors: [monitor(1), monitor(2), monitor(3)], matchCap: 4 }))
      const limits = db.calls.filter(c => c.sql.startsWith('SELECT url, email')).map(c => /LIMIT (\d+)$/.exec(c.sql)![1])
      expect(limits).toEqual(['4', '1'])
      expect(out.matches).toHaveLength(4)
    })

    it('makes no monitor query when nothing is new, when there is no cap, or when no monitor has a domain', async () => {
      const allKnown = makeDb({ stageRows: 100, distinct: [100], known: [100], monitorRows: [row(1)] })
      await commitStage(options(allKnown, { parsedRows: 100, monitors: [monitor(1)], matchCap: 5 }))
      const noCap = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorRows: [row(1)] })
      await commitStage(options(noCap, { parsedRows: 100, monitors: [monitor(1)], matchCap: 0 }))
      const noDomains = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorRows: [row(1)] })
      await commitStage(options(noDomains, { parsedRows: 100, monitors: [{ id: 1, domains: [' '], match_mode: 'url' }], matchCap: 5 }))
      for (const db of [allKnown, noCap, noDomains]) {
        expect(db.calls.some(c => c.sql.startsWith('SELECT url, email, password, domain FROM ('))).toBe(false)
      }
    })

    it('does not fail an import that already wrote its rows because a monitor query failed', async () => {
      const db = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorError: new Error('Code: 241. memory limit') })
      const out = await commitStage(options(db, { parsedRows: 100, monitors: [monitor(1)], matchCap: 5 }))
      expect(out).toMatchObject({ inserted: 100, matches: [] })
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('monitor 1'))
      expect(db.calls.some(c => c.kind === 'kill')).toBe(false)
    })
  })
})

describe('commitStage: the commit insert runs on several insert threads', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const run = async (extra: Partial<CommitOptions> = {}) => {
    const db = makeDb({ stageRows: 1000, distinct: [900], known: [100] })
    await commitStage(options(db, { parsedRows: 1000, ...extra }))
    return db
  }
  const commitInsert = (db: { calls: Call[] }) => db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.credentials'))!

  it('asks for 4 insert threads by default, and only the commit insert asks', async () => {
    const db = await run()
    expect(commitInsert(db).settings).toEqual({ max_insert_threads: 4 })
    const others = db.calls.filter(c => c.kind === 'exec' && c !== commitInsert(db))
    expect(others.map(label)).toEqual(['truncate known', 'fill known']) // the existence scan keeps the server's own plan
    expect(others.every(c => c.settings === undefined)).toBe(true)
  })

  it('takes the count from INGEST_COMMIT_INSERT_THREADS', async () => {
    vi.stubEnv('INGEST_COMMIT_INSERT_THREADS', '8')
    expect(commitInsert(await run()).settings).toEqual({ max_insert_threads: 8 })
  })

  it('an explicit count wins over the environment', async () => {
    vi.stubEnv('INGEST_COMMIT_INSERT_THREADS', '8')
    expect(commitInsert(await run({ insertThreads: 2 })).settings).toEqual({ max_insert_threads: 2 })
  })

  it('rows written and the accounting check do not depend on the thread count', async () => {
    for (const insertThreads of [1, 4, 16]) {
      expect(await commitStage(options(makeDb({ stageRows: 1000, distinct: [900], known: [100] }), { parsedRows: 1000, insertThreads })))
        .toMatchObject({ inserted: 800, known: 100, distinct: 900 })
    }
  })
})

describe('commitStage: how long the check and the insert took', () => {
  // The fake database advances a fake clock by what each statement "costs", so the numbers are exact. The slab-distinct and stage counts
  // cost 1000 each: they are not a phase, and must not show up in either number.
  const cost = (sql: string): number =>
    sql.startsWith('TRUNCATE') ? 2
    : sql.startsWith('INSERT INTO ulp.zz_import_known_') ? 40
    : sql.startsWith('SELECT count() AS c FROM ulp.zz_import_known_') ? 3
    : sql.startsWith('INSERT INTO ulp.') ? 300
    : 1000
  const timed = (cfg: FakeConfig) => {
    let clock = 5_000
    const base = makeDb(cfg)
    const db: NoveltyDb & { calls: Call[] } = {
      calls: base.calls,
      async select<T>(sql: string, o: Parameters<NoveltyDb['select']>[1]) { clock += cost(sql); return base.select<T>(sql, o) },
      async exec(sql, o) { clock += cost(sql); return base.exec(sql, o) },
      kill: base.kill,
    }
    return { db, now: () => clock }
  }

  it('reports the existence check (reset, fill, count) and the commit insert of a one-slab file', async () => {
    const { db, now } = timed({ stageRows: 1000, distinct: [900], known: [100] })
    expect(await commitStage(options(db, { parsedRows: 1000, now }))).toMatchObject({ checkMs: 45, commitMs: 300 })
  })

  it('adds up the slabs, and an entirely known slab costs a check but no insert', async () => {
    const { db, now } = timed({ stageRows: 1700, distinct: [800, 850], known: [0, 850] })
    expect(await commitStage(options(db, { parsedRows: 1700, slabRows: 1000, now }))).toMatchObject({ slabs: 2, checkMs: 90, commitMs: 300 })
  })

  it('is zero for an empty stage', async () => {
    const { db, now } = timed({ stageRows: 0, distinct: [], known: [] })
    expect(await commitStage(options(db, { parsedRows: 0, now }))).toMatchObject({ checkMs: 0, commitMs: 0 })
  })
})
