import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import type yauzl from 'yauzl'

// ─── Mocks for everything processTextStream touches downstream ──────────────

vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
  }),
}))
vi.mock('@/lib/domain-monitor', () => ({
  checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/stats-cache', () => ({ invalidateStatsCache: vi.fn() }))
vi.mock('@/lib/upload-jobs', () => ({ updateJob: vi.fn() }))

// ─── Fake yauzl ZipFile ───────────────────────────────────────────────────────

interface FakeEntrySpec {
  fileName: string
  /** String content for a successful entry, or an Error to fail openReadStream. */
  contentOrError: string | Error
}

class FakeZipFile extends EventEmitter {
  private idx = 0
  constructor(private specs: FakeEntrySpec[]) { super() }

  readEntry(): void {
    if (this.idx >= this.specs.length) {
      process.nextTick(() => this.emit('end'))
      return
    }
    const spec = this.specs[this.idx++]
    process.nextTick(() => this.emit('entry', { fileName: spec.fileName } as yauzl.Entry))
  }

  openReadStream(entry: yauzl.Entry, cb: (err: Error | null, stream?: Readable) => void): void {
    const spec = this.specs.find(s => s.fileName === entry.fileName)!
    if (spec.contentOrError instanceof Error) {
      process.nextTick(() => cb(spec.contentOrError as Error))
    } else {
      process.nextTick(() => cb(null, Readable.from([Buffer.from(spec.contentOrError as string)])))
    }
  }
}

vi.mock('yauzl', () => ({
  default: {
    fromBuffer: vi.fn(),
    open: vi.fn(),
  },
}))

describe('processZipBuffer', () => {
  it('continues processing remaining entries after one entry fails to open (e.g. encrypted)', async () => {
    const yauzl = (await import('yauzl')).default
    const { processZipBuffer } = await import('@/lib/upload-processor')

    const fake = new FakeZipFile([
      { fileName: 'bad.txt', contentOrError: new Error('entry is encrypted') },
      { fileName: 'good.txt', contentOrError: 'https://example.com/login:user@example.com:mypassword\n' },
    ])

    ;(yauzl.fromBuffer as any).mockImplementation(
      (_buf: Buffer, _opts: unknown, cb: (err: Error | null, zipfile: yauzl.ZipFile) => void) => {
        cb(null, fake as unknown as yauzl.ZipFile)
      }
    )

    const results: Array<{ filename: string; imported: number; errors: number }> = []
    await processZipBuffer(Buffer.from('fake zip'), result => {
      results.push({ filename: result.filename, imported: result.imported, errors: result.errors })
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ filename: 'bad.txt', imported: 0, errors: 1 })
    expect(results[1]).toEqual({ filename: 'good.txt', imported: 1, errors: 0 })
  })

  it('continues processing remaining entries after one entry stream errors mid-read', async () => {
    const yauzl = (await import('yauzl')).default
    const { processZipBuffer } = await import('@/lib/upload-processor')

    class ErroringReadable extends Readable {
      _read(): void {
        process.nextTick(() => this.emit('error', new Error('CRC32 checksum mismatch')))
      }
    }

    const fake = new FakeZipFile([
      { fileName: 'good1.txt', contentOrError: 'https://example.com/login:user1@example.com:mypassword\n' },
      { fileName: 'corrupt.txt', contentOrError: 'placeholder' },
      { fileName: 'good2.txt', contentOrError: 'https://example.com/login:user2@example.com:mypassword\n' },
    ])

    // Override openReadStream for the corrupt entry to return a stream that errors.
    const originalOpen = fake.openReadStream.bind(fake)
    fake.openReadStream = (entry: yauzl.Entry, cb: (err: Error | null, stream?: Readable) => void) => {
      if (entry.fileName === 'corrupt.txt') {
        process.nextTick(() => cb(null, new ErroringReadable()))
        return
      }
      originalOpen(entry, cb)
    }

    ;(yauzl.fromBuffer as any).mockImplementation(
      (_buf: Buffer, _opts: unknown, cb: (err: Error | null, zipfile: yauzl.ZipFile) => void) => {
        cb(null, fake as unknown as yauzl.ZipFile)
      }
    )

    const results: Array<{ filename: string; imported: number; errors: number }> = []
    await processZipBuffer(Buffer.from('fake zip'), result => {
      results.push({ filename: result.filename, imported: result.imported, errors: result.errors })
    })

    expect(results).toHaveLength(3)
    expect(results.map(r => r.filename)).toEqual(['good1.txt', 'corrupt.txt', 'good2.txt'])
    expect(results[1]).toEqual({ filename: 'corrupt.txt', imported: 0, errors: 1 })
    expect(results[0].imported).toBe(1)
    expect(results[2].imported).toBe(1)
  })
})
