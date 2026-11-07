import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  insert: vi.fn(), query: vi.fn(), createStage: vi.fn(), dropStage: vi.fn(), registerStage: vi.fn(), unregisterStage: vi.fn(), commitStage: vi.fn(), updateJob: vi.fn(),
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

import { processTextFile } from '@/lib/upload-processor'
import { PARSER_REVISION } from '@/lib/parser-version'
import { tallyOf, jobAccounting, SAME_CONTENT_NOTE, ALREADY_IMPORTED_NOTE, jobLabel } from '@/lib/import-summary'

/**
 * The file ledger in the importer (docs/superpowers/specs/2026-11-07-file-ledger-design.md): every plain file is hashed, a copy of known bytes under another name is skipped
 * while the parser that imported them is current, a deliberate re-feed and a changed parser import it again, a file that yielded nothing is remembered, and a ledger that cannot
 * be read never keeps a file out.
 */
const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const BODY = Array.from({ length: 200 }, (_, i) => cleanLine(i)).join('\n') + '\n'
const SHA = createHash('sha256').update(BODY).digest('hex')
const NOTES = Array.from({ length: 200 }, (_, i) => `4111 1111 1111 ${String(1000 + i)} | note ${i}`).join('\n') + '\n'
const NOTES_SHA = createHash('sha256').update(NOTES).digest('hex')

let root: string
let file: string
let notes: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'file-ledger-'))
  file = join(root, 'dump.txt'); writeFileSync(file, BODY)
  notes = join(root, 'notes.txt'); writeFileSync(notes, NOTES)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** What the mocked ledger answers: the content lookup (a row of the same bytes under another name) and the same-name guard (a count). */
const ledger: { content: Array<{ filename: string; revision: number; at: string }> | Error; guard: number } = { content: [], guard: 0 }
const sqls = () => h.query.mock.calls.map(c => c[0] as { query: string; query_params: Record<string, unknown> })

