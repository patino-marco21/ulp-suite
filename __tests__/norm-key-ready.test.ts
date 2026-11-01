import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import {
  buildNormKeyReadySql,
  isNormKeyReady,
  keyColumnOf,
  normKeyReadyFrom,
  resetNormKeyReadyCache,
  resolveMatchKey,
} from '@/lib/norm-key-ready'

const READY = { defined: '1', parts: '16', with_column: '16' }
const MISSING_ONE = { defined: '1', parts: '16', with_column: '15' }
const warnings = () => vi.mocked(console.warn).mock.calls.map(c => c.map(String).join(' '))

let clock = 0
const now = () => clock

beforeEach(() => {
  resetNormKeyReadyCache()
  clock = 1_000_000
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('keyColumnOf', () => {
  it('maps the two rules to their columns', () => {
    expect(keyColumnOf('norm')).toBe('norm_key_hash')
    expect(keyColumnOf('exact')).toBe('content_key_hash')
  })
})

describe('buildNormKeyReadySql', () => {
  it('is metadata only: it reads the catalogue and never ulp.credentials itself', () => {
    const sql = buildNormKeyReadySql()
    expect(sql).toContain('system.columns')
    expect(sql).toContain('system.parts ')
    expect(sql).toContain('system.parts_columns')
    expect(sql).toContain("column = 'norm_key_hash'")
    expect(sql).toContain('active')
    expect(sql).not.toMatch(/FROM ulp\./)
  })
})

describe('normKeyReadyFrom', () => {
  it.each([
    [{ defined: '1', parts: '16', with_column: '16' }, true],
    [{ defined: 1, parts: 3, with_column: 3 }, true],
    [{ defined: '1', parts: '0', with_column: '0' }, true], // an empty table is complete
    [{ defined: '1', parts: '16', with_column: '15' }, false], // a part that lacks the column
    [{ defined: '0', parts: '0', with_column: '0' }, false], // no column at all
    [{ defined: '1', parts: '3', with_column: '4' }, false], // an answer that cannot be right
    [{ defined: '1', parts: 'x', with_column: 'x' }, false],
    [{}, false],
    [undefined, false],
  ])('%j is %s', (row, want) => {
    expect(normKeyReadyFrom(row as Record<string, unknown> | undefined)).toBe(want)
  })
})

describe('isNormKeyReady', () => {
  it('asks the catalogue once and remembers a ready answer for 60 s', async () => {
    const run = vi.fn().mockResolvedValue([READY])
    expect(await isNormKeyReady(run, now)).toBe(true)
    clock += 59_000
    expect(await isNormKeyReady(run, now)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 2_000
    expect(await isNormKeyReady(run, now)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('remembers a not-ready answer for 5 s only, so a finished backfill is noticed quickly', async () => {
    const run = vi.fn().mockResolvedValueOnce([MISSING_ONE]).mockResolvedValue([READY])
    expect(await isNormKeyReady(run, now)).toBe(false)
    clock += 4_000
    expect(await isNormKeyReady(run, now)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 2_000
    expect(await isNormKeyReady(run, now)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('fails closed: an error is "not ready", is logged, and is asked again after 5 s', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue([READY])
    expect(await isNormKeyReady(run, now)).toBe(false)
    expect(warnings().some(w => w.includes('connection refused'))).toBe(true)
    clock += 6_000
    expect(await isNormKeyReady(run, now)).toBe(true)
  })

  it('lets concurrent callers share one query', async () => {
    let release!: (rows: Array<Record<string, unknown>>) => void
    const run = vi.fn(() => new Promise<Array<Record<string, unknown>>>(resolve => { release = resolve }))
    const a = isNormKeyReady(run, now)
    const b = isNormKeyReady(run, now)
    release([READY])
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('resolveMatchKey', () => {
  it('is exact, without asking anything, when the setting is off', async () => {
    const run = vi.fn()
    expect(await resolveMatchKey({ env: { INGEST_NORM_KEY: 'off' }, run, now })).toBe('exact')
    expect(run).not.toHaveBeenCalled()
  })

  it('is norm when the setting is on and the column is complete', async () => {
    const run = vi.fn().mockResolvedValue([READY])
    expect(await resolveMatchKey({ env: {}, run, now })).toBe('norm')
  })

  it('is exact when the column is not complete in every part', async () => {
    const run = vi.fn().mockResolvedValue([MISSING_ONE])
    expect(await resolveMatchKey({ env: {}, run, now })).toBe('exact')
  })

  it('says which key is in use when it changes, not on every import', async () => {
    const run = vi.fn().mockResolvedValue([READY])
    await resolveMatchKey({ env: {}, run, now })
    await resolveMatchKey({ env: {}, run, now })
    expect(warnings().filter(w => /normalised key/.test(w))).toHaveLength(1)
    clock += 120_000
    run.mockResolvedValue([MISSING_ONE])
    await resolveMatchKey({ env: {}, run, now })
    await resolveMatchKey({ env: {}, run, now })
    expect(warnings().filter(w => /exact key/.test(w))).toHaveLength(1)
  })
})
