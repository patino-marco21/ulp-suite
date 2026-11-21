import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(async () => []), getClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { GET as statusRoute } from '@/app/api/lookup/directory/status/route'
import {
  answerDirectoryStatus, resetCronState, runSiteDirectoryTick, siteDirectoryCronMinutes, siteDirectorySettleSeconds, startSiteDirectoryCron, type TickDeps,
} from '@/lib/site-directory-cron'
import { refreshState } from '@/lib/site-directory-state'
import type { LiveState } from '@/lib/search-dictionary'
import type { SiteCount } from '@/lib/site-counts-input'

const live = (over: Partial<LiveState> = {}): LiveState => ({ fingerprint: 'fp-a', mutationsRunning: 0, buildsRunning: 0, ...over })
const counted = (host: string): SiteCount => ({ host, found: true, count: 5, host_count: 5, subdomain_count: 0, subdomains: 0, top_subdomains: [] })

type Mocked = { [K in keyof TickDeps]: TickDeps[K] & ReturnType<typeof vi.fn> }

function deps(over: Partial<TickDeps> = {}): Mocked {
  const batches = [['a.example', 'b.example']]
  return {
    seed: vi.fn(() => 0),
    live: vi.fn(async () => live()),
    importing: vi.fn(() => false),
    sleep: vi.fn(async (_ms: number) => {}),
    now: vi.fn(() => 1_000_000),
    stale: vi.fn(() => 2),
    outOfDate: vi.fn(() => batches.shift() ?? []),
    count: vi.fn(async (hosts: string[]) => ({ results: Object.fromEntries(hosts.map(h => [h, counted(h)])), subdomains_counted: true })),
    store: vi.fn(),
    breakdownTargets: vi.fn(() => []),
    breakdown: vi.fn(async () => {}),
    touchBreakdown: vi.fn(),
    ...over,
  } as unknown as Mocked
}

