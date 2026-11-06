import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn(),
  createStage: vi.fn(),
  dropStage: vi.fn(),
  registerStage: vi.fn(),
  unregisterStage: vi.fn(),
  commitStage: vi.fn(),
  updateJob: vi.fn(),
  stageInWorker: vi.fn(),
}))
const dm = vi.hoisted(() => ({ getActiveMonitors: vi.fn(), fireMonitorAlertsFromMatches: vi.fn() }))

vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/domain-monitor', () => dm)
vi.mock('@/lib/upload-jobs', () => ({ updateJob: h.updateJob }))
vi.mock('@/lib/ingest-novelty', () => ({ commitStage: h.commitStage }))
vi.mock('@/lib/ingest-stage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest-stage')>('@/lib/ingest-stage')
  return { ...actual, createStage: h.createStage, dropStage: h.dropStage, registerStage: h.registerStage, unregisterStage: h.unregisterStage }
})
vi.mock('@/lib/ingest-pool', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest-pool')>('@/lib/ingest-pool')
  return { ...actual, stageInWorker: h.stageInWorker }
})

import { IngestHeldError, newGateCounters } from '@/lib/ingest-quality-gate'
import { MIN_WORKER_FILE_BYTES, WorkerUnavailableError } from '@/lib/ingest-pool'
import { processTextStream } from '@/lib/upload-processor'

const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const textOf = (n: number) => Array.from({ length: n }, (_, i) => cleanLine(i)).join('\n') + '\n'
const stream = (text: string) => Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>
const BIG = MIN_WORKER_FILE_BYTES + 1
const WORKER_RESULT = { imported: 900, skipped: 100, tierDropped: 0, rejection_breakdown: { no_fields: 100 } }
const workerOutcome = (gate = null as ReturnType<typeof newGateCounters> | null) => ({ result: WORKER_RESULT, gate, timings: { parseMs: 11, insertMs: 22 } })

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_PARSE_WORKERS', '2')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue({ rows: 900, distinct: 900, known: 100, inserted: 800, inFileDuplicates: 0, slabs: 1, matches: [], checkMs: 3, commitMs: 4 })
  h.stageInWorker.mockResolvedValue(workerOutcome())
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const insertedTables = () => h.insert.mock.calls.map(c => c[0].table as string)

