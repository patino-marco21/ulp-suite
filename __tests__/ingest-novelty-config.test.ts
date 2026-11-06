import { describe, it, expect } from 'vitest'
import {
  COMMIT_EXTERNAL_SORT_BYTES,
  COMMIT_MAX_EXECUTION_S,
  DEFAULT_CHECK_GROUP_SLABS,
  DEFAULT_COMMIT_BLOCK_ROWS,
  DEFAULT_COMMIT_INSERT_THREADS,
  DEFAULT_NOVELTY_SLAB_ROWS,
  MIN_NOVELTY_SLAB_ROWS,
  NORM_KEY_MAX_SLAB_ROWS,
  checkGroupSlabs,
  commitBlockRows,
  commitInsertThreads,
  normKeyEnabled,
  noveltyConfig,
  slabCount,
} from '@/lib/ingest-novelty-config'

const env = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv

describe('noveltyConfig', () => {
  it('is on with a 20,000,000-row slab by default', () => {
    expect(noveltyConfig(env())).toEqual({ enabled: true, slabRows: 20_000_000 })
    expect(DEFAULT_NOVELTY_SLAB_ROWS).toBe(20_000_000)
    expect(MIN_NOVELTY_SLAB_ROWS).toBe(1_000)
    expect(COMMIT_MAX_EXECUTION_S).toBe(3300)
  })

  it.each(['off', 'OFF', '0', 'false', ' False '])('INGEST_NOVELTY_CHECK=%j switches it off', raw => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_CHECK: raw })).enabled).toBe(false)
  })

  it.each(['', 'on', '1', 'true', 'yes'])('INGEST_NOVELTY_CHECK=%j leaves it on', raw => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_CHECK: raw })).enabled).toBe(true)
  })

  it('honours INGEST_NOVELTY_SLAB_ROWS and rounds it down to an integer', () => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: '5000000' })).slabRows).toBe(5_000_000)
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: '2500.9' })).slabRows).toBe(2500)
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: '1000' })).slabRows).toBe(1000)
  })

  it.each(['', '  ', 'abc', '-5', '999', '0', 'NaN'])('falls back to the default slab for INGEST_NOVELTY_SLAB_ROWS=%j', raw => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: raw })).slabRows).toBe(20_000_000)
  })
})

describe('slabCount', () => {
  it('is always at least one slab', () => {
    expect(slabCount(0, 20_000_000)).toBe(1)
    expect(slabCount(1, 20_000_000)).toBe(1)
    expect(slabCount(Number.NaN, 20_000_000)).toBe(1)
  })

  it('rounds up', () => {
    expect(slabCount(20_000_000, 20_000_000)).toBe(1)
    expect(slabCount(20_000_001, 20_000_000)).toBe(2)
    expect(slabCount(2_500, 1_000)).toBe(3)
    expect(slabCount(300_000_000, 20_000_000)).toBe(15)
  })
})

describe('commitInsertThreads', () => {
  it('is 4 by default', () => {
    expect(DEFAULT_COMMIT_INSERT_THREADS).toBe(4)
    expect(commitInsertThreads(env())).toBe(4)
  })

  it.each([['1', 1], ['8', 8], ['16', 16], [' 3 ', 3], ['2.9', 2]])('INGEST_COMMIT_INSERT_THREADS=%j gives %i', (raw, want) => {
    expect(commitInsertThreads(env({ INGEST_COMMIT_INSERT_THREADS: raw }))).toBe(want)
  })

  it.each(['', '  ', 'abc', '0', '-1', '0.5', '17', '100', 'NaN'])('falls back to 4 for INGEST_COMMIT_INSERT_THREADS=%j (the range is 1 to 16)', raw => {
    expect(commitInsertThreads(env({ INGEST_COMMIT_INSERT_THREADS: raw }))).toBe(4)
  })
})

describe('normKeyEnabled', () => {
  it('is on by default', () => {
    expect(normKeyEnabled(env())).toBe(true)
  })

  it.each(['off', 'OFF', '0', 'false', ' False '])('INGEST_NORM_KEY=%j switches it off', raw => {
    expect(normKeyEnabled(env({ INGEST_NORM_KEY: raw }))).toBe(false)
  })

  it.each(['', 'on', '1', 'true', 'yes'])('INGEST_NORM_KEY=%j leaves it on', raw => {
    expect(normKeyEnabled(env({ INGEST_NORM_KEY: raw }))).toBe(true)
  })

  it('bounds the memory of the commit sort at 1 GiB before it spills to disk', () => {
    expect(COMMIT_EXTERNAL_SORT_BYTES).toBe(1_073_741_824)
  })

  it('cuts a slab on the normalised key at 10,000,000 rows (7.1 GiB measured; 10.6 GiB at 20,000,000 is more than the exact-key statement it replaces)', () => {
    expect(NORM_KEY_MAX_SLAB_ROWS).toBe(10_000_000)
    expect(NORM_KEY_MAX_SLAB_ROWS).toBeLessThan(DEFAULT_NOVELTY_SLAB_ROWS)
  })
})

describe('commitBlockRows', () => {
  it('is 131,072 by default (measured: a slab of new rows is about two default blocks, so one thread did the work)', () => {
    expect(DEFAULT_COMMIT_BLOCK_ROWS).toBe(131_072)
    expect(commitBlockRows(env())).toBe(131_072)
  })

  it.each([['8192', 8_192], ['65536', 65_536], ['262144', 262_144], ['1048576', 1_048_576], [' 100000 ', 100_000], ['99999.9', 99_999]])('INGEST_COMMIT_BLOCK_ROWS=%j gives %i', (raw, want) => {
    expect(commitBlockRows(env({ INGEST_COMMIT_BLOCK_ROWS: raw }))).toBe(want)
  })

  it.each(['', '  ', 'abc', '0', '-1', '8191', '1048577', '5000000', 'NaN'])('falls back to 131,072 for INGEST_COMMIT_BLOCK_ROWS=%j (the range is 8,192 to 1,048,576)', raw => {
    expect(commitBlockRows(env({ INGEST_COMMIT_BLOCK_ROWS: raw }))).toBe(131_072)
  })
})

describe('checkGroupSlabs', () => {
  it('is 4 by default (a scan probing 40M keys took 24.2 s against 21.4 s for 10M: one scan serves four slabs)', () => {
    expect(DEFAULT_CHECK_GROUP_SLABS).toBe(4)
    expect(checkGroupSlabs(env())).toBe(4)
  })

  it.each([['1', 1], ['2', 2], ['16', 16], [' 3 ', 3], ['2.9', 2]])('INGEST_NOVELTY_CHECK_GROUP=%j gives %i', (raw, want) => {
    expect(checkGroupSlabs(env({ INGEST_NOVELTY_CHECK_GROUP: raw }))).toBe(want)
  })

  it.each(['', '  ', 'abc', '0', '-1', '0.5', '17', '100', 'NaN'])('falls back to 4 for INGEST_NOVELTY_CHECK_GROUP=%j (the range is 1 to 16)', raw => {
    expect(checkGroupSlabs(env({ INGEST_NOVELTY_CHECK_GROUP: raw }))).toBe(4)
  })
})
