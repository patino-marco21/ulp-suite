import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import { DEFAULT_STATS_MIN_FREE_BYTES, dedupStatsMinFreeBytes, dedupStatsHeadroomRefusal } from '@/lib/content-dedup'

const GiB = 1024 ** 3

describe('dedupStatsMinFreeBytes', () => {
  test('defaults to 40 GiB', () => {
    expect(DEFAULT_STATS_MIN_FREE_BYTES).toBe(40 * GiB)
    expect(dedupStatsMinFreeBytes({} as NodeJS.ProcessEnv)).toBe(40 * GiB)
  })

  test('DEDUP_STATS_MIN_FREE_BYTES overrides it, zero included', () => {
    expect(dedupStatsMinFreeBytes({ DEDUP_STATS_MIN_FREE_BYTES: String(10 * GiB) } as unknown as NodeJS.ProcessEnv)).toBe(10 * GiB)
    expect(dedupStatsMinFreeBytes({ DEDUP_STATS_MIN_FREE_BYTES: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0)
  })

  test.each(['', 'abc', '-5', 'NaN'])('%j is ignored', raw => {
    expect(dedupStatsMinFreeBytes({ DEDUP_STATS_MIN_FREE_BYTES: raw } as unknown as NodeJS.ProcessEnv)).toBe(40 * GiB)
  })
})

describe('dedupStatsHeadroomRefusal', () => {
  const env = {} as NodeJS.ProcessEnv

  test('less free space than needed: a reason that names both sizes', async () => {
    const why = await dedupStatsHeadroomRefusal(env, async () => ({ freeBytes: 21 * GiB }))
    expect(why).toContain('free < ')
    expect(why).toContain('needed')
    expect(why).toMatch(/21(\.0+)? GiB/)
    expect(why).toMatch(/40(\.0+)? GiB/)
  })

  test('enough free space, or exactly the amount: no reason', async () => {
    expect(await dedupStatsHeadroomRefusal(env, async () => ({ freeBytes: 162 * GiB }))).toBeNull()
    expect(await dedupStatsHeadroomRefusal(env, async () => ({ freeBytes: 40 * GiB }))).toBeNull()
  })

  test('a free-space check that fails also refuses', async () => {
    const why = await dedupStatsHeadroomRefusal(env, async () => { throw new Error('system.disks unreachable') })
    expect(why).toBe('the free-space check failed (system.disks unreachable)')
  })

  test('the threshold follows the environment', async () => {
    const small = { DEDUP_STATS_MIN_FREE_BYTES: String(5 * GiB) } as unknown as NodeJS.ProcessEnv
    expect(await dedupStatsHeadroomRefusal(small, async () => ({ freeBytes: 21 * GiB }))).toBeNull()
    expect(await dedupStatsHeadroomRefusal(small, async () => ({ freeBytes: 3 * GiB }))).not.toBeNull()
  })
})

describe('runContentDedupTick — the guard comes before the stats pass', () => {
  const src = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
  const tick = src.slice(src.indexOf('export async function runContentDedupTick'))

  test('it asks first, logs the skip and reports it', () => {
    const ask = tick.indexOf('dedupStatsHeadroomRefusal()')
    const stats = tick.indexOf('queryContentKeyStats(client, buildContentKeyStatsSql())')
    expect(ask).toBeGreaterThan(-1)
    expect(stats).toBeGreaterThan(ask)
    expect(tick).toContain('skipped the stats pass')
    expect(tick.slice(ask, stats)).toContain('skipped: true')
  })
})
