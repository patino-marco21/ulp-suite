import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import { getClient } from '@/lib/clickhouse'
import {
  DEFAULT_INGEST_MIN_FREE_BYTES,
  getIngestDiskGate,
  ingestDiskGateConfig,
  resetIngestDiskGate,
  waitForDiskSpace,
} from '@/lib/ingest-disk-gate'

const GiB = 1024 ** 3
const headroom = (freeGiB: number) => ({ freeBytes: freeGiB * GiB, totalBytes: 936.8 * GiB, ratio: freeGiB / 936.8 })
const env = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv
const noSleep = async () => {}

beforeEach(() => {
  resetIngestDiskGate()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ingestDiskGateConfig', () => {
  it('defaults to enabled, a 50 GiB floor, a 55 GiB resume level and a 5 s poll', () => {
    expect(ingestDiskGateConfig({})).toEqual({ enabled: true, floorBytes: 50 * GiB, resumeBytes: 55 * GiB, pollMs: 5_000 })
    expect(DEFAULT_INGEST_MIN_FREE_BYTES).toBe(53_687_091_200)
  })

  it('honours INGEST_MIN_FREE_BYTES', () => {
    const c = ingestDiskGateConfig(env({ INGEST_MIN_FREE_BYTES: String(100 * GiB) }))
    expect(c.floorBytes).toBe(100 * GiB)
    expect(c.resumeBytes).toBe(110 * GiB)
  })

  it.each(['', '  ', 'abc', '-5', 'NaN'])('falls back to the default for INGEST_MIN_FREE_BYTES=%j', raw => {
    expect(ingestDiskGateConfig(env({ INGEST_MIN_FREE_BYTES: raw })).floorBytes).toBe(50 * GiB)
  })

  it.each(['off', 'OFF', '0', 'false', ' False '])('INGEST_DISK_GATE=%j switches the gate off', raw => {
    expect(ingestDiskGateConfig(env({ INGEST_DISK_GATE: raw })).enabled).toBe(false)
  })

  it.each(['', 'on', '1', 'true'])('INGEST_DISK_GATE=%j leaves it on', raw => {
    expect(ingestDiskGateConfig(env({ INGEST_DISK_GATE: raw })).enabled).toBe(true)
  })
})

describe('getIngestDiskGate', () => {
  it('reports the configured floor and resume level before any import has asked', () => {
    expect(getIngestDiskGate(env({ INGEST_MIN_FREE_BYTES: String(20 * GiB) }))).toEqual({
      paused: false, since: null, waiters: 0, freeBytes: null,
      floorBytes: 20 * GiB, resumeBytes: 22 * GiB, checkedAt: null,
    })
  })
})

