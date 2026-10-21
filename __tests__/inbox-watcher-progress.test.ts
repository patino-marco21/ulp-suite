/**
 * The progress of the files being imported, with the inbox watcher run for real against a temporary ./inbox and an unlimited queue (two lanes at once). The
 * watcher kept ONE progress record: the second file replaced the first one's, and whichever finished first cleared the other's while it was still running.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ processTextFile: vi.fn(), processZipFile: vi.fn(), processArchiveRef: vi.fn(), logJob: vi.fn() }))

vi.mock('@/lib/upload-processor', () => ({ processTextFile: h.processTextFile, processZipFile: h.processZipFile, processArchiveRef: h.processArchiveRef }))
vi.mock('@/lib/processing-log', () => ({ logJob: h.logJob }))
vi.mock('@/lib/ingest-gate-store', () => ({ consumeGateOverride: () => false }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: (fn: () => Promise<unknown>) => fn(), queueSize: () => 0, setCurrentJob: () => {} }))
vi.mock('@/lib/clickhouse-memory-guard', () => ({ waitForHeadroom: async () => {} }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: async () => {} }))

const OK = { imported: 5, known: 1, inFileDuplicates: 0, skipped: 2, errors: 0, filename: 'x', breach_name: 'b', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0 }

let cwd: string
let root: string
let forceReconcile: () => number
let getInboxJobsProgress: () => Array<{ filename: string; rows_staged?: number; file_size_bytes: number; readBytes?: () => number }>
let getInboxJobProgress: () => { filename: string } | null

beforeAll(async () => {
  cwd = process.cwd()
  root = mkdtempSync(join(tmpdir(), 'watcher-progress-'))
  process.chdir(root)
  ;({ forceReconcile, getInboxJobsProgress, getInboxJobProgress } = await import('@/lib/inbox-watcher') as never)
})

afterAll(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const drop = (name: string, body: string) => {
  mkdirSync(join(root, 'inbox'), { recursive: true })
  writeFileSync(join(root, 'inbox', name), body)
}
const names = () => getInboxJobsProgress().map(p => p.filename).sort()
const logged = (name: string) => h.logJob.mock.calls.map(c => c[0]).filter(e => e.filename === name)

describe('inbox watcher: progress of files imported at the same time', () => {
  it('keeps one record per file, each with its own rows and byte counter, and drops a record only when its own file is done', async () => {
    const finish = new Map<string, () => void>()
    h.processTextFile.mockImplementation((_path: string, filename: string, _jobId: unknown, _onBatch: unknown, hooks: {
      onSourceBytes?: (read: () => number) => void
      onImportProgress?: (e: unknown) => void
    }) => new Promise(resolve => {
      const staged = filename === 'lane-a.txt' ? 100 : 200
      hooks.onSourceBytes?.(() => staged * 10)
      hooks.onImportProgress?.({ phase: 'parsing', staged, skipped: 0, known: 0, inserted: 0 })
      finish.set(filename, () => resolve(OK))
    }))

    drop('lane-a.txt', 'a\n'.repeat(5))
    drop('lane-b.txt', 'b\n'.repeat(7))
    forceReconcile()
    await vi.waitFor(() => { if (getInboxJobsProgress().length !== 2) throw new Error('two files are not in flight yet') }, { timeout: 10_000, interval: 50 })

    expect(names()).toEqual(['lane-a.txt', 'lane-b.txt'])
    const byName = new Map(getInboxJobsProgress().map(p => [p.filename, p]))
    expect(byName.get('lane-a.txt')).toMatchObject({ rows_staged: 100, file_size_bytes: 10 })
    expect(byName.get('lane-b.txt')).toMatchObject({ rows_staged: 200, file_size_bytes: 14 })
    expect(byName.get('lane-a.txt')?.readBytes?.()).toBe(1000)
    expect(byName.get('lane-b.txt')?.readBytes?.()).toBe(2000)

    finish.get('lane-a.txt')?.()
    await vi.waitFor(() => { if (logged('lane-a.txt').length === 0) throw new Error('lane-a is not finished yet') }, { timeout: 10_000, interval: 50 })
    expect(names()).toEqual(['lane-b.txt'])               // the first file finishing must not clear the second one's progress
    expect(getInboxJobProgress()?.filename).toBe('lane-b.txt')

    finish.get('lane-b.txt')?.()
    await vi.waitFor(() => { if (logged('lane-b.txt').length === 0) throw new Error('lane-b is not finished yet') }, { timeout: 10_000, interval: 50 })
    expect(names()).toEqual([])
    expect(getInboxJobProgress()).toBeNull()
  })

  it('reports the size of the plaintext, not of the reference file, for a file imported from the archive', async () => {
    let seen: { file_size_bytes: number } | undefined
    h.processArchiveRef.mockImplementation(async () => {
      seen = getInboxJobsProgress().find(p => p.filename === 'size-check.txt.archiveref')
      return OK
    })
    const ref = JSON.stringify({ v: 1, id: 'c'.repeat(24), name: 'size-check.txt', size: 4_179_309_020, sha256: 'c'.repeat(64) })
    drop('size-check.txt.archiveref', ref + '\n')
    forceReconcile()
    await vi.waitFor(() => { if (logged('size-check.txt.archiveref').length === 0) throw new Error('not finished yet') }, { timeout: 10_000, interval: 50 })
    expect(seen?.file_size_bytes).toBe(4_179_309_020)
  })
})