beforeEach(() => {
  resetCronState()
  refreshState.running = false
  refreshState.lastRefreshedAt = null
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('the settings', () => {
  test('defaults: a tick every 10 minutes, 120 seconds of quiet', () => {
    expect(siteDirectoryCronMinutes({})).toBe(10)
    expect(siteDirectorySettleSeconds({})).toBe(120)
  })
  test('read from the environment; an empty or bad value is the default, 0 is allowed', () => {
    expect(siteDirectoryCronMinutes({ SITE_DIRECTORY_CRON_MINUTES: '0' })).toBe(0)
    expect(siteDirectoryCronMinutes({ SITE_DIRECTORY_CRON_MINUTES: '' })).toBe(10)
    expect(siteDirectorySettleSeconds({ SITE_DIRECTORY_SETTLE_SECONDS: '5' })).toBe(5)
    expect(siteDirectorySettleSeconds({ SITE_DIRECTORY_SETTLE_SECONDS: 'soon' })).toBe(120)
  })
})

describe('runSiteDirectoryTick', () => {
  test('switched off: nothing is read', async () => {
    vi.stubEnv('SITE_DIRECTORY_CRON_MINUTES', '0')
    const d = deps()
    expect(await runSiteDirectoryTick(d)).toBe('disabled')
    expect(d.live).not.toHaveBeenCalled()
  })

  test('the table cannot be read: nothing is done', async () => {
    const d = deps({ live: vi.fn(async () => null) })
    expect(await runSiteDirectoryTick(d)).toBe('unknown')
    expect(d.count).not.toHaveBeenCalled()
  })

  test('nothing out of date: one read and done, no waiting', async () => {
    const d = deps({ stale: vi.fn(() => 0) })
    expect(await runSiteDirectoryTick(d)).toBe('fresh')
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.count).not.toHaveBeenCalled()
  })

  test('seeds the marked sites before it looks', async () => {
    const d = deps({ stale: vi.fn(() => 0) })
    await runSiteDirectoryTick(d)
    expect(d.seed).toHaveBeenCalledTimes(1)
  })

  test('an import queued or running: it waits for the next tick without sleeping', async () => {
    const d = deps({ importing: vi.fn(() => true) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.count).not.toHaveBeenCalled()
  })

  test('a content mutation running: waits', async () => {
    const d = deps({ live: vi.fn(async () => live({ mutationsRunning: 1 })) })
    expect(await runSiteDirectoryTick(d)).toBe('mutating')
    expect(d.count).not.toHaveBeenCalled()
  })

  test('the fingerprint moved while it waited (a big file commits minutes apart): it does not count against a table in motion', async () => {
    const reads = [live(), live({ fingerprint: 'fp-b' })]
    const d = deps({ live: vi.fn(async () => reads.shift() ?? null) })
    expect(await runSiteDirectoryTick(d)).toBe('settling')
    expect(d.sleep).toHaveBeenCalledWith(120_000)
    expect(d.count).not.toHaveBeenCalled()
  })

  test('an import claimed while it waited stops it', async () => {
    const importing = [false, true]
    const d = deps({ importing: vi.fn(() => importing.shift() ?? true) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.count).not.toHaveBeenCalled()
  })

  test('the settle time is configurable', async () => {
    vi.stubEnv('SITE_DIRECTORY_SETTLE_SECONDS', '5')
    const d = deps()
    await runSiteDirectoryTick(d)
    expect(d.sleep).toHaveBeenCalledWith(5_000)
  })

  test('quiet and out of date: recounts the out-of-date sites, 100 at a time, and stores them against the fingerprint read after the wait', async () => {
    const reads = [live(), live()]
    const d = deps({ live: vi.fn(async () => reads.shift() ?? null) })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.outOfDate).toHaveBeenCalledWith('fp-a', 100)
    expect(d.count).toHaveBeenCalledWith(['a.example', 'b.example'])
    expect(d.store).toHaveBeenCalledWith({ 'a.example': counted('a.example'), 'b.example': counted('b.example') }, 'fp-a')
    expect(refreshState.lastRefreshedAt).toEqual(expect.any(String))
    expect(refreshState.running).toBe(false)
  })

  test('carries on in batches until nothing is out of date', async () => {
    const batches = [['a.example'], ['b.example'], []]
    const d = deps({ outOfDate: vi.fn(() => batches.shift() ?? []) })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.count).toHaveBeenCalledTimes(2)
  })

  test('an import that starts in the middle stops it at once and leaves the rest for the next tick', async () => {
    const importing = [false, false, false, true]
    const batches = [['a.example'], ['b.example']]
    const d = deps({ importing: vi.fn(() => importing.shift() ?? true), outOfDate: vi.fn(() => batches.shift() ?? []) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.count).toHaveBeenCalledTimes(1)
    expect(refreshState.running).toBe(false)
  })

  test('the same sites again and again (nothing could be stored for them) end the loop instead of spinning', async () => {
    const d = deps({ outOfDate: vi.fn(() => ['a.example']) })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.count).toHaveBeenCalledTimes(1)
  })

  test('only the hosts are counted right now (the index is being rebuilt): nothing is stored and the tick says so', async () => {
    const d = deps({ count: vi.fn(async (hosts: string[]) => ({ results: Object.fromEntries(hosts.map(h => [h, counted(h)])), subdomains_counted: false })) })
    expect(await runSiteDirectoryTick(d)).toBe('no-projection')
    expect(d.store).not.toHaveBeenCalled()
  })

  test('a split that exists is worked out again for the out-of-date sites; failures are kept from retrying until the table changes', async () => {
    const targets = ['a.example', 'b.example']
    const d = deps({
      breakdownTargets: vi.fn(() => targets),
      breakdown: vi.fn(async (host: string) => { if (host === 'b.example') throw new Error('too broad') }),
    })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.breakdown).toHaveBeenCalledWith('a.example', 'fp-a')
    expect(d.breakdown).toHaveBeenCalledWith('b.example', 'fp-a')
    expect(d.touchBreakdown).toHaveBeenCalledTimes(1)
    expect(d.touchBreakdown).toHaveBeenCalledWith('b.example', 'fp-a')
  })

  test('an import that starts during the splits stops them', async () => {
    // pre-wait, post-wait, the one batch, the empty batch that ends the loop; the fifth look (before the first split) sees the import
    const importing = [false, false, false, false, true]
    const d = deps({ importing: vi.fn(() => importing.shift() ?? true), breakdownTargets: vi.fn(() => ['a.example', 'b.example']) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.breakdown).not.toHaveBeenCalled()
  })

  test('a failure is logged and counted; three in a row wait an hour', async () => {
    const boom = deps({ count: vi.fn(async () => { throw new Error('connection refused') }) })
    expect(await runSiteDirectoryTick(boom)).toBe('failed')
    expect(console.error).toHaveBeenCalled()
    expect(refreshState.running).toBe(false)
    await runSiteDirectoryTick(deps({ count: boom.count, outOfDate: vi.fn(() => ['a.example']) }))
    await runSiteDirectoryTick(deps({ count: boom.count, outOfDate: vi.fn(() => ['a.example']) }))
    const later = deps({ now: vi.fn(() => 1_000_000 + 60_000) })
    expect(await runSiteDirectoryTick(later)).toBe('backoff')
    expect(later.count).not.toHaveBeenCalled()
    const muchLater = deps({ now: vi.fn(() => 1_000_000 + 3_600_001) })
    expect(await runSiteDirectoryTick(muchLater)).toBe('refreshed')
  })
})

describe('startSiteDirectoryCron', () => {
  test('does not start when switched off', () => {
    vi.stubEnv('SITE_DIRECTORY_CRON_MINUTES', '0')
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setInterval')
    startSiteDirectoryCron()
    expect(spy).not.toHaveBeenCalled()
  })
  test('starts once: a first tick soon, then one every interval', () => {
    vi.stubEnv('SITE_DIRECTORY_CRON_MINUTES', '10')
    vi.useFakeTimers()
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const interval = vi.spyOn(globalThis, 'setInterval')
    startSiteDirectoryCron()
    startSiteDirectoryCron()
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 120_000)
    expect(interval).toHaveBeenCalledTimes(1)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 600_000)
  })
})

