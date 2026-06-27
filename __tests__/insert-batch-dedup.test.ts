import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ULPCredential } from '@/lib/ulp-parser'
import { Readable } from 'stream'

const { insertSpy } = vi.hoisted(() => ({ insertSpy: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({ insert: insertSpy, query: vi.fn() }),
}))

const cred = (o: Partial<ULPCredential>): ULPCredential => ({
  url: '', email: '', password: '', domain: '', source_file: 'f.txt', ...o,
})

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

beforeEach(() => {
  insertSpy.mockReset()
  insertSpy.mockResolvedValue(undefined)
})

describe('insertBatch deduplication settings', () => {
  it('uses synchronous deduplicated inserts with the content-derived dedup token', async () => {
    const { insertBatch }    = await import('@/lib/upload-processor')
    const { batchDedupToken } = await import('@/lib/upload-dedup')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]

    await insertBatch(batch, 'breachX')

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const settings = insertSpy.mock.calls[0][0].clickhouse_settings
    expect(settings.insert_deduplicate).toBe(1)
    expect(settings.insert_deduplication_token).toBe(batchDedupToken(batch, 'breachX'))
    // Explicitly disabled, not merely absent — the default profile sets async_insert=1
    // for combining many small inserts. Leaving this unset means a 100K-row batch
    // silently inherits that default and gets routed through the async-insert buffer,
    // which is what produced the 2026-06-27 "(total) memory limit exceeded ... While
    // executing WaitForAsyncInsert" production failures.
    expect(settings.async_insert).toBe(0)
    expect(settings.wait_for_async_insert).toBeUndefined()
    expect(settings.async_insert_deduplicate).toBeUndefined()
    expect(settings.max_insert_threads).toBe(2)
    expect(insertSpy.mock.calls[0][0].abort_signal).toBeInstanceOf(AbortSignal)
  })

  it('retries transient insert failures with the same token, fresh streams, and sanitized logs', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]
    let nowMs = 0
    let retryLog = ''
    const payloads: string[] = []

    insertSpy.mockImplementation(async ({ values }: { values: Readable }) => {
      payloads.push(await readAll(values))

      if (payloads.length === 1) {
        throw Object.assign(new Error('fetch failed'), { code: 'token=supersecret' })
      }
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await insertBatch(batch, 'breachX', {
        now: () => nowMs,
        sleep: async delayMs => {
          nowMs += delayMs
        },
      })
      retryLog = warnSpy.mock.calls.flat().join(' ')
    } finally {
      warnSpy.mockRestore()
    }

    expect(insertSpy).toHaveBeenCalledTimes(2)

    const firstCall = insertSpy.mock.calls[0][0]
    const secondCall = insertSpy.mock.calls[1][0]

    expect(firstCall.clickhouse_settings.insert_deduplication_token)
      .toBe(secondCall.clickhouse_settings.insert_deduplication_token)
    expect(firstCall.values).not.toBe(secondCall.values)
    expect(firstCall.abort_signal).toBeInstanceOf(AbortSignal)
    expect(secondCall.abort_signal).toBeInstanceOf(AbortSignal)
    expect(firstCall.abort_signal).not.toBe(secondCall.abort_signal)
    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toBe(payloads[1])
    expect(payloads[0]).toBe('"https://a.com","a@a.com","p1","a.com","f.txt","breachX"\n')

    expect(retryLog).toContain('1000')
    expect(retryLog).not.toContain('https://a.com')
    expect(retryLog).not.toContain('a@a.com')
    expect(retryLog).not.toContain('p1')
    expect(retryLog).not.toContain('token=supersecret')
    expect(retryLog).toContain('fetch failed')
  })

  it('does not call insert for an empty batch', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    await insertBatch([], 'breachX')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('defaults to ulp.credentials and honours an explicit target table', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]

    await insertBatch(batch, 'breachX')
    expect(insertSpy.mock.calls[0][0].table).toBe('ulp.credentials')

    insertSpy.mockClear()

    await insertBatch(batch, 'breachX', undefined, { table: 'ulp.bench_123' })
    expect(insertSpy.mock.calls[0][0].table).toBe('ulp.bench_123')
  })

  it('keeps retrying transient overload failures well past the base 30-minute retry deadline', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]
    let nowMs = 0
    let attempts = 0

    insertSpy.mockImplementation(async () => {
      attempts += 1
      if (attempts < 4) {
        throw Object.assign(new Error('(total) memory limit exceeded: would use 14 GiB'), { code: '241' })
      }
    })

    // Each retry "costs" 20 simulated minutes regardless of the requested backoff
    // delay, so 3 retries blow past the base 30-minute deadline (60 min total) —
    // proving insertBatch's own default deadline is longer than that base default,
    // for long unattended AFK import runs where the server can stay near its
    // memory ceiling for an extended stretch.
    await insertBatch(batch, 'breachX', {
      now: () => nowMs,
      sleep: async () => { nowMs += 20 * 60 * 1000 },
    })

    expect(attempts).toBe(4)
    expect(nowMs).toBeGreaterThan(30 * 60 * 1000)
  })
})