beforeEach(() => {
  ledger.content = []
  ledger.guard = 0
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue({ rows: 200, distinct: 200, known: 0, inserted: 200, inFileDuplicates: 0, slabs: 1, matches: [], checkMs: 1, commitMs: 1 })
  h.query.mockImplementation(async ({ query }: { query: string }) => {
    if (/sha256 = \{h:String\} AND filename != /.test(query)) {
      if (ledger.content instanceof Error) throw ledger.content
      return { json: async () => ledger.content }
    }
    return { json: async () => [{ c: ledger.guard }] }
  })
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const sourceRow = () => h.insert.mock.calls.map(c => c[0]).find(c => c.table === 'ulp.sources')?.values[0]

describe('the content check', () => {
  it('skips the same bytes under another name when the parser that imported them is current, and says which file they were', async () => {
    ledger.content = [{ filename: 'Original.txt', revision: PARSER_REVISION, at: '2026-11-06 21:02:39' }]
    const out = await processTextFile(file, 'Original (2).txt')
    expect(out.alreadyImported).toBe(true)
    expect(out.sameContent).toEqual({ filename: 'Original.txt', revision: PARSER_REVISION, importedAt: '2026-11-06 21:02:39' })
    expect(out.imported).toBe(0)
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.insert).not.toHaveBeenCalled()
    const lookup = sqls().find(q => /filename != /.test(q.query))!
    expect(lookup.query_params).toEqual({ h: SHA, f: 'Original (2).txt' })
  })

  it('imports the same bytes again when the parser has changed since, and records the file with the current revision', async () => {
    ledger.content = [{ filename: 'Original.txt', revision: PARSER_REVISION - 2, at: '2026-11-02 08:00:00' }]
    const out = await processTextFile(file, 'Original (2).txt')
    expect(out.alreadyImported).toBe(false)
    expect(out.sameContent).toBeUndefined()
    expect(out.imported).toBe(200)
    expect(sourceRow()).toMatchObject({ filename: 'Original (2).txt', sha256: SHA, size: Buffer.byteLength(BODY), parser_revision: PARSER_REVISION, line_count: 200 })
  })

  it('imports a file named as a re-feed although its bytes are known by the current parser', async () => {
    ledger.content = [{ filename: 'Original.txt', revision: PARSER_REVISION, at: '2026-11-06 21:02:39' }]
    const out = await processTextFile(file, 'Original (refeed v6.6).txt')
    expect(out.alreadyImported).toBe(false)
    expect(out.imported).toBe(200)
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('imports a file whose bytes the ledger has never seen, and records its hash and size at once (the archive timer is not needed for it)', async () => {
    const out = await processTextFile(file, 'brand-new.txt')
    expect(out.alreadyImported).toBe(false)
    expect(sourceRow()).toMatchObject({ filename: 'brand-new.txt', sha256: SHA, size: Buffer.byteLength(BODY), parser_revision: PARSER_REVISION })
  })

  it('imports the file when the ledger cannot be read: a ledger that fails never keeps a file out', async () => {
    ledger.content = new Error('Code: 47. DB::Exception: Unknown expression identifier parser_revision')
    const out = await processTextFile(file, 'brand-new.txt')
    expect(out.alreadyImported).toBe(false)
    expect(out.imported).toBe(200)
  })

  it('a same-name re-drop of the same bytes is still the same-name check\'s: the note stays "already-imported"', async () => {
    ledger.guard = 1   // the same-name guard finds the row; the content lookup excludes this very name, so it finds nothing
    const out = await processTextFile(file, 'dump.txt')
    expect(out.alreadyImported).toBe(true)
    expect(out.sameContent).toBeUndefined()
    expect(jobAccounting(tallyOf(out)).note).toBe(ALREADY_IMPORTED_NOTE)
  })
})

describe('INGEST_CONTENT_LEDGER=off', () => {
  it('reads and hashes nothing for a name the table has never seen, asks the content question of nobody and records no hash', async () => {
    vi.stubEnv('INGEST_CONTENT_LEDGER', 'off')
    ledger.content = [{ filename: 'Original.txt', revision: PARSER_REVISION, at: '2026-11-06 21:02:39' }]   // would be a skip with the ledger on
    const out = await processTextFile(file, 'Original (2).txt')
    expect(out.alreadyImported).toBe(false)
    expect(sqls().some(q => /filename != /.test(q.query))).toBe(false)
    expect(sourceRow().sha256).toBeUndefined()
  })
})

describe('a file that yielded nothing', () => {
  it('is remembered with its hash and 0 lines, so a re-drop is skipped by name and a copy by content', async () => {
    vi.stubEnv('INGEST_QUALITY_GATE', 'off')
    h.commitStage.mockResolvedValue({ rows: 0, distinct: 0, known: 0, inserted: 0, inFileDuplicates: 0, slabs: 1, matches: [], checkMs: 1, commitMs: 1 })
    const out = await processTextFile(notes, 'bin-list.txt')
    expect(out.imported).toBe(0)
    expect(out.alreadyImported).toBe(false)
    expect(sourceRow()).toMatchObject({ filename: 'bin-list.txt', line_count: 0, sha256: NOTES_SHA, size: Buffer.byteLength(NOTES), parser_revision: PARSER_REVISION })
  })

  it('is not remembered with the ledger off (as before)', async () => {
    vi.stubEnv('INGEST_CONTENT_LEDGER', 'off')
    vi.stubEnv('INGEST_QUALITY_GATE', 'off')
    h.commitStage.mockResolvedValue({ rows: 0, distinct: 0, known: 0, inserted: 0, inFileDuplicates: 0, slabs: 1, matches: [], checkMs: 1, commitMs: 1 })
    await processTextFile(notes, 'bin-list.txt')
    expect(sourceRow()).toBeUndefined()
  })
})

describe('the job row of a skipped copy', () => {
  it('carries its own note and label, apart from the same-name skip', () => {
    const t = tallyOf({ inFileDuplicates: 0, alreadyImported: true, sameContent: { filename: 'x' }, errors: 0 })
    expect(jobAccounting(t).note).toBe(SAME_CONTENT_NOTE)
    expect(jobLabel({ imported: 0, note: SAME_CONTENT_NOTE }, String)).toBe('same content as an earlier file · skipped')
    expect(jobLabel({ imported: 0, note: ALREADY_IMPORTED_NOTE }, String)).toBe('already imported · skipped')
  })

  it('a ZIP with one entry skipped by name and one by content is "already-imported" as a whole, and all by content is "same-content"', () => {
    const t = tallyOf({ inFileDuplicates: 0, alreadyImported: true, sameContent: { filename: 'x' }, errors: 0 })
    t.entries++; t.alreadyImported++
    expect(jobAccounting(t).note).toBe(ALREADY_IMPORTED_NOTE)
  })
})
