import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
const dm = vi.hoisted(() => ({ getActiveMonitors: vi.fn(), fireMonitorAlertsFromMatches: vi.fn() }))

vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/domain-monitor', () => dm)
vi.mock('@/lib/upload-jobs', () => ({ updateJob: h.updateJob }))
vi.mock('@/lib/ingest-novelty', () => ({ commitStage: h.commitStage }))
vi.mock('@/lib/ingest-stage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest-stage')>('@/lib/ingest-stage')
  return { ...actual, createStage: h.createStage, dropStage: h.dropStage, registerStage: h.registerStage, unregisterStage: h.unregisterStage }
})

import { appendManifest, archiveFile } from '@/lib/source-archive'
import { serializeArchiveRef } from '@/lib/archive-ref'
import { processArchiveRef } from '@/lib/upload-processor'

const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
const COMMIT = { rows: 300, distinct: 300, known: 0, inserted: 300, inFileDuplicates: 0, slabs: 1, matches: [] }

let root: string
let archiveDir: string

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-ref-import-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  archiveDir = mkdtempSync(join(root, 'arc-'))
  vi.stubEnv('ULP_ARCHIVE_DIR', archiveDir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue(COMMIT)
  dm.getActiveMonitors.mockReset().mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Archives a synthetic file (small frames, so the stream crosses several) and writes its reference next to it. */
function archived(name: string, text = textOf(300, cleanLine)) {
  const src = join(root, `src-${name}`)
  writeFileSync(src, text)
  const entry = archiveFile(src, { archiveDir, name, frameBytes: 4096, searchBytes: 512 })
  appendManifest(archiveDir, entry)
  const refPath = join(root, `${name}.archiveref`)
  writeFileSync(refPath, serializeArchiveRef(entry))
  return { entry, refPath }
}
const sourcesInsert = () => h.insert.mock.calls.map(c => c[0]).find(c => c.table === 'ulp.sources')

describe('processArchiveRef', () => {
  it('imports the file from the archive: the parser sees every line, the commit runs, and ulp.sources gets the original name and the identity', async () => {
    const { entry, refPath } = archived('arch-a.txt')
    const out = await processArchiveRef(refPath)
    expect(out).toMatchObject({ imported: 300, filename: 'arch-a.txt', alreadyImported: false })
    expect(h.commitStage.mock.calls[0][0]).toMatchObject({ parsedRows: 300 })
    expect(sourcesInsert().values).toEqual([{ filename: 'arch-a.txt', line_count: 300, size: entry.size, sha256: entry.sha256, archive_id: entry.id }])
  })

  it('asks the duplicate guard about the original name AND the content hash', async () => {
    const { entry, refPath } = archived('arch-b.txt')
    await processArchiveRef(refPath)
    expect(h.query.mock.calls[0][0].query_params).toEqual({ f: 'arch-b.txt', h: entry.sha256 })
  })

  it('skips a file whose name and content are already in ulp.sources, before any stage exists', async () => {
    const { refPath } = archived('arch-c.txt')
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    const out = await processArchiveRef(refPath)
    expect(out.alreadyImported).toBe(true)
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.commitStage).not.toHaveBeenCalled()
  })

  it('imports a file with the same name and other content as a new file', async () => {
    archived('dup.txt')
    const second = archived('dup.txt', textOf(300, i => cleanLine(i + 1_000)))
    h.query.mockResolvedValue({ json: async () => [{ c: 0 }] }) // no row of ulp.sources has that name with an empty or equal hash
    await processArchiveRef(second.refPath)
    expect(h.query.mock.calls[0][0].query_params.h).toBe(second.entry.sha256)
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('refuses a reference whose sha256 is not the manifest\'s, before it reads anything', async () => {
    const { entry, refPath } = archived('arch-d.txt')
    writeFileSync(refPath, serializeArchiveRef({ ...entry, sha256: entry.id + 'f'.repeat(40) }))
    await expect(processArchiveRef(refPath)).rejects.toThrow(/does not match the archive manifest/)
    expect(h.createStage).not.toHaveBeenCalled()
  })

  it('refuses a size that is not the manifest\'s', async () => {
    const { entry, refPath } = archived('arch-e.txt')
    writeFileSync(refPath, serializeArchiveRef({ ...entry, size: entry.size + 1 }))
    await expect(processArchiveRef(refPath)).rejects.toThrow(/does not match the archive manifest/)
  })

  it('refuses an id the manifest does not know', async () => {
    mkdirSync(archiveDir, { recursive: true })
    const refPath = join(root, 'unknown.archiveref')
    writeFileSync(refPath, serializeArchiveRef({ id: 'c'.repeat(24), name: 'unknown.txt', size: 5, sha256: 'c'.repeat(64) }))
    await expect(processArchiveRef(refPath)).rejects.toThrow(/not in the archive manifest/)
    expect(h.createStage).not.toHaveBeenCalled()
  })

  it('fails before the commit when the archive was damaged: nothing is committed and the stage is dropped', async () => {
    const { entry, refPath } = archived('arch-f.txt')
    const zst = join(archiveDir, `${entry.id}.zst`)
    const bytes = readFileSync(zst)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    writeFileSync(zst, bytes)
    await expect(processArchiveRef(refPath)).rejects.toThrow()
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(sourcesInsert()).toBeUndefined()
  })

  it('holds a bad file that comes from the archive like any other, and imports it once it is released', async () => {
    const { refPath } = archived('arch-g.txt', textOf(300, junkLine))
    await expect(processArchiveRef(refPath)).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(h.commitStage).not.toHaveBeenCalled()
    const released = await processArchiveRef(refPath, undefined, { gateOverride: true })
    expect(released.gate).toMatchObject({ level: 'hold' })
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('runs the caller\'s own beforeCommit after the integrity check', async () => {
    const { refPath } = archived('arch-h.txt')
    const beforeCommit = vi.fn()
    await processArchiveRef(refPath, undefined, { beforeCommit })
    expect(beforeCommit).toHaveBeenCalledTimes(1)
  })

  it('refuses an archive import when the staged path is off: its integrity check must run before any row is written', async () => {
    const { refPath } = archived('arch-j.txt')
    vi.stubEnv('INGEST_NOVELTY_CHECK', 'off')
    await expect(processArchiveRef(refPath)).rejects.toThrow(/needs the staged import/)
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.createStage).not.toHaveBeenCalled()
  })

  it('reports progress through onBatch like a plain file', async () => {
    const { refPath } = archived('arch-i.txt')
    h.commitStage.mockImplementation(async (a: { onSlab?: (e: Record<string, number>) => void }) => {
      a.onSlab?.({ known: 0, inserted: 300, slab: 1, slabs: 1 })
      return COMMIT
    })
    const seen: number[] = []
    await processArchiveRef(refPath, n => seen.push(n))
    expect(seen).toEqual([300])
  })
})
