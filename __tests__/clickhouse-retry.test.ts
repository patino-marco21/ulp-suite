import { describe, expect, it, vi } from 'vitest'

import {
  ClickHouseRetryExhaustedError,
  isTransientClickHouseError,
  withClickHouseRetry,
} from '@/lib/clickhouse-retry'

describe('isTransientClickHouseError', () => {
  it('classifies connection and gateway failures as transient', () => {
    expect(isTransientClickHouseError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isTransientClickHouseError({ statusCode: 503, message: 'unavailable' })).toBe(true)
    expect(isTransientClickHouseError(Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }))).toBe(true)
    expect(isTransientClickHouseError(new Error('Bad Gateway'))).toBe(true)
    expect(isTransientClickHouseError(new Error('upstream returned 503 Service Unavailable'))).toBe(true)
    expect(isTransientClickHouseError(new Error('504 Gateway Timeout from proxy'))).toBe(true)
    expect(isTransientClickHouseError(new Error('Timeout error.'))).toBe(true)
  })

  it('does not classify semantic ClickHouse failures as transient', () => {
    expect(isTransientClickHouseError(Object.assign(new Error('bad query'), { code: '62' }))).toBe(false)
    expect(isTransientClickHouseError({ status: 500, message: 'memory limit exceeded' })).toBe(false)
  })

  it('rejects mixed-signal semantic errors even when they look transient', () => {
    expect(isTransientClickHouseError({ statusCode: 503, message: 'bad query' })).toBe(false)
    expect(
      isTransientClickHouseError({
        message: 'memory limit exceeded',
        cause: { code: 'ECONNRESET' },
      })
    ).toBe(false)
    expect(isTransientClickHouseError(new Error('Bad Gateway: DB::Exception: Syntax error'))).toBe(false)
  })
})

describe('withClickHouseRetry', () => {
  it('retries transient failures with exponential delays until success', async () => {
    let nowMs = 0
    const sleeps: number[] = []
    const retryCalls: Array<{ attempt: number; delayMs: number; message: string }> = []
    let attempts = 0

    const result = await withClickHouseRetry(
      async () => {
        attempts += 1
        if (attempts < 3) {
          throw Object.assign(new Error(`transient ${attempts}`), { code: 'ECONNRESET' })
        }
        return 'ok'
      },
      {
        now: () => nowMs,
        sleep: async delayMs => {
          sleeps.push(delayMs)
          nowMs += delayMs
        },
        onRetry: ({ attempt, delayMs, error }) => {
          retryCalls.push({ attempt, delayMs, message: error instanceof Error ? error.message : String(error) })
        },
      }
    )

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(retryCalls).toEqual([
      { attempt: 1, delayMs: 1000, message: 'transient 1' },
      { attempt: 2, delayMs: 2000, message: 'transient 2' },
    ])
  })

  it('caps the retry delay at 30000 ms', async () => {
    let nowMs = 0
    const sleeps: number[] = []
    let attempts = 0

    await expect(
      withClickHouseRetry(
        async () => {
          attempts += 1
          throw Object.assign(new Error(`transient ${attempts}`), { code: 'ECONNREFUSED' })
        },
        {
          initialDelayMs: 20000,
          maxDelayMs: 30000,
          maxElapsedMs: 100000,
          now: () => nowMs,
          sleep: async delayMs => {
            sleeps.push(delayMs)
            nowMs += delayMs
            if (attempts >= 3) {
              throw new Error('stop')
            }
          },
        }
      )
    ).rejects.toThrow('stop')

    expect(sleeps).toEqual([20000, 30000, 30000])
  })

  it('throws semantic failures immediately with no sleep', async () => {
    const sleep = vi.fn(async () => undefined)
    let attempts = 0

    await expect(
      withClickHouseRetry(
        async () => {
          attempts += 1
          throw Object.assign(new Error('bad query'), { code: '62' })
        },
        { sleep }
      )
    ).rejects.toThrow('bad query')

    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('throws ClickHouseRetryExhaustedError when the next delay would exceed the deadline', async () => {
    let nowMs = 0
    const sleeps: number[] = []
    let attempts = 0

    const promise = withClickHouseRetry(
      async () => {
        attempts += 1
        throw Object.assign(new Error(`transient ${attempts}`), { code: 'ECONNRESET' })
      },
      {
        maxElapsedMs: 1500,
        now: () => nowMs,
        sleep: async delayMs => {
          sleeps.push(delayMs)
          nowMs += delayMs
        },
      }
    )

    await expect(promise).rejects.toBeInstanceOf(ClickHouseRetryExhaustedError)

    const exhausted = await promise.catch(error => error as ClickHouseRetryExhaustedError)
    expect(exhausted).toBeInstanceOf(ClickHouseRetryExhaustedError)
    expect(exhausted.attempts).toBe(2)
    expect(exhausted.lastError).toBeInstanceOf(Error)
    expect(exhausted.message).toContain('ECONNRESET')

    expect(sleeps).toEqual([1000])
  })

  it('aborts an in-flight attempt at the hard wall-clock deadline without starting another attempt', async () => {
    let attempts = 0
    let observedSignal: AbortSignal | undefined

    const promise = withClickHouseRetry(
      signal => {
        attempts += 1
        observedSignal = signal
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('operation aborted')), { once: true })
        })
      },
      { maxElapsedMs: 20, initialDelayMs: 1, maxDelayMs: 1 }
    )

    await expect(promise).rejects.toBeInstanceOf(ClickHouseRetryExhaustedError)
    expect(observedSignal?.aborted).toBe(true)
    expect(attempts).toBe(1)
  })

  it('keeps exhaustion summaries useful without copying arbitrary sensitive error text', async () => {
    const secret = new Error('fetch failed for https://user:password@example.test/private?token=secret')
    Object.assign(secret, { code: 'ECONNREFUSED' })

    const error = await withClickHouseRetry(
      async () => { throw secret },
      { maxElapsedMs: 0 }
    ).catch(cause => cause as ClickHouseRetryExhaustedError)

    expect(error.message).toContain('ECONNREFUSED')
    expect(error.message).not.toContain('password')
    expect(error.message).not.toContain('token=secret')
    expect(error.lastError).toBe(secret)
  })
})
