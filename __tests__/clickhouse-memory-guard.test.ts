import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  query: vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ query: h.query }) }))

const pressureResult = (used: number, ceiling: number) =>
  h.query.mockResolvedValue({ json: async () => [{ used: String(used), ceiling: String(ceiling) }] })

beforeEach(() => {
  h.query.mockReset()
})

describe('checkMemoryPressure', () => {
  it('computes the ratio of MemoryTracking to max_server_memory_usage', async () => {
    pressureResult(9_000_000_000, 18_000_000_000)
    const { checkMemoryPressure } = await import('@/lib/clickhouse-memory-guard')

    const result = await checkMemoryPressure(new AbortController().signal)

    expect(result).toEqual({ usedBytes: 9_000_000_000, ceilingBytes: 18_000_000_000, ratio: 0.5 })
  })

  it('passes the abort signal through to the query', async () => {
    pressureResult(1, 2)
    const { checkMemoryPressure } = await import('@/lib/clickhouse-memory-guard')
    const controller = new AbortController()

    await checkMemoryPressure(controller.signal)

    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ abort_signal: controller.signal }))
  })
})

describe('waitForHeadroom', () => {
  it('resolves immediately when ratio is under threshold', async () => {
    pressureResult(1_000_000_000, 18_000_000_000) // ~5.5%
    const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')

    await waitForHeadroom(new AbortController().signal, { thresholdRatio: 0.75 })

    expect(h.query).toHaveBeenCalledTimes(1)
  })

  it('polls until the ratio drops below threshold, then resolves', async () => {
    vi.useFakeTimers()
    h.query
      .mockResolvedValueOnce({ json: async () => [{ used: '16000000000', ceiling: '18000000000' }] }) // ~0.89
      .mockResolvedValueOnce({ json: async () => [{ used: '16000000000', ceiling: '18000000000' }] }) // ~0.89
      .mockResolvedValueOnce({ json: async () => [{ used: '9000000000',  ceiling: '18000000000' }] }) // 0.5

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')
      const promise = waitForHeadroom(new AbortController().signal, {
        thresholdRatio: 0.75, pollIntervalMs: 5_000, maxWaitMs: 60_000,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await promise

      expect(h.query).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails open when the pressure check itself throws', async () => {
    h.query.mockRejectedValue(new Error('connection refused'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')

      await expect(waitForHeadroom(new AbortController().signal)).resolves.toBeUndefined()
      expect(h.query).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('fails open once maxWaitMs elapses while still over threshold', async () => {
    vi.useFakeTimers()
    h.query.mockResolvedValue({ json: async () => [{ used: '17000000000', ceiling: '18000000000' }] }) // ~0.94, always over
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { waitForHeadroom } = await import('@/lib/clickhouse-memory-guard')
      const promise = waitForHeadroom(new AbortController().signal, {
        thresholdRatio: 0.75, pollIntervalMs: 5_000, maxWaitMs: 12_000,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await promise

      expect(h.query.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('wait budget')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
