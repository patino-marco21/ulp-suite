import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ULPCredential } from '@/lib/ulp-parser'

const { insertSpy } = vi.hoisted(() => ({ insertSpy: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({ insert: insertSpy, query: vi.fn() }),
}))

const cred = (o: Partial<ULPCredential>): ULPCredential => ({
  url: '', email: '', password: '', domain: '', source_file: 'f.txt', ...o,
})

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
    expect(settings.async_insert).toBeUndefined()
    expect(settings.wait_for_async_insert).toBeUndefined()
    expect(settings.async_insert_deduplicate).toBeUndefined()
    expect(settings.max_insert_threads).toBe(2)
  })

  it('retries transient insert failures with the same token, fresh streams, and sanitized logs', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]
    let nowMs = 0
    let retryLog = ''

    insertSpy
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(undefined)

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

    expect(retryLog).toContain('1000')
    expect(retryLog).not.toContain('https://a.com')
    expect(retryLog).not.toContain('a@a.com')
    expect(retryLog).not.toContain('p1')
  })

  it('does not call insert for an empty batch', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    await insertBatch([], 'breachX')
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
