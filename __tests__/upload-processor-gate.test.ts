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
}))
const dm = vi.hoisted(() => ({
  getActiveMonitors: vi.fn(),
  fireMonitorAlertsFromMatches: vi.fn(),
}))

vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/domain-monitor', () => dm)
vi.mock('@/lib/upload-jobs', () => ({ updateJob: h.updateJob }))
vi.mock('@/lib/ingest-novelty', () => ({ commitStage: h.commitStage }))
vi.mock('@/lib/ingest-stage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest-stage')>('@/lib/ingest-stage')
  return { ...actual, createStage: h.createStage, dropStage: h.dropStage, registerStage: h.registerStage, unregisterStage: h.unregisterStage }
})

import type { Source } from '@/lib/source-archive'
import { processTextStream } from '@/lib/upload-processor'

// The current parser stores "Pw://x" as a password, which the gate counts as a row that breaks a rule (password-has-scheme).
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
const stream = (text: string) => Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>
const insertedTables = () => h.insert.mock.calls.map(c => c[0].table as string)

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue({ rows: 1000, distinct: 1000, known: 0, inserted: 1000, inFileDuplicates: 0, slabs: 1, matches: [] })
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the quality gate in the staged import', () => {
  it('holds a file whose rows break the rules: nothing is committed, the stage is dropped, ulp.credentials and ulp.sources are untouched', async () => {
    await expect(processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(insertedTables()).not.toContain('ulp.credentials')
    expect(insertedTables()).not.toContain('ulp.sources')
  })

  it('puts the numbers in the error, not the lines', async () => {
    const err = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt').catch(e => e)
    expect(err.report).toMatchObject({ phase: 'final', level: 'hold', lines: 1_000, stored: 1_000, junk: 1_000, junkPct: 100 })
    expect(err.report.kinds).toEqual({ 'password-has-scheme': 1_000 })
    expect(JSON.stringify(err.report)).not.toContain('example.test')
  })

  it('stores a clean file and returns no gate report', async () => {
    const out = await processTextStream(stream(textOf(1_000, cleanLine)), 'clean.txt')
    expect(out.imported).toBe(1_000)
    expect(out.gate).toBeUndefined()
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('imports a released file anyway and keeps the report on the result', async () => {
    const out = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt', undefined, undefined, { gateOverride: true })
    expect(h.commitStage).toHaveBeenCalledTimes(1)
    expect(out.gate).toMatchObject({ level: 'hold', junk: 1_000 })
  })

  it('INGEST_QUALITY_GATE=warn reports and imports; =off does not even count', async () => {
    vi.stubEnv('INGEST_QUALITY_GATE', 'warn')
    const warned = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')
    expect(warned.gate).toMatchObject({ level: 'warn' })
    expect(h.commitStage).toHaveBeenCalledTimes(1)

    h.commitStage.mockClear()
    vi.stubEnv('INGEST_QUALITY_GATE', 'off')
    const off = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')
    expect(off.gate).toBeUndefined()
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('holds early: a large bad file is stopped after the first batch, before one row is staged', async () => {
    vi.stubEnv('INGEST_QUALITY_GATE_EARLY_LINES', '50000')
    await expect(processTextStream(stream(textOf(250_000, junkLine)), 'big-junk.txt')).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(insertedTables()).toEqual([])
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('runs beforeCommit after the whole file was read and BEFORE the final gate check: a failed integrity check wins over a hold', async () => {
    const beforeCommit = vi.fn().mockRejectedValue(new Error('archive failed its sha256 check'))
    await expect(processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt', undefined, undefined, { beforeCommit })).rejects.toThrow('archive failed its sha256 check')
    expect(beforeCommit).toHaveBeenCalledTimes(1)
    expect(h.commitStage).not.toHaveBeenCalled()
  })

  it('calls beforeCommit once for a good file, then commits', async () => {
    const order: string[] = []
    const beforeCommit = vi.fn(async () => { order.push('beforeCommit') })
    h.commitStage.mockImplementation(async () => {
      order.push('commit')
      return { rows: 1000, distinct: 1000, known: 0, inserted: 1000, inFileDuplicates: 0, slabs: 1, matches: [] }
    })
    await processTextStream(stream(textOf(1_000, cleanLine)), 'clean.txt', undefined, undefined, { beforeCommit })
    expect(order).toEqual(['beforeCommit', 'commit'])
  })
})

describe('the sample check in the staged import', () => {
  // A source the size of a big file that reads as the same lines everywhere, without a big file on the disk: every slice the check asks for is 3,000 lines.
  const bigSource = (line: (i: number) => string): Source & { readSlice: ReturnType<typeof vi.fn> } => ({
    name: 'big.txt', size: 50_000_000, origin: { kind: 'file', path: '/nowhere/big.txt' },
    stream: () => { throw new Error('the check reads slices, not the stream') },
    readSlice: vi.fn(async () => Buffer.from(textOf(3_000, line))),
    readAll: async () => { throw new Error('the check does not read the whole file') },
  })
  const cleanFile = () => stream(textOf(1_000, cleanLine))

  it('holds a big file whose slices are junk before a stage table exists, whatever the stream says', async () => {
    const source = bigSource(junkLine)
    const err = await processTextStream(cleanFile(), 'big.txt', undefined, undefined, { sampleSource: source }).catch(e => e)
    expect(err).toMatchObject({ name: 'IngestHeldError', report: { phase: 'sample', level: 'hold', junkPct: 100 } })
    expect(err.report.kinds).toEqual({ 'password-has-scheme': err.report.junk }) // the sample's rows: the whole lines of five slices, not the 1,000 of the stream
    expect(h.registerStage).not.toHaveBeenCalled()
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(insertedTables()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[quality-gate] big.txt: hold (sample)'))
  })

  it('goes on to the import when the slices are clean', async () => {
    const out = await processTextStream(cleanFile(), 'big.txt', undefined, undefined, { sampleSource: bigSource(cleanLine) })
    expect(out.imported).toBe(1_000)
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('does not read a slice for a released file, for the warn and off modes, or when there is no source', async () => {
    const source = bigSource(junkLine)
    await processTextStream(cleanFile(), 'big.txt', undefined, undefined, { sampleSource: source, gateOverride: true })
    vi.stubEnv('INGEST_QUALITY_GATE', 'warn')
    await processTextStream(cleanFile(), 'big.txt', undefined, undefined, { sampleSource: source })
    vi.stubEnv('INGEST_QUALITY_GATE', 'off')
    await processTextStream(cleanFile(), 'big.txt', undefined, undefined, { sampleSource: source })
    vi.stubEnv('INGEST_QUALITY_GATE', 'hold')
    await processTextStream(cleanFile(), 'big.txt')
    expect(source.readSlice).not.toHaveBeenCalled()
    expect(h.commitStage).toHaveBeenCalledTimes(4)
  })

  it('beats the heartbeat around the check, so a slow disk does not look like a stalled job', async () => {
    const beat = vi.fn()
    await processTextStream(cleanFile(), 'big.txt', undefined, undefined, { sampleSource: bigSource(cleanLine), beat })
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the quality gate on the direct path (INGEST_NOVELTY_CHECK=off)', () => {
  it('only warns: the rows are inserted as they are parsed, so there is nothing left to hold', async () => {
    vi.stubEnv('INGEST_NOVELTY_CHECK', 'off')
    const out = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')
    expect(out.imported).toBe(1_000)
    expect(insertedTables()).toContain('ulp.credentials')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[quality-gate] junk.txt'))
  })
})
