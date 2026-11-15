/**
 * The inbox takes plain text only (owner rule 2026-11-14: archives and similar containers carry a much higher risk of malware). The watcher runs for real against a
 * temporary ./inbox, as in inbox-watcher-held.test.ts: only the import itself, the job log and the override store are replaced.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  processTextFile: vi.fn(),
  processArchiveRef: vi.fn(),
  logJob: vi.fn(),
  consume: vi.fn(),
}))

vi.mock('@/lib/upload-processor', () => ({ processTextFile: h.processTextFile, processArchiveRef: h.processArchiveRef }))
vi.mock('@/lib/processing-log', () => ({ logJob: h.logJob }))
vi.mock('@/lib/ingest-gate-store', () => ({ consumeGateOverride: h.consume }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: (fn: () => Promise<unknown>) => fn(), queueSize: () => 0, setCurrentJob: () => {} }))
vi.mock('@/lib/clickhouse-memory-guard', () => ({ waitForHeadroom: async () => {} }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: async () => {} }))

const OK = { imported: 5, known: 1, inFileDuplicates: 0, skipped: 2, errors: 0, filename: 'x', breach_name: 'b', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0 }
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])

let cwd: string
let root: string
let forceReconcile: () => number

beforeAll(async () => {
  cwd = process.cwd()
  root = mkdtempSync(join(tmpdir(), 'watcher-txt-only-'))
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
const logged = (name: string) => h.logJob.mock.calls.map(c => c[0]).filter(e => e.filename === name)
const settled = (name: string) => vi.waitFor(() => { if (logged(name).length === 0) throw new Error('not logged yet') }, { timeout: 10_000, interval: 100 })
const run = async (name: string, body: string | Buffer = 'x\n') => {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(dir(name), body)
  forceReconcile()
  await settled(name)
}

describe('inbox watcher: plain text only', () => {
  it('refuses a .zip: it goes to failed/ with the reason, and no importer sees it', async () => {
    await run('pack.zip', ZIP_MAGIC)
    expect(existsSync(dir('failed', 'pack.zip'))).toBe(true)
    expect(existsSync(dir('pack.zip'))).toBe(false)
    expect(logged('pack.zip')).toEqual([expect.objectContaining({ status: 'failed', imported: 0, error_message: expect.stringContaining('Only .txt') })])
    expect(h.processTextFile).not.toHaveBeenCalled()
  })

  it('refuses a .csv even though its content is text', async () => {
    await run('table.csv', 'a:b\nc:d\n')
    expect(existsSync(dir('failed', 'table.csv'))).toBe(true)
    expect(logged('table.csv')[0]).toMatchObject({ status: 'failed', error_message: expect.stringContaining('Only .txt') })
    expect(h.processTextFile).not.toHaveBeenCalled()
  })

  it('refuses other container extensions without looking inside', async () => {
    await run('loot.rar', 'plain text that merely carries a container name\n')
    expect(existsSync(dir('failed', 'loot.rar'))).toBe(true)
    expect(logged('loot.rar')[0]).toMatchObject({ status: 'failed', error_message: expect.stringContaining('Only .txt') })
    expect(h.processTextFile).not.toHaveBeenCalled()
  })

  it('refuses a ZIP hiding under a date-fragment name instead of importing it as a ZIP', async () => {
    await run('dump - 29.04.2026 - ULP PRIVATE.08', ZIP_MAGIC)
    expect(existsSync(dir('failed', 'dump - 29.04.2026 - ULP PRIVATE.08'))).toBe(true)
    expect(logged('dump - 29.04.2026 - ULP PRIVATE.08')[0]).toMatchObject({ status: 'failed', error_message: expect.stringContaining('Only .txt') })
    expect(h.processTextFile).not.toHaveBeenCalled()
  })

  it('still imports a text file whose name carries a date fragment instead of an extension', async () => {
    h.processTextFile.mockResolvedValue(OK)
    await run('dump - 29.04.2026 - ULP PRIVATE.09', 'https://a.test:u:p\n')
    expect(h.processTextFile).toHaveBeenCalledTimes(1)
    expect(existsSync(dir('done', 'dump - 29.04.2026 - ULP PRIVATE.09'))).toBe(true)
  })

  it('still imports a plain .txt', async () => {
    h.processTextFile.mockResolvedValue(OK)
    await run('plain.txt', 'https://a.test:u:p\n')
    expect(h.processTextFile).toHaveBeenCalledTimes(1)
    expect(existsSync(dir('done', 'plain.txt'))).toBe(true)
  })
})
