import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(async () => []), getClient: vi.fn() }))

import { runSearchDictionaryTick, startSearchDictionaryCron, resetCronState } from '@/lib/search-dictionary-cron'
import { DictionaryHeadroomError, readBuildRecord, recordBuildOutcome, type DictionaryStatus, type LiveState } from '@/lib/search-dictionary'
import { executeQuery } from '@/lib/clickhouse'

const status = (state: DictionaryStatus['state']): DictionaryStatus => ({
  state, fingerprint: null, builtAt: null, pairRows: null, emailRows: null, bytes: null, lastError: null, lastBuildMs: null,
})
const live = (over: Partial<LiveState> = {}): LiveState => ({ fingerprint: 'fp-a', mutationsRunning: 0, buildsRunning: 0, ...over })
const BUILT = { pairRows: 85, emailRows: 13, ms: 1000, fingerprint: 'fp-a' }

function deps(over: Record<string, unknown> = {}) {
  return {
    status: vi.fn(async () => status('stale')),
    live: vi.fn(async () => live()),
    build: vi.fn(async () => BUILT),
    sleep: vi.fn(async (_ms: number) => {}),
    now: vi.fn(() => 1_000_000),
    ...over,
  } as Parameters<typeof runSearchDictionaryTick>[0] & { build: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn>; live: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  resetCronState()
  vi.mocked(executeQuery).mockClear()
  recordBuildOutcome({ lastError: null, lastBuildMs: null, lastBuiltAt: null })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('runSearchDictionaryTick', () => {
  test('switched off: nothing is read', async () => {
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    const d = deps()
    expect(await runSearchDictionaryTick(d)).toBe('disabled')
    expect(d.status).not.toHaveBeenCalled()
  })

  test.each([['fresh', 'fresh'], ['unknown', 'unknown'], ['building', 'building'], ['disabled', 'disabled']] as const)('%s: nothing to do', async (state, outcome) => {
    const d = deps({ status: vi.fn(async () => status(state)) })
    expect(await runSearchDictionaryTick(d)).toBe(outcome)
    expect(d.build).not.toHaveBeenCalled()
    expect(d.sleep).not.toHaveBeenCalled()
  })

  test.each(['stale', 'missing'] as const)('%s and quiet: waits the settle time, reads the fingerprint again, then builds', async state => {
    const d = deps({ status: vi.fn(async () => status(state)) })
    expect(await runSearchDictionaryTick(d)).toBe('built')
    expect(d.sleep).toHaveBeenCalledWith(120_000)
    expect(d.live).toHaveBeenCalledTimes(2)
    expect(d.build).toHaveBeenCalledTimes(1)
  })

  test('the settle time is configurable', async () => {
    vi.stubEnv('SEARCH_DICT_SETTLE_SECONDS', '5')
    const d = deps()
    await runSearchDictionaryTick(d)
    expect(d.sleep).toHaveBeenCalledWith(5_000)
  })

  test('the fingerprint changed while it waited (an import is running): no build this time', async () => {
    const d = deps({ live: vi.fn().mockResolvedValueOnce(live({ fingerprint: 'fp-a' })).mockResolvedValueOnce(live({ fingerprint: 'fp-b' })) })
    expect(await runSearchDictionaryTick(d)).toBe('settling')
    expect(d.build).not.toHaveBeenCalled()
  })

  test('a content mutation running, before or after the wait: no build', async () => {
    const before = deps({ live: vi.fn(async () => live({ mutationsRunning: 1 })) })
    expect(await runSearchDictionaryTick(before)).toBe('mutating')
    expect(before.sleep).not.toHaveBeenCalled()
    const after = deps({ live: vi.fn().mockResolvedValueOnce(live()).mockResolvedValueOnce(live({ mutationsRunning: 1 })) })
    expect(await runSearchDictionaryTick(after)).toBe('mutating')
    expect(after.build).not.toHaveBeenCalled()
  })

  test('a build already running elsewhere (the script, another process): no second one', async () => {
    const d = deps({ live: vi.fn().mockResolvedValueOnce(live()).mockResolvedValueOnce(live({ buildsRunning: 1 })) })
    expect(await runSearchDictionaryTick(d)).toBe('building')
    expect(d.build).not.toHaveBeenCalled()
  })

  test('the live state unreadable: unknown, no build', async () => {
    const d = deps({ live: vi.fn(async () => null) })
    expect(await runSearchDictionaryTick(d)).toBe('unknown')
    expect(d.build).not.toHaveBeenCalled()
  })

  test('no room for the second copy is not a failure: the tick is skipped, and it keeps trying every tick', async () => {
    const d = deps({ build: vi.fn(async () => { throw new DictionaryHeadroomError('143 GiB free') }) })
    for (let i = 0; i < 5; i++) expect(await runSearchDictionaryTick(d)).toBe('no-headroom')
    expect(d.build).toHaveBeenCalledTimes(5)
    expect(readBuildRecord().lastError).toBeNull()
  })

  test('failures are recorded; three in a row wait an hour; after the hour it tries again; a success clears the count', async () => {
    let t = 1_000_000
    const build = vi.fn(async () => { throw new Error('MEMORY_LIMIT_EXCEEDED') })
    const d = deps({ build, now: vi.fn(() => t) })
    for (let i = 0; i < 3; i++) expect(await runSearchDictionaryTick(d)).toBe('failed')
    expect(readBuildRecord().lastError).toContain('MEMORY_LIMIT_EXCEEDED')
    expect(await runSearchDictionaryTick(d)).toBe('backoff')
    expect(build).toHaveBeenCalledTimes(3)
    t += 3_599_000
    expect(await runSearchDictionaryTick(d)).toBe('backoff')
    t += 2_000
    expect(await runSearchDictionaryTick(d)).toBe('failed') // tried again
    expect(build).toHaveBeenCalledTimes(4)

    build.mockResolvedValueOnce(BUILT)
    t += 3_700_000
    expect(await runSearchDictionaryTick(d)).toBe('built')
    build.mockRejectedValue(new Error('again'))
    for (let i = 0; i < 3; i++) expect(await runSearchDictionaryTick(d)).toBe('failed') // the count started over
    expect(await runSearchDictionaryTick(d)).toBe('backoff')
  })
})

describe('startSearchDictionaryCron', () => {
  test('SEARCH_DICT_CRON_MINUTES=0 schedules nothing', () => {
    vi.useFakeTimers()
    vi.stubEnv('SEARCH_DICT_CRON_MINUTES', '0')
    startSearchDictionaryCron()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('switched off schedules nothing', () => {
    vi.useFakeTimers()
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    startSearchDictionaryCron()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('schedules a first tick and an interval once, however often it is started', () => {
    vi.useFakeTimers()
    startSearchDictionaryCron()
    startSearchDictionaryCron()
    expect(vi.getTimerCount()).toBe(2)
  })

  test('the first tick comes after two minutes (or the interval if that is shorter) and reads the status', async () => {
    vi.useFakeTimers()
    vi.stubEnv('SEARCH_DICT_CRON_MINUTES', '1')
    startSearchDictionaryCron()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(vi.mocked(executeQuery)).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(executeQuery)).toHaveBeenCalled() // the status check of the first tick
  })
})
