import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ command: vi.fn().mockResolvedValue({}), query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ command: h.command, query: h.query }) }))

import {
  activeStageIds,
  createStage,
  dropStage,
  knownDdl,
  newStageId,
  registerStage,
  stageDdl,
  stageTables,
  startStageSweeper,
  sweepOrphanStages,
  unregisterStage,
  type StageSweepDb,
} from '@/lib/ingest-stage'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

const squash = (s: string) => s.replace(/\s+/g, '')

beforeEach(() => {
  h.command.mockReset()
  h.command.mockResolvedValue({})
  h.query.mockReset()
  for (const id of activeStageIds()) unregisterStage(id)
})

describe('names', () => {
  it('makes a 12-hex-character id that differs between calls', () => {
    const a = newStageId()
    const b = newStageId()
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(b).toMatch(/^[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  it('derives both fully qualified table names from the id', () => {
    expect(stageTables('0123456789ab')).toEqual({
      id: '0123456789ab',
      stage: 'ulp.zz_import_stage_0123456789ab',
      known: 'ulp.zz_import_known_0123456789ab',
    })
  })

  it.each(['', 'ABCDEF012345', '0123456789a', '0123456789abc', '../etc/passwd', "x'; DROP TABLE a; --"])('rejects the malformed id %j', id => {
    expect(() => stageTables(id)).toThrow(/invalid stage id/)
  })
})

describe('DDL', () => {
  const t = stageTables('0123456789ab')

  it('makes a plain, unpartitioned MergeTree stage with the six insert columns and the shared hash expression', () => {
    const ddl = stageDdl(t)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ulp.zz_import_stage_0123456789ab')
    expect(ddl).toContain('ENGINE = MergeTree ORDER BY tuple()')
    expect(ddl).not.toMatch(/Replicated|PARTITION BY|INDEX|PROJECTION/)
    for (const column of ['url String', 'email String', 'password String', 'domain String', 'source_file String', 'breach_name String']) {
      expect(ddl).toContain(column)
    }
    expect(squash(ddl)).toContain(squash(`content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password)`))
    expect(ddl).toContain('non_replicated_deduplication_window = 10000')
  })

  it('makes a small known table ordered by the hash', () => {
    expect(knownDdl(t)).toBe(
      'CREATE TABLE IF NOT EXISTS ulp.zz_import_known_0123456789ab (content_key_hash UInt64) ENGINE = MergeTree ORDER BY content_key_hash',
    )
  })

  it('computes the hash exactly as the live table does (drift test)', () => {
    const expected = squash(`cityHash64(${URL_CONTENT_KEY}, email, password)`)
    const initSql = readFileSync(new URL('../docker/clickhouse/init/01-ulp-tables.sql', import.meta.url), 'utf8')
    const migrations = readFileSync(new URL('../lib/clickhouse-migrations.ts', import.meta.url), 'utf8')
    expect(squash(initSql)).toContain(`content_key_hashUInt64MATERIALIZED${expected}`)
    expect(squash(migrations)).toContain(squash('cityHash64(${URL_CONTENT_KEY}, email, password)'))
    expect(squash(stageDdl(t))).toContain(expected)
  })
})

describe('createStage / dropStage', () => {
  const t = stageTables('0123456789ab')

  it('creates the stage first and the known table second', async () => {
    await createStage(t)
    expect(h.command).toHaveBeenCalledTimes(2)
    expect(h.command.mock.calls[0][0].query).toBe(stageDdl(t))
    expect(h.command.mock.calls[1][0].query).toBe(knownDdl(t))
  })

  it('drops both tables synchronously, so the space is freed at once', async () => {
    await dropStage(t)
    expect(h.command.mock.calls.map(c => c[0].query)).toEqual([
      'DROP TABLE IF EXISTS ulp.zz_import_stage_0123456789ab SYNC',
      'DROP TABLE IF EXISTS ulp.zz_import_known_0123456789ab SYNC',
    ])
  })

  it('still tries the second drop when the first fails, then reports the failure', async () => {
    h.command.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({})
    await expect(dropStage(t)).rejects.toThrow('boom')
    expect(h.command).toHaveBeenCalledTimes(2)
  })
})

describe('registry', () => {
  it('tracks the stages this process is using', () => {
    expect(activeStageIds()).toEqual([])
    registerStage('aaaaaaaaaaaa')
    registerStage('bbbbbbbbbbbb')
    expect(activeStageIds().sort()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    unregisterStage('aaaaaaaaaaaa')
    expect(activeStageIds()).toEqual(['bbbbbbbbbbbb'])
  })
})

describe('startStageSweeper', () => {
  it('sweeps once at start, says so, and does not start a second sweeper', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.query.mockResolvedValue({ json: async () => [] })
    try {
      await startStageSweeper({ intervalMs: 3_600_000 })
      expect(warn).toHaveBeenCalledWith('[ingest-stage] start-up sweep: no orphan stage tables')
      expect(h.query).toHaveBeenCalledTimes(1)
      await startStageSweeper({ intervalMs: 3_600_000 })
      expect(h.query).toHaveBeenCalledTimes(1)
    } finally {
      clearInterval(globalThis.__ulpStageSweeper)
      globalThis.__ulpStageSweeper = undefined
    }
  })

  it('reports what it dropped, and never rejects when ClickHouse is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.query.mockRejectedValue(new Error('connection refused'))
    try {
      await expect(startStageSweeper({ intervalMs: 3_600_000 })).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphan sweep failed: connection refused'))
    } finally {
      clearInterval(globalThis.__ulpStageSweeper)
      globalThis.__ulpStageSweeper = undefined
    }
  })
})

describe('sweepOrphanStages', () => {
  function fakeDb(names: string[], failOn: string[] = []): StageSweepDb & { dropped: string[]; ages: number[] } {
    const dropped: string[] = []
    const ages: number[] = []
    return {
      dropped,
      ages,
      list: async age => { ages.push(age); return names },
      drop: async name => {
        if (failOn.includes(name)) throw new Error(`cannot drop ${name}`)
        dropped.push(name)
      },
    }
  }

  it('drops every stage and known table that no running import owns', async () => {
    registerStage('aaaaaaaaaaaa')
    const db = fakeDb([
      'zz_import_stage_aaaaaaaaaaaa',
      'zz_import_known_aaaaaaaaaaaa',
      'zz_import_stage_bbbbbbbbbbbb',
      'zz_import_known_bbbbbbbbbbbb',
    ])
    const dropped = await sweepOrphanStages({ db, minAgeSeconds: 1800 })
    expect(dropped).toEqual(['zz_import_stage_bbbbbbbbbbbb', 'zz_import_known_bbbbbbbbbbbb'])
    expect(db.dropped).toEqual(dropped)
    expect(db.ages).toEqual([1800])
  })

  it('keeps going when one drop fails and does not report it as dropped', async () => {
    const db = fakeDb(['zz_import_stage_cccccccccccc', 'zz_import_known_cccccccccccc'], ['zz_import_stage_cccccccccccc'])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dropped = await sweepOrphanStages({ db })
    expect(dropped).toEqual(['zz_import_known_cccccccccccc'])
    expect(db.ages).toEqual([0])
  })

  it('ignores any name that is not one of ours', async () => {
    const db = fakeDb(['credentials', 'zz_import_stage_xyz', 'zz_import_stage_dddddddddddd'])
    expect(await sweepOrphanStages({ db })).toEqual(['zz_import_stage_dddddddddddd'])
  })
})
