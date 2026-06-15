import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ULPCredential } from '@/lib/ulp-parser'

const { insertSpy } = vi.hoisted(() => ({ insertSpy: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({ insert: insertSpy, query: vi.fn() }),
}))

const cred = (o: Partial<ULPCredential>): ULPCredential => ({
  url: '', email: '', password: '', domain: '', source_file: 'f.txt', ...o,
})

beforeEach(() => insertSpy.mockClear())

describe('insertBatch deduplication settings', () => {
  it('enables insert_deduplicate and passes the content-derived dedup token', async () => {
    const { insertBatch }    = await import('@/lib/upload-processor')
    const { batchDedupToken } = await import('@/lib/upload-dedup')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]

    await insertBatch(batch, 'breachX')

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const settings = insertSpy.mock.calls[0][0].clickhouse_settings
    expect(settings.insert_deduplicate).toBe(1)
    expect(settings.insert_deduplication_token).toBe(batchDedupToken(batch, 'breachX'))
  })

  it('does not call insert for an empty batch', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    await insertBatch([], 'breachX')
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
