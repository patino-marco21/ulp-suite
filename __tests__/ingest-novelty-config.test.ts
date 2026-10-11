import { describe, it, expect } from 'vitest'
import {
  COMMIT_MAX_EXECUTION_S,
  DEFAULT_NOVELTY_SLAB_ROWS,
  MIN_NOVELTY_SLAB_ROWS,
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
