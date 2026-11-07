import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

import { processTextFile } from '@/lib/upload-processor'

/**
 * The same-name check of a plain file compares what ulp.sources holds about the name. Name and size were all it knew for a plain file; when the table also holds a
 * content hash for the name (archive-sources fills it), the file is hashed and a same-name, same-size file with other content is a new file, not a re-drop.
 */
const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const BODY = Array.from({ length: 200 }, (_, i) => cleanLine(i)).join('\n') + '\n'
const SHA = createHash('sha256').update(BODY).digest('hex')

let root: string
let file: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'content-identity-')); file = join(root, 'dump.txt'); writeFileSync(file, BODY) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const answer = (c: number) => ({ json: async () => [{ c }] })
/** `stored`: rows of the name that carry a hash; `same`: rows that match the file as it is asked about (by hash when the check carries one). */
function ulpSources(stored: number, same: number) {
  h.query.mockImplementation(async ({ query }: { query: string }) => (/sha256 != ''/.test(query) ? answer(stored) : answer(same)))
}
const sameNameCalls = () => h.query.mock.calls.map(c => c[0] as { query: string; query_params: Record<string, unknown> }).filter(q => !/sha256 != ''/.test(q.query))

beforeEach(() => {
  // This file pins the rule that holds with INGEST_CONTENT_LEDGER=off (a file is read only when the table holds a hash for its name and size); __tests__/file-ledger-importer.test.ts pins the ledger on.
  vi.stubEnv('INGEST_CONTENT_LEDGER', 'off')
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue({ rows: 200, distinct: 200, known: 0, inserted: 200, inFileDuplicates: 0, slabs: 1, matches: [], checkMs: 1, commitMs: 1 })
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('the same-name check with a content hash', () => {
  it('skips a file whose hash is the one the table holds for its name', async () => {
    ulpSources(1, 1)
    const out = await processTextFile(file, 'dump.txt')
    expect(out.alreadyImported).toBe(true)
    expect(sameNameCalls()[0].query_params).toMatchObject({ f: 'dump.txt', h: SHA })
    expect(h.commitStage).not.toHaveBeenCalled()
  })

  it('imports a file of the same name and size whose content is not what the table holds, and records its hash', async () => {
    ulpSources(1, 0)
    const out = await processTextFile(file, 'dump.txt')
    expect(out.alreadyImported).toBe(false)
    expect(out.imported).toBe(200)
    expect(h.commitStage).toHaveBeenCalledTimes(1)
    const sourceRow = h.insert.mock.calls.map(c => c[0]).find(c => c.table === 'ulp.sources')
    expect(sourceRow.values[0]).toMatchObject({ filename: 'dump.txt', size: Buffer.byteLength(BODY), sha256: SHA })
  })

  it('goes by name and size alone when the table holds no hash for the name', async () => {
    ulpSources(0, 1)
    const out = await processTextFile(file, 'dump.txt')
    expect(out.alreadyImported).toBe(true)
    const call = sameNameCalls()[0]
    expect(call.query_params).toEqual({ f: 'dump.txt', s: Buffer.byteLength(BODY) })
    expect(call.query).not.toMatch(/sha256 =/)
  })

  it('does not look at the content of a file the table has never seen', async () => {
    ulpSources(0, 0)
    const out = await processTextFile(file, 'brand-new.txt')
    expect(out.alreadyImported).toBe(false)
    expect(sameNameCalls()[0].query_params).toEqual({ f: 'brand-new.txt', s: Buffer.byteLength(BODY) })
  })
})
