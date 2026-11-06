/**
 * The inbox watcher run for real against a temporary ./inbox, for the automatic retry of a file the run lost (lib/inbox-auto-retry.ts).
 * Only the import, the job log and the job-log lookup are replaced. The module reads ./inbox when it loads, so the test changes the working directory first.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportStalledError } from '@/lib/import-runner'

const h = vi.hoisted(() => ({
  processTextFile: vi.fn(),
  processZipFile: vi.fn(),
  processArchiveRef: vi.fn(),
  logJob: vi.fn(),
  consume: vi.fn(),
  latest: vi.fn(),
  schedule: vi.fn(),
}))

vi.mock('@/lib/upload-processor', () => ({ processTextFile: h.processTextFile, processZipFile: h.processZipFile, processArchiveRef: h.processArchiveRef }))
vi.mock('@/lib/processing-log', () => ({ logJob: h.logJob }))
vi.mock('@/lib/ingest-gate-store', () => ({ consumeGateOverride: h.consume }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: (fn: () => Promise<unknown>) => fn(), queueSize: () => 0, setCurrentJob: () => {} }))
vi.mock('@/lib/clickhouse-memory-guard', () => ({ waitForHeadroom: async () => {} }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: async () => {} }))
vi.mock('@/lib/inbox-auto-retry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inbox-auto-retry')>('@/lib/inbox-auto-retry')
  return { ...actual, latestJobRow: h.latest, scheduleAutoRetry: h.schedule }
})

let cwd: string
let root: string
let forceReconcile: () => number
let recoverInterruptedFiles: () => string[]

beforeAll(async () => {
  cwd = process.cwd()
  root = mkdtempSync(join(tmpdir(), 'watcher-auto-retry-'))
  process.chdir(root)
  ;({ forceReconcile, recoverInterruptedFiles } = await import('@/lib/inbox-watcher'))
})

afterAll(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
})

// __tests__/setup/ingest-novelty-off.ts switches the novelty check off for the old tests; a retry needs it on.
beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  for (const fn of Object.values(h)) fn.mockReset()
  h.consume.mockReturnValue(false)
  h.latest.mockReturnValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => { vi.unstubAllEnvs() })

const dir = (...p: string[]) => join(root, 'inbox', ...p)
const put = (sub: string, name: string) => { mkdirSync(dir(sub), { recursive: true }); writeFileSync(dir(sub, name), 'x\n') }
const logged = (name: string) => h.logJob.mock.calls.map(c => c[0]).filter(e => e.filename === name)
const settled = (name: string) => vi.waitFor(() => { if (logged(name).length === 0) throw new Error('not logged yet') }, { timeout: 10_000, interval: 100 })
const run = async (name: string) => { put('', name); forceReconcile(); await settled(name) }
const leftovers = (sub: string) => (existsSync(dir(sub)) ? readdirSync(dir(sub)) : [])

describe('inbox watcher: a failure during the import', () => {
  it('an interruption goes to failed/, is logged with the retry note, and is scheduled to come back once', async () => {
    h.processTextFile.mockRejectedValue(new ImportStalledError('stall-a.txt', 1_300_000))
    await run('stall-a.txt')
    expect(existsSync(dir('failed', 'stall-a.txt'))).toBe(true)
    expect(logged('stall-a.txt')).toEqual([expect.objectContaining({ status: 'failed', note: 'auto-retry', error_message: expect.stringMatching(/retrying automatically once/) })])
    expect(h.schedule).toHaveBeenCalledWith('stall-a.txt')
  })

  it('a second interruption of the same file stays in failed/ with no retry and no note', async () => {
    h.latest.mockReturnValue({ status: 'failed', note: 'auto-retry' })
    h.processTextFile.mockRejectedValue(new ImportStalledError('stall-b.txt', 1_300_000))
    await run('stall-b.txt')
    expect(existsSync(dir('failed', 'stall-b.txt'))).toBe(true)
    expect(logged('stall-b.txt')[0].note).toBeUndefined()
    expect(h.schedule).not.toHaveBeenCalled()
  })

  it('a failure that is about the file stays in failed/ with no retry', async () => {
    h.processTextFile.mockRejectedValue(new Error('cannot parse this archive reference'))
    await run('content-c.txt')
    expect(existsSync(dir('failed', 'content-c.txt'))).toBe(true)
    expect(logged('content-c.txt')[0].note).toBeUndefined()
    expect(h.schedule).not.toHaveBeenCalled()
  })

  it('with the novelty check off nothing is retried: a retry could double-write', async () => {
    vi.stubEnv('INGEST_NOVELTY_CHECK', 'off')
    h.processTextFile.mockRejectedValue(new ImportStalledError('stall-d.txt', 1_300_000))
    await run('stall-d.txt')
    expect(h.schedule).not.toHaveBeenCalled()
    expect(logged('stall-d.txt')[0].note).toBeUndefined()
  })
})

describe('inbox watcher: files an earlier run left in processing/', () => {
  it('goes back to the inbox once: logged as failed with the retry note, and not left in failed/', () => {
    put('processing', 'left-e.txt')
    expect(recoverInterruptedFiles()).toEqual(['left-e.txt'])
    expect(leftovers('processing')).not.toContain('left-e.txt')
    expect(existsSync(dir('left-e.txt'))).toBe(true)
    expect(existsSync(dir('failed', 'left-e.txt'))).toBe(false)
    expect(logged('left-e.txt')).toEqual([expect.objectContaining({ status: 'failed', note: 'auto-retry', error_message: expect.stringMatching(/Retrying automatically once/) })])
  })

  it('stays in failed/ when its latest job row is the one that already scheduled a retry', () => {
    h.latest.mockReturnValue({ status: 'failed', note: 'auto-retry' })
    put('processing', 'left-f.txt')
    expect(recoverInterruptedFiles()).toEqual(['left-f.txt'])
    expect(existsSync(dir('failed', 'left-f.txt'))).toBe(true)
    expect(existsSync(dir('left-f.txt'))).toBe(false)
    expect(logged('left-f.txt')[0].note).toBeUndefined()
    expect(logged('left-f.txt')[0].error_message).toMatch(/again after an automatic retry/)
  })
})