describe('answerDirectoryStatus and its route', () => {
  const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }
  const status = (over: Parameters<typeof answerDirectoryStatus>[0] = {}) =>
    answerDirectoryStatus({ live: async () => live(), stale: () => 0, total: () => 12, ...over })

  test('current: nothing is out of date', async () => {
    expect(await status()).toEqual({ status: 200, json: { success: true, total: 12, out_of_date: 0, state: 'current', refreshed_at: null } })
  })
  test('waiting: something is out of date and nothing is running', async () => {
    expect((await status({ stale: () => 4 })).json).toMatchObject({ out_of_date: 4, state: 'waiting' })
  })
  test('refreshing: the tick is running, and the time of the last finished refresh is told', async () => {
    refreshState.running = true
    refreshState.lastRefreshedAt = '2026-11-21T10:00:00.000Z'
    expect((await status({ stale: () => 4 })).json).toMatchObject({ out_of_date: 4, state: 'refreshing', refreshed_at: '2026-11-21T10:00:00.000Z' })
  })
  test('the table cannot be read: it still answers, with nothing counted as out of date', async () => {
    expect((await status({ live: async () => null })).json).toMatchObject({ out_of_date: 0, state: 'current' })
  })
  test('the route needs a session', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await statusRoute(new NextRequest('http://localhost/api/lookup/directory/status'))
    expect(res.status).toBe(401)
    vi.mocked(validateRequest).mockResolvedValue(analyst)
    const ok = await statusRoute(new NextRequest('http://localhost/api/lookup/directory/status'))
    expect(ok.status).toBe(200)
    expect((await ok.json()).success).toBe(true)
  })
})