describe('waitForDiskSpace', () => {
  it('proceeds at once when free space is above the floor', async () => {
    const check = vi.fn(async () => headroom(80))
    const sleep = vi.fn(noSleep)
    await waitForDiskSpace(new AbortController().signal, { check, sleep, env: env() })
    expect(check).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, freeBytes: 80 * GiB })
  })

  it('proceeds when free space is exactly the floor', async () => {
    const sleep = vi.fn(noSleep)
    await waitForDiskSpace(new AbortController().signal, { check: async () => headroom(50), sleep, env: env() })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('is a no-op when switched off: it does not even read the disk', async () => {
    const check = vi.fn(async () => headroom(1))
    await waitForDiskSpace(new AbortController().signal, { check, env: env({ INGEST_DISK_GATE: 'off' }) })
    expect(check).not.toHaveBeenCalled()
  })

  it('reads the disk through the ClickHouse client by default', async () => {
    const query = vi.fn(async () => ({ json: async () => [{ unreserved_space: 80 * GiB, total_space: 936.8 * GiB }] }))
    ;(getClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ query })
    await waitForDiskSpace(new AbortController().signal, { env: env() })
    expect(query).toHaveBeenCalledTimes(1)
    expect(getIngestDiskGate(env()).freeBytes).toBe(80 * GiB)
  })

  it('pauses under the floor and resumes only at the resume level, not at the floor', async () => {
    const reads = [40, 52, 56] // 52 is above the 50 GiB floor but below the 55 GiB resume level
    const check = vi.fn(async () => headroom(reads.shift() ?? 56))
    const seen: Array<{ paused: boolean; waiters: number }> = []
    const sleep = vi.fn(async () => {
      const g = getIngestDiskGate(env())
      seen.push({ paused: g.paused, waiters: g.waiters })
    })
    const onPoll = vi.fn()

    await waitForDiskSpace(new AbortController().signal, { check, sleep, onPoll, env: env() })

    expect(check).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal))
    expect(onPoll).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([{ paused: true, waiters: 1 }, { paused: true, waiters: 1 }])
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, since: null, freeBytes: 56 * GiB })
  })

  it('treats an unreadable disk as below the floor, says why, and recovers', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue(headroom(60))
    const seen: Array<{ paused: boolean; error?: string; freeBytes: number | null }> = []
    const sleep = vi.fn(async () => {
      const g = getIngestDiskGate(env())
      seen.push({ paused: g.paused, error: g.error, freeBytes: g.freeBytes })
    })

    await waitForDiskSpace(new AbortController().signal, { check, sleep, env: env() })

    expect(seen).toEqual([{ paused: true, error: 'connection refused', freeBytes: null }])
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, freeBytes: 60 * GiB })
    expect(getIngestDiskGate(env()).error).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
  })

  it('stops waiting when the import is aborted, and leaves no waiter behind', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const settled = waitForDiskSpace(controller.signal, { check: async () => headroom(10), env: env() }).then(
      () => 'resolved',
      e => `rejected:${(e as Error).name}`,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getIngestDiskGate(env())).toMatchObject({ paused: true, waiters: 1 })

    controller.abort()

    await expect(settled).resolves.toBe('rejected:AbortError')
    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, since: null })
  })

  it('does not wait at all for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const check = vi.fn(async () => headroom(80))
    await expect(waitForDiskSpace(controller.signal, { check, env: env() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(check).not.toHaveBeenCalled()
  })

  it('two imports waiting share one state and resume together', async () => {
    vi.useFakeTimers()
    let free = 10
    const check = vi.fn(async () => headroom(free))
    const controller = new AbortController()
    const a = waitForDiskSpace(controller.signal, { check, env: env() })
    const b = waitForDiskSpace(controller.signal, { check, env: env() })
    await vi.advanceTimersByTimeAsync(0)
    expect(getIngestDiskGate(env())).toMatchObject({ paused: true, waiters: 2 })

    free = 60
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([a, b])

    expect(getIngestDiskGate(env())).toMatchObject({ paused: false, waiters: 0, since: null })
  })

  it('a late arrival between the floor and the resume level waits too', async () => {
    vi.useFakeTimers()
    let free = 10
    const check = vi.fn(async () => headroom(free))
    const controller = new AbortController()
    const a = waitForDiskSpace(controller.signal, { check, env: env() })
    await vi.advanceTimersByTimeAsync(0)

    free = 52 // above the floor, below the resume level
    await vi.advanceTimersByTimeAsync(5_000)
    let bDone = false
    const b = waitForDiskSpace(controller.signal, { check, env: env() }).then(() => { bDone = true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(bDone).toBe(false)
    expect(getIngestDiskGate(env()).waiters).toBe(2)

    free = 56
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([a, b])
    expect(bDone).toBe(true)
  })

  it('reuses a fast-path reading younger than five seconds', async () => {
    let t = 0
    const now = () => t
    const check = vi.fn(async () => headroom(80))
    const signal = new AbortController().signal

    await waitForDiskSpace(signal, { check, now, env: env() })
    t = 4_999
    await waitForDiskSpace(signal, { check, now, env: env() })
    expect(check).toHaveBeenCalledTimes(1)

    t = 5_000
    await waitForDiskSpace(signal, { check, now, env: env() })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('logs one pause line, one reminder per ten minutes, and one resume line', async () => {
    let t = 1_000_000
    const now = () => t
    const reads = [10, 10, 10, 10, 60]
    const check = vi.fn(async () => headroom(reads.shift() ?? 60))
    const sleep = vi.fn(async () => { t += 5 * 60_000 }) // each poll is five minutes later

    await waitForDiskSpace(new AbortController().signal, { check, sleep, now, env: env() })

    const lines = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('pausing imports')
    expect(lines[1]).toContain('still paused')
    expect(lines[2]).toContain('resuming imports')
  })
})
