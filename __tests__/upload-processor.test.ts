import { readFileSync } from 'fs'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import type yauzl from 'yauzl'

// ─── Mocks for everything processTextStream touches downstream ──────────────

const h = vi.hoisted(() => ({
  insert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
}))

vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({
    insert: h.insert,
    query: h.query,
  }),
}))
vi.mock('@/lib/domain-monitor', () => ({
  checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/upload-jobs', () => ({ updateJob: vi.fn() }))
vi.mock('@/lib/content-dedup', () => ({ runContentDedupTick: vi.fn().mockResolvedValue(undefined) }))

beforeEach(() => {
  h.insert.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockReset()
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
})

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

describe('upload processor source contract', () => {
  it('exports the 100,000-row upload batch size and removes the import-time dedup hook', async () => {
    const { UPLOAD_BATCH_SIZE } = await import('@/lib/upload-processor')
    const source = readFileSync(new URL('../lib/upload-processor.ts', import.meta.url), 'utf8')

    expect(UPLOAD_BATCH_SIZE).toBe(100_000)
    expect(source).not.toContain("runContentDedupTick({ trigger: 'import' })")
  })

  it('passes UPLOAD_BATCH_SIZE to parseULPStream during text imports', async () => {
    vi.resetModules()
    let receivedBatchSize: number | undefined

    vi.doMock('@/lib/ulp-parser', async () => {
      const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
      return {
        ...actual,
        parseULPStream: async function* () {
          receivedBatchSize = arguments[2] as number
          yield {
            credentials: [],
            rejected: 0,
            breakdown: actual.makeRejectionMap(),
          }
        },
      }
    })

    try {
      const { processTextStream, UPLOAD_BATCH_SIZE } = await import('@/lib/upload-processor')
      await processTextStream(Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>, 'batch-size.txt')

      expect(receivedBatchSize).toBe(UPLOAD_BATCH_SIZE)
      expect(receivedBatchSize).toBe(100_000)
    } finally {
      vi.doUnmock('@/lib/ulp-parser')
      vi.resetModules()
    }
  })

  it('retries transient source existence checks', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    h.query
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({ json: async () => [{ c: 1 }] })

    try {
      const { sourceAlreadyImported } = await import('@/lib/upload-processor')
      const expectation = expect(sourceAlreadyImported('retry-check.txt')).resolves.toBe(true)

      await vi.advanceTimersByTimeAsync(1000)

      await expectation
      expect(h.query).toHaveBeenCalledTimes(2)
      expect(h.query.mock.calls.every(call => call[0].abort_signal instanceof AbortSignal)).toBe(true)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('retry-check.txt')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('closes a source ResultSet whose json body hangs after headers when the deadline aborts', async () => {
    vi.useFakeTimers()
    let rejectJson!: (error: Error) => void
    const close = vi.fn(() => rejectJson(new Error('response stream closed')))
    h.query.mockResolvedValue({
      json: () => new Promise<never>((_resolve, reject) => { rejectJson = reject }),
      close,
    })

    try {
      const { ClickHouseRetryExhaustedError } = await import('@/lib/clickhouse-retry')
      const { sourceAlreadyImported } = await import('@/lib/upload-processor')
      const promise = sourceAlreadyImported('hanging-body.txt')
      const expectation = expect(promise).rejects.toBeInstanceOf(ClickHouseRetryExhaustedError)

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      await expectation

      expect(close).toHaveBeenCalledTimes(1)
      expect(h.query).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes without consuming a ResultSet returned after its signal is already aborted', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const json = vi.fn(() => new Promise<never>(() => {}))
    h.query.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ json, close }), 30 * 60 * 1000 + 1)
    }))

    try {
      const { ClickHouseRetryExhaustedError } = await import('@/lib/clickhouse-retry')
      const { sourceAlreadyImported } = await import('@/lib/upload-processor')
      const promise = sourceAlreadyImported('late-headers.txt')
      const expectation = expect(promise).rejects.toBeInstanceOf(ClickHouseRetryExhaustedError)

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1)
      await expectation

      expect(close).toHaveBeenCalledTimes(1)
      expect(json).not.toHaveBeenCalled()
      expect(h.query).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries transient source recording inserts', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    h.query.mockResolvedValueOnce({ json: async () => [{ c: 0 }] })
    h.insert
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(undefined)

    try {
      const { recordSource } = await import('@/lib/upload-processor')
      const promise = recordSource('retry-record.txt', 42)
      const expectation = expect(promise).resolves.toBeUndefined()

      await vi.advanceTimersByTimeAsync(1000)
      await expectation

      expect(h.query).toHaveBeenCalledTimes(2)
      expect(h.insert).toHaveBeenCalledTimes(2)
      expect(h.insert.mock.calls.every(call => call[0].abort_signal instanceof AbortSignal)).toBe(true)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('retry-record.txt')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('avoids duplicate source inserts after an ambiguous committed retry by bypassing stale query-cache results', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    h.query.mockImplementation(({ clickhouse_settings }: { clickhouse_settings?: Record<string, unknown> }) => {
      const useQueryCache = clickhouse_settings?.use_query_cache
      const c = h.query.mock.calls.length === 1 ? 0 : (useQueryCache === 0 ? 1 : 0)
      return Promise.resolve({ json: async () => [{ c }] })
    })

    h.insert
      .mockRejectedValueOnce(Object.assign(new Error('response failed after commit'), { code: 'ECONNRESET' }))
      .mockResolvedValue(undefined)

    try {
      const { recordSource } = await import('@/lib/upload-processor')
      const expectation = expect(recordSource('stale-cache.txt', 42)).resolves.toBeUndefined()

      await vi.advanceTimersByTimeAsync(1000)
      await expectation

      expect(h.query).toHaveBeenCalledTimes(2)
      expect(h.insert).toHaveBeenCalledTimes(1)
      expect(h.query.mock.calls[0][0].clickhouse_settings?.use_query_cache).toBe(0)
      expect(h.query.mock.calls[1][0].clickhouse_settings?.use_query_cache).toBe(0)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('stale-cache.txt')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

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

  it('rejects the archive when text processing fails in ClickHouse', async () => {
    const yauzl = (await import('yauzl')).default
    const { processZipBuffer } = await import('@/lib/upload-processor')
    const databaseError = Object.assign(new Error('DB::Exception: bad query'), { code: '62' })
    h.query.mockRejectedValue(databaseError)

    const fake = new FakeZipFile([
      { fileName: 'db-failure.txt', contentOrError: 'https://example.com/login:user@example.com:mypassword\n' },
      { fileName: 'must-not-run.txt', contentOrError: 'https://example.com/login:user2@example.com:mypassword\n' },
    ])
    ;(yauzl.fromBuffer as any).mockImplementation(
      (_buf: Buffer, _opts: unknown, cb: (err: Error | null, zipfile: yauzl.ZipFile) => void) => {
        cb(null, fake as unknown as yauzl.ZipFile)
      }
    )

    const results: unknown[] = []
    await expect(processZipBuffer(Buffer.from('fake zip'), result => results.push(result))).rejects.toBe(databaseError)
    expect(results).toEqual([])
  })

  it('rejects the archive when text processing exhausts ClickHouse retries', async () => {
    const yauzl = (await import('yauzl')).default
    const { ClickHouseRetryExhaustedError } = await import('@/lib/clickhouse-retry')
    const { processZipBuffer } = await import('@/lib/upload-processor')
    const retryError = new ClickHouseRetryExhaustedError(3, Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    h.query.mockRejectedValue(retryError)

    const fake = new FakeZipFile([
      { fileName: 'retry-exhausted.txt', contentOrError: 'https://example.com/login:user@example.com:mypassword\n' },
    ])
    ;(yauzl.fromBuffer as any).mockImplementation(
      (_buf: Buffer, _opts: unknown, cb: (err: Error | null, zipfile: yauzl.ZipFile) => void) => {
        cb(null, fake as unknown as yauzl.ZipFile)
      }
    )

    await expect(processZipBuffer(Buffer.from('fake zip'), () => {})).rejects.toBe(retryError)
  })

  it('rejects the archive when a credential insert exhausts ClickHouse retries', async () => {
    const yauzl = (await import('yauzl')).default
    const { ClickHouseRetryExhaustedError } = await import('@/lib/clickhouse-retry')
    const { processZipBuffer } = await import('@/lib/upload-processor')
    const retryError = new ClickHouseRetryExhaustedError(2, Object.assign(new Error('refused'), { code: 'ECONNRESET' }))
    h.insert.mockRejectedValue(retryError)

    const fake = new FakeZipFile([
      { fileName: 'insert-exhausted.txt', contentOrError: 'https://example.com/login:user@example.com:mypassword\n' },
    ])
    ;(yauzl.fromBuffer as any).mockImplementation(
      (_buf: Buffer, _opts: unknown, cb: (err: Error | null, zipfile: yauzl.ZipFile) => void) => {
        cb(null, fake as unknown as yauzl.ZipFile)
      }
    )

    await expect(processZipBuffer(Buffer.from('fake zip'), () => {})).rejects.toBe(retryError)
  })
})

describe('parser-time hard-tier drop wiring', () => {
  it('passes a hard-drop predicate to parseULPStream and drops T3 in the parser', async () => {
    vi.resetModules()
    process.env.INGEST_FILTER_HARD_DROP_TIERS = 'T3'

    let received: ((e: string, u: string) => boolean) | undefined
    vi.doMock('@/lib/ulp-parser', async () => {
      const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
      return {
        ...actual,
        parseULPStream: async function* (_s: any, _f: any, _b: any, pred?: any) {
          received = pred
          yield { credentials: [], rejected: 1, breakdown: { ...actual.makeRejectionMap(), tier_dropped: 1 } }
        },
      }
    })

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      const { Readable } = await import('node:stream')
      const res = await processTextStream(
        Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>, 'tier.txt')
      expect(typeof received).toBe('function')
      expect(received!('x@mail.ru', '')).toBe(true)       // T3 dropped
      expect(received!('x@gmail.com', '')).toBe(false)     // untiered kept
      expect(res.rejection_breakdown.tier_dropped).toBe(1) // surfaced in the result
    } finally {
      delete process.env.INGEST_FILTER_HARD_DROP_TIERS
      vi.doUnmock('@/lib/ulp-parser')
      vi.resetModules()
    }
  })
})
