import fs, { readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { beforeEach, describe, it, expect, vi } from 'vitest'

// ─── Mocks for everything processTextStream touches downstream ──────────────

const h = vi.hoisted(() => ({
  insert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
}))
const dm = vi.hoisted(() => ({
  getActiveMonitors: vi.fn().mockResolvedValue([]),
  fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({
    insert: h.insert,
    query: h.query,
  }),
}))
vi.mock('@/lib/domain-monitor', () => dm)
vi.mock('@/lib/upload-jobs', () => ({ updateJob: vi.fn() }))
vi.mock('@/lib/content-dedup', () => ({ runContentDedupTick: vi.fn().mockResolvedValue(undefined) }))

beforeEach(() => {
  h.insert.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockReset()
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})

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

describe('live ingest-metrics wiring', () => {
  it('processTextStream brackets the import with startIngest/finishIngest', async () => {
    vi.resetModules()
    const ig = { startIngest: vi.fn(), recordBatch: vi.fn(), finishIngest: vi.fn(),
                 getIngestMetrics: vi.fn() }
    vi.doMock('@/lib/ingest-metrics', () => ig)
    vi.doMock('@/lib/ulp-parser', async () => {
      const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
      return {
        ...actual,
        parseULPStream: async function* () {
          yield { credentials: [], rejected: 0, breakdown: actual.makeRejectionMap() }
        },
      }
    })
    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      const { Readable } = await import('node:stream')
      await processTextStream(Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>, 'live.txt')
      expect(ig.startIngest).toHaveBeenCalledWith('live.txt')
      expect(ig.finishIngest).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@/lib/ingest-metrics')
      vi.doUnmock('@/lib/ulp-parser')
      vi.resetModules()
    }
  })
})

describe('memory-guard wiring', () => {
  it('streamCredentialsToTable calls waitForHeadroom once per batch, before the insert', async () => {
    vi.resetModules()
    const callOrder: string[] = []
    const guard = { waitForHeadroom: vi.fn().mockImplementation(async () => { callOrder.push('guard') }) }
    vi.doMock('@/lib/clickhouse-memory-guard', () => guard)
    h.insert.mockImplementation(async () => { callOrder.push('insert') })

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      await processTextStream(
        Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
        'guard-wiring.txt',
      )

      expect(guard.waitForHeadroom).toHaveBeenCalledTimes(1)
      // callOrder includes: guard (from batch loop), then insert (batch credentials), then insert (recordSource)
      expect(callOrder[0]).toBe('guard')
      expect(callOrder[1]).toBe('insert')
    } finally {
      vi.doUnmock('@/lib/clickhouse-memory-guard')
      vi.resetModules()
    }
  })
})