describe('staging in a parse worker', () => {
  it('hands a big plain file to the worker, parses nothing on this thread, and commits what the worker staged', async () => {
    const out = await processTextStream(stream(textOf(10)), 'big.txt', 'job-1', undefined, { stageFile: '/inbox/processing/big.txt', fileSize: BIG })
    expect(h.stageInWorker).toHaveBeenCalledTimes(1)
    const job = h.stageInWorker.mock.calls[0][0]
    expect(job).toMatchObject({ path: '/inbox/processing/big.txt', filename: 'big.txt', filterOn: false, gateOverride: false, batchSize: 100_000 })
    expect(job.table).toBe(h.createStage.mock.calls[0][0].stage)
    expect(insertedTables()).not.toContain(job.table)   // nothing was parsed or inserted on this thread
    expect(h.commitStage.mock.calls[0][0]).toMatchObject({ parsedRows: 900 })
    expect(out).toMatchObject({ imported: 800, known: 100, skipped: 100 })
    expect(out.timings).toEqual({ parse_ms: 11, check_ms: 3, insert_ms: 22 + 4 })
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    // docker logs must show which files a worker staged (the production build strips console.log)
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]) === '[upload-processor] big.txt: staged in a parse worker')).toBe(true)
  })

  it('passes a released file to the worker as gateOverride', async () => {
    await processTextStream(stream(textOf(10)), 'big.txt', undefined, undefined, { stageFile: '/p/big.txt', fileSize: BIG, gateOverride: true })
    expect(h.stageInWorker.mock.calls[0][0].gateOverride).toBe(true)
  })

  it('forwards the worker\'s beats and progress to the job, and its bytes to the source-bytes getter', async () => {
    const beat = vi.fn()
    let bytes: (() => number) | undefined
    h.stageInWorker.mockImplementation(async (_job: unknown, cb: { onBeat: () => void; onProgress: (a: number, b: number, c: number) => void }) => {
      cb.onBeat()
      cb.onProgress(500, 50, 7777)
      return workerOutcome()
    })
    await processTextStream(stream(textOf(10)), 'big.txt', 'job-2', undefined, { stageFile: '/p/big.txt', fileSize: BIG, beat, onSourceBytes: g => { bytes = g } })
    expect(beat).toHaveBeenCalled()
    expect(h.updateJob).toHaveBeenCalledWith('job-2', expect.objectContaining({ phase: 'parsing', staged: 500, skipped: 50 }))
    expect(bytes?.()).toBe(7777)
  })

  it('gives the worker the job\'s abort signal', async () => {
    const controller = new AbortController()
    await processTextStream(stream(textOf(10)), 'big.txt', undefined, undefined, { stageFile: '/p/big.txt', fileSize: BIG, signal: controller.signal })
    expect(h.stageInWorker.mock.calls[0][2]).toMatchObject({ signal: controller.signal })
  })

  it('runs the final gate check on the worker\'s counters: a bad file is held after the worker is done, with nothing committed', async () => {
    const gate = newGateCounters()
    Object.assign(gate, { lines: 1_000, stored: 1_000, junk: 1_000, kinds: { 'password-has-scheme': 1_000 } })
    h.stageInWorker.mockResolvedValue(workerOutcome(gate))
    const err = await processTextStream(stream(textOf(10)), 'big.txt', undefined, undefined, { stageFile: '/p/big.txt', fileSize: BIG }).catch(e => e)
    expect(err.name).toBe('IngestHeldError')
    expect(err.report).toMatchObject({ phase: 'final', level: 'hold', junk: 1_000 })
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
  })

  it('a hold the worker raises (the early check) fails the file, logs the verdict, drops the stage and commits nothing', async () => {
    const report = { v: 1, phase: 'early', level: 'hold', reasons: ['8.00% of the lines cannot be split'], lines: 1_037_662, stored: 800_000, junk: 0, noFields: 83_000, noPassword: 0, garbage: 0, tierDropped: 0, gateErrors: 0, junkPct: 0, unsplitPct: 8, garbagePct: 0, kinds: {}, shapes: [], thresholds: {} }
    h.stageInWorker.mockRejectedValue(new IngestHeldError(report as never))
    await expect(processTextStream(stream(textOf(10)), 'big.txt', undefined, undefined, { stageFile: '/p/big.txt', fileSize: BIG })).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('[quality-gate] big.txt'))).toBe(true)
  })

  it('a worker error fails the file and still drops its stage', async () => {
    h.stageInWorker.mockRejectedValue(new Error('the parse worker exited with code 1 before it was done'))
    await expect(processTextStream(stream(textOf(10)), 'big.txt', undefined, undefined, { stageFile: '/p/big.txt', fileSize: BIG })).rejects.toThrow(/exited with code 1/)
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
  })

  it('falls back to this thread when the worker bundle is missing, and says so', async () => {
    h.stageInWorker.mockRejectedValue(new WorkerUnavailableError('/app/dist/ingest-worker.cjs'))
    const out = await processTextStream(stream(textOf(1_000)), 'big.txt', undefined, undefined, { stageFile: '/p/big.txt', fileSize: BIG })
    expect(out.imported).toBe(800)
    expect(insertedTables().some(t => t.includes('stage'))).toBe(true)   // parsed and staged here
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('parse worker'))).toBe(true)
  })
})

describe('when the worker is not used', () => {
  const inProcess = async (hooks: object, env?: Record<string, string>) => {
    for (const [k, v] of Object.entries(env ?? {})) vi.stubEnv(k, v)
    const out = await processTextStream(stream(textOf(1_000)), 'f.txt', undefined, undefined, hooks)
    expect(h.stageInWorker).not.toHaveBeenCalled()
    expect(out.imported).toBe(800)
    expect(insertedTables().some(t => t.includes('stage'))).toBe(true)
  }

  it('a file under the size that earns a worker is staged on this thread', async () => {
    await inProcess({ stageFile: '/p/f.txt', fileSize: MIN_WORKER_FILE_BYTES - 1 })
  })

  it('a stream with no file behind it (a ZIP entry, an HTTP stream, an archive reference) is staged on this thread', async () => {
    await inProcess({ fileSize: BIG })
  })

  it('INGEST_PARSE_WORKERS unset or 0 keeps the in-process path', async () => {
    await inProcess({ stageFile: '/p/f.txt', fileSize: BIG }, { INGEST_PARSE_WORKERS: '0' })
  })
})
