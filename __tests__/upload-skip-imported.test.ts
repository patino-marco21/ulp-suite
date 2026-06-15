import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'

// Controllable ClickHouse client mock.
const h = vi.hoisted(() => ({
  insert: vi.fn().mockResolvedValue(undefined),
  query:  vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/domain-monitor', () => ({ checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/upload-jobs', () => ({ updateJob: vi.fn() }))

const webStream = (s: string) =>
  Readable.toWeb(Readable.from([Buffer.from(s)])) as ReadableStream<Uint8Array>

// ulp.sources existence check returns [{ c }]; default 0 (not yet imported).
const sourcesCount = (c: number) =>
  h.query.mockResolvedValue({ json: async () => [{ c }] })

beforeEach(() => {
  h.insert.mockClear()
  h.query.mockReset()
})

describe('processTextStream — durable re-upload guard (ulp.sources)', () => {
  it('skips the import entirely when the filename is already in ulp.sources', async () => {
    sourcesCount(1) // already imported
    const { processTextStream } = await import('@/lib/upload-processor')

    const result = await processTextStream(
      webStream('https://example.com/login:user@example.com:mypassword\n'),
      'already.txt',
    )

    expect(result.imported).toBe(0)
    expect(result.alreadyImported).toBe(true)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('imports normally when the filename is not yet in ulp.sources', async () => {
    sourcesCount(0) // not imported
    const { processTextStream } = await import('@/lib/upload-processor')

    const result = await processTextStream(
      webStream('https://example.com/login:user@example.com:mypassword\n'),
      'fresh.txt',
    )

    expect(result.imported).toBe(1)
    expect(result.alreadyImported).toBe(false)
    expect(h.insert).toHaveBeenCalled() // credentials inserted
  })
})