describe('domain-monitor wiring — in-process matching', () => {
  it('accumulates matched credentials in-process and fires alerts once per file', async () => {
    vi.resetModules()
    const dm = {
      getActiveMonitors: vi.fn().mockResolvedValue([
        { id: 1, name: 'Test', domains: ['example.com'], match_mode: 'both', is_active: true,
          created_by: null, last_triggered_at: null, total_alerts: 0,
          rescan_mode: 'dedup', rescan_interval_hours: 24, created_at: '', updated_at: '' },
      ]),
      fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
    }
    vi.doMock('@/lib/domain-monitor', () => dm)

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      await processTextStream(
        Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
        'monitor-wiring.txt',
      )

      expect(dm.getActiveMonitors).toHaveBeenCalledOnce()
      expect(dm.fireMonitorAlertsFromMatches).toHaveBeenCalledOnce()
      const [sourceFile, matches, monitorsById] = dm.fireMonitorAlertsFromMatches.mock.calls[0]
      expect(sourceFile).toBe('monitor-wiring.txt')
      expect(matches).toEqual([
        expect.objectContaining({ monitorId: 1, email: 'user@example.com', domain: 'example.com' }),
      ])
      expect(monitorsById.get(1)).toMatchObject({ id: 1, domains: ['example.com'] })
    } finally {
      vi.doUnmock('@/lib/domain-monitor')
      vi.resetModules()
    }
  })

  it('does not call fireMonitorAlertsFromMatches when there are no active monitors', async () => {
    dm.getActiveMonitors.mockResolvedValue([])
    dm.fireMonitorAlertsFromMatches.mockClear()
    const { processTextStream } = await import('@/lib/upload-processor')
    await processTextStream(
      Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
      'no-monitors.txt',
    )
    // Uses this file's static top-level mock: getActiveMonitors resolves to [].
    expect(dm.fireMonitorAlertsFromMatches).not.toHaveBeenCalled()
  })

  it('still imports the file when getActiveMonitors rejects (monitoring is a side-channel, not on the critical path)', async () => {
    vi.resetModules()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dm = {
      getActiveMonitors: vi.fn().mockRejectedValue(Object.assign(new Error('SQLITE_READONLY'), { code: 'SQLITE_READONLY' })),
      fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
    }
    vi.doMock('@/lib/domain-monitor', () => dm)

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      const result = await processTextStream(
        Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>,
        'monitor-getactive-failure.txt',
      )

      expect(result.imported).toBe(1)
      expect(dm.fireMonitorAlertsFromMatches).not.toHaveBeenCalled()
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      vi.doUnmock('@/lib/domain-monitor')
      vi.resetModules()
    }
  })

  it('caps in-process monitor matches at MAX_INPROCESS_MATCHES and warns once', async () => {
    vi.resetModules()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dm = {
      getActiveMonitors: vi.fn().mockResolvedValue([
        { id: 1, name: 'Broad', domains: ['example.com'], match_mode: 'both', is_active: true,
          created_by: null, last_triggered_at: null, total_alerts: 0,
          rescan_mode: 'dedup', rescan_interval_hours: 24, created_at: '', updated_at: '' },
      ]),
      fireMonitorAlertsFromMatches: vi.fn().mockResolvedValue(undefined),
    }
    vi.doMock('@/lib/domain-monitor', () => dm)

    try {
      const { processTextStream, MAX_INPROCESS_MATCHES } = await import('@/lib/upload-processor')
      const lines = Array.from(
        { length: MAX_INPROCESS_MATCHES + 50 },
        (_, i) => `https://example.com/login:user${i}@example.com:pw${i}`,
      ).join('\n') + '\n'

      const result = await processTextStream(
        Readable.toWeb(Readable.from([Buffer.from(lines)])) as ReadableStream<Uint8Array>,
        'match-cap.txt',
      )

      // All rows still import — the cap bounds monitor-match accumulation only,
      // never the ingest pipeline itself.
      expect(result.imported).toBe(MAX_INPROCESS_MATCHES + 50)
      expect(dm.fireMonitorAlertsFromMatches).toHaveBeenCalledOnce()
      const [, matches] = dm.fireMonitorAlertsFromMatches.mock.calls[0]
      expect(matches).toHaveLength(MAX_INPROCESS_MATCHES)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
      vi.doUnmock('@/lib/domain-monitor')
      vi.resetModules()
    }
  })
})

describe('import hooks: abort signal and heartbeat', () => {
  const oneLine = () =>
    Readable.toWeb(Readable.from([Buffer.from('https://example.com/login:user@example.com:mypassword\n')])) as ReadableStream<Uint8Array>

  it('rejects with the reason and imports nothing when the signal is already aborted', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    const controller = new AbortController()
    const reason = new Error('stalled before start')
    controller.abort(reason)

    await expect(
      processTextStream(oneLine(), 'aborted.txt', undefined, undefined, { signal: controller.signal })
    ).rejects.toBe(reason)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('beats after the source check and after each inserted batch', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    const beat = vi.fn()

    await processTextStream(oneLine(), 'beats.txt', undefined, undefined, { beat })

    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('cancels an insert in flight when the signal aborts, and rejects with the reason', async () => {
    const { processTextStream } = await import('@/lib/upload-processor')
    const controller = new AbortController()
    const reason = new Error('import stalled')
    h.insert.mockImplementationOnce(({ abort_signal }: { abort_signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        abort_signal.addEventListener('abort', () => reject(new Error('insert aborted')), { once: true })
      })
    )

    const promise = processTextStream(oneLine(), 'hang.txt', undefined, undefined, { signal: controller.signal })
    const rejection = expect(promise).rejects.toBe(reason)
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledTimes(1))
    controller.abort(reason)

    await rejection
  })
})

describe('processTextFile', () => {
  it('imports a file on disk through the same pipeline as a stream', async () => {
    const { processTextFile } = await import('@/lib/upload-processor')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-textfile-'))
    const file = path.join(dir, 'a.upload')
    fs.writeFileSync(file, 'https://example.com/login:user@example.com:mypassword\n')

    try {
      const result = await processTextFile(file, 'a.txt')

      expect(result.imported).toBe(1)
      expect(result.filename).toBe('a.txt')
      expect(h.insert).toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
