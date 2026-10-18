/**
 * The inbox watcher run for real against a temporary ./inbox: only the import itself, the job log and the override store are replaced.
 * The module reads ./inbox when it loads, so the test changes the working directory first.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IngestHeldError, type GateReport } from '@/lib/ingest-quality-gate'

const h = vi.hoisted(() => ({
  processTextFile: vi.fn(),
  processZipFile: vi.fn(),
  processArchiveRef: vi.fn(),
  logJob: vi.fn(),
  consume: vi.fn(),
}))

vi.mock('@/lib/upload-processor', () => ({ processTextFile: h.processTextFile, processZipFile: h.processZipFile, processArchiveRef: h.processArchiveRef }))
vi.mock('@/lib/processing-log', () => ({ logJob: h.logJob }))
vi.mock('@/lib/ingest-gate-store', () => ({ consumeGateOverride: h.consume }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: (fn: () => Promise<unknown>) => fn(), queueSize: () => 0, setCurrentJob: () => {} }))
vi.mock('@/lib/clickhouse-memory-guard', () => ({ waitForHeadroom: async () => {} }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: async () => {} }))

const REPORT = {
  v: 1, phase: 'final', level: 'hold', reasons: ['10.00% of the stored rows break a rule (limit 2%)'],
  lines: 30_000, stored: 30_000, junk: 3_000, noFields: 0, noPassword: 0, garbage: 0, tierDropped: 0, gateErrors: 0,
  junkPct: 10, unsplitPct: 0, garbagePct: 0, kinds: { 'login-has-colon': 3_000 }, shapes: [],
  thresholds: { minLines: 20_000, holdJunkPct: 2, holdUnsplitPct: 5, holdGarbagePct: 25, warnJunkPct: 1, warnUnsplitPct: 2 },
} as GateReport

const OK = { imported: 5, known: 1, inFileDuplicates: 0, skipped: 2, errors: 0, filename: 'x', breach_name: 'b', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0 }

let cwd: string
let root: string
let forceReconcile: () => number

beforeAll(async () => {
  cwd = process.cwd()
  root = mkdtempSync(join(tmpdir(), 'watcher-held-'))
  process.chdir(root)
  ;({ forceReconcile } = await import('@/lib/inbox-watcher'))
})

afterAll(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.consume.mockReturnValue(false)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const dir = (...p: string[]) => join(root, 'inbox', ...p)
const drop = (name: string, body = 'x\n') => {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(dir(name), body)
}
const logged = (name: string) => h.logJob.mock.calls.map(c => c[0]).filter(e => e.filename === name)
const settled = (name: string) => vi.waitFor(() => { if (logged(name).length === 0) throw new Error('not logged yet') }, { timeout: 10_000, interval: 100 })
const run = async (name: string, body?: string) => {
  drop(name, body)
  forceReconcile()
  await settled(name)
}

describe('inbox watcher: held files', () => {
  it('moves a file the quality gate held to inbox/held/ and logs it as held with its report', async () => {
    h.processTextFile.mockRejectedValue(new IngestHeldError(REPORT))
    await run('held-a.txt')
    expect(existsSync(dir('held', 'held-a.txt'))).toBe(true)
    expect(existsSync(dir('failed', 'held-a.txt'))).toBe(false)
    expect(existsSync(dir('processing', 'held-a.txt'))).toBe(false)
    expect(existsSync(dir('held-a.txt'))).toBe(false)
    expect(logged('held-a.txt')).toEqual([expect.objectContaining({
      source: 'inbox', status: 'held', gate_report: JSON.stringify(REPORT), error_message: expect.stringContaining('Held by the quality gate'),
    })])
  })

  it('holds a ZIP the same way', async () => {
    h.processZipFile.mockRejectedValue(new IngestHeldError(REPORT))
    await run('held-b.zip')
    expect(existsSync(dir('held', 'held-b.zip'))).toBe(true)
    expect(logged('held-b.zip')[0]).toMatchObject({ status: 'held' })
  })

  it('still sends an ordinary failure to inbox/failed/', async () => {
    h.processTextFile.mockRejectedValue(new Error('boom'))
    await run('failed-a.txt')
    expect(existsSync(dir('failed', 'failed-a.txt'))).toBe(true)
    expect(existsSync(dir('held', 'failed-a.txt'))).toBe(false)
    expect(logged('failed-a.txt')[0]).toMatchObject({ status: 'failed', error_message: 'boom' })
  })

  it('consumes a release when it claims the file and hands it to the import as gateOverride', async () => {
    h.consume.mockImplementation((name: string) => name === 'released-a.txt')
    h.processTextFile.mockResolvedValue(OK)
    await run('released-a.txt')
    expect(h.consume).toHaveBeenCalledWith('released-a.txt')
    expect(h.processTextFile.mock.calls[0][4]).toMatchObject({ gateOverride: true })
    expect(existsSync(dir('done', 'released-a.txt'))).toBe(true)
  })

  it('does not release a file nobody released', async () => {
    h.processTextFile.mockResolvedValue(OK)
    await run('plain-a.txt')
    expect(h.processTextFile.mock.calls[0][4].gateOverride).toBe(false)
  })

  it('records the gate report of a file that was imported with a warning', async () => {
    h.processTextFile.mockResolvedValue({ ...OK, gate: { ...REPORT, level: 'warn' } })
    await run('warned-a.txt')
    expect(logged('warned-a.txt')[0]).toMatchObject({ status: 'done', gate_report: JSON.stringify({ ...REPORT, level: 'warn' }) })
  })
})

describe('inbox watcher: phase timings', () => {
  it('logs the phase timings of a text file', async () => {
    h.processTextFile.mockResolvedValue({ ...OK, timings: { parse_ms: 11, check_ms: 22, insert_ms: 33 } })
    await run('timed-a.txt')
    expect(logged('timed-a.txt')[0]).toMatchObject({ status: 'done', parse_ms: 11, check_ms: 22, insert_ms: 33 })
  })

  it('adds up the phase timings of the entries of a ZIP', async () => {
    h.processZipFile.mockImplementation(async (_path: string, onEntry: (r: unknown) => void) => {
      onEntry({ ...OK, filename: 'a.txt', timings: { parse_ms: 10, check_ms: 20, insert_ms: 30 } })
      onEntry({ ...OK, filename: 'b.txt', timings: { parse_ms: 1, check_ms: 2, insert_ms: 3 } })
    })
    await run('timed-b.zip')
    expect(logged('timed-b.zip')[0]).toMatchObject({ status: 'done', imported: 10, parse_ms: 11, check_ms: 22, insert_ms: 33 })
  })

  it('logs a file without timings (the direct path) as before, with none of the three', async () => {
    h.processTextFile.mockResolvedValue(OK)
    await run('timed-c.txt')
    expect(logged('timed-c.txt')[0]).toMatchObject({ status: 'done', imported: 5 })
    expect(logged('timed-c.txt')[0].parse_ms ?? 0).toBe(0)
  })
})

describe('inbox watcher: .archiveref files', () => {
  it('imports the reference through processArchiveRef and keeps only the reference in done/', async () => {
    h.processArchiveRef.mockResolvedValue(OK)
    const ref = JSON.stringify({ v: 1, id: 'a'.repeat(24), name: 'original-name.txt', size: 3, sha256: 'a'.repeat(64) })
    await run('original-name.txt.archiveref', ref + '\n')
    expect(h.processArchiveRef).toHaveBeenCalledTimes(1)
    expect(h.processArchiveRef.mock.calls[0][0]).toBe(dir('processing', 'original-name.txt.archiveref'))
    expect(existsSync(dir('done', 'original-name.txt.archiveref'))).toBe(true)
    expect(existsSync(dir('done', 'original-name.txt'))).toBe(false)
    expect(logged('original-name.txt.archiveref')[0]).toMatchObject({ status: 'done', imported: 5, known: 1, skipped: 2 })
  })

  it('a reference that fails goes to failed/ like any file', async () => {
    h.processArchiveRef.mockRejectedValue(new Error('archive abc failed its sha256 check'))
    await run('bad.txt.archiveref', '{}\n')
    expect(existsSync(dir('failed', 'bad.txt.archiveref'))).toBe(true)
    expect(logged('bad.txt.archiveref')[0]).toMatchObject({ status: 'failed', error_message: 'archive abc failed its sha256 check' })
  })
})
