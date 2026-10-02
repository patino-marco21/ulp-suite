import { afterEach, describe, expect, it, vi } from 'vitest'
import pLimit from 'p-limit'
import { ImportStalledError, parseStallMs, runImportJob } from '@/lib/import-runner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('parseStallMs', () => {
  it('defaults to 20 minutes for an unset, empty or invalid value', () => {
    for (const raw of [undefined, '', '   ', 'abc', '0', '-5']) {
      expect(parseStallMs(raw)).toBe(1_200_000)
    }
  })

  it('accepts a positive number of milliseconds', () => {
    expect(parseStallMs('30000')).toBe(30_000)
  })
})

describe('runImportJob', () => {
  it('returns the work result and hands the work a live signal and a beat', async () => {
    let received: { aborted: boolean; beatIsFunction: boolean } | undefined
    const result = await runImportJob({
      label: 'a.txt',
      work: async ctx => {
        received = { aborted: ctx.signal.aborted, beatIsFunction: typeof ctx.beat === 'function' }
        return 42
      },
    })

    expect(result).toBe(42)
    expect(received).toEqual({ aborted: false, beatIsFunction: true })
  })

  it('propagates the work error unchanged', async () => {
    const boom = new Error('boom')
    await expect(runImportJob({ label: 'a.txt', work: async () => { throw boom } })).rejects.toBe(boom)
  })

  it('fails with ImportStalledError, and aborts the signal, when no beat arrives within stallMs', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 0
    let seen!: AbortSignal

    const promise = runImportJob({
      label: 'wedged.txt',
      stallMs: 1_000,
      now: () => clock,
      work: ({ signal }) => {
        seen = signal
        return new Promise<never>(() => { /* never settles */ })
      },
    })
    const rejection = expect(promise).rejects.toBeInstanceOf(ImportStalledError)

    clock = 1_500
    await vi.advanceTimersByTimeAsync(1_500)

    await rejection
    expect(seen.aborted).toBe(true)
    await expect(promise).rejects.toThrow(/wedged\.txt.*stalled/)
  })

  it('a beat restarts the stall window', async () => {
    vi.useFakeTimers()
    let clock = 0
    let beat!: () => void
    let finish!: (value: string) => void

    const promise = runImportJob({
      label: 'steady.txt',
      stallMs: 1_000,
      now: () => clock,
      work: ctx => {
        beat = ctx.beat
        return new Promise<string>(resolve => { finish = resolve })
      },
    })

    clock = 800
    await vi.advanceTimersByTimeAsync(800) // idle 800 < 1000: still alive
    beat() // last progress at 800
    clock = 1_600
    await vi.advanceTimersByTimeAsync(800) // idle 800 since the beat: still alive
    finish('done')

    await expect(promise).resolves.toBe('done')
  })

  it('frees a queue slot even though the work never settles', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 0
    const queue = pLimit(1)

    const first = queue(() => runImportJob({
      label: 'wedged.txt',
      stallMs: 1_000,
      now: () => clock,
      work: () => new Promise<never>(() => { /* never settles */ }),
    }))
    const firstRejection = expect(first).rejects.toBeInstanceOf(ImportStalledError)
    let secondRan = false
    const second = queue(async () => { secondRan = true })

    await vi.advanceTimersByTimeAsync(0) // let the queue start the first job (and its watchdog) before time moves
    clock = 1_500
    await vi.advanceTimersByTimeAsync(1_500)

    await firstRejection
    await second
    expect(secondRan).toBe(true)
  })

  it('aborts the work and rejects with the reason when an external signal fires', async () => {
    const external = new AbortController()
    const reason = new Error('operator cancelled')
    let seen!: AbortSignal

    const promise = runImportJob({
      label: 'a.txt',
      signal: external.signal,
      work: ({ signal }) => {
        seen = signal
        return new Promise<never>(() => { /* waits for the abort */ })
      },
    })
    external.abort(reason)

    await expect(promise).rejects.toBe(reason)
    expect(seen.aborted).toBe(true)
  })

  it('rejects at once when the external signal is already aborted', async () => {
    const external = new AbortController()
    const reason = new Error('already cancelled')
    external.abort(reason)

    await expect(runImportJob({ label: 'a.txt', signal: external.signal, work: async () => 1 })).rejects.toBe(reason)
  })

  it('leaves no timer running after the work finishes', async () => {
    vi.useFakeTimers()
    await runImportJob({ label: 'a.txt', work: async () => 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('measures idle time on the monotonic clock: a wall-clock jump (a laptop suspend) does not fail a healthy job', async () => {
    let finish!: () => void
    const promise = runImportJob({
      label: 'healthy.txt',
      stallMs: 400, // the watchdog checks every 100 ms
      work: () => new Promise<void>(resolve => { finish = resolve }),
    })

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000) // the lid reopens a day later
    await new Promise(resolve => setTimeout(resolve, 250)) // two watchdog checks, well under stallMs of real time
    finish()

    await expect(promise).resolves.toBeUndefined()
  })
})
