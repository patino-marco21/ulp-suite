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
  return {
    ...actual,
    createStage: h.createStage,
    dropStage: h.dropStage,
    registerStage: h.registerStage,
    unregisterStage: h.unregisterStage,
  }
})

import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_INPROCESS_MATCHES, processTextFile, processTextStream } from '@/lib/upload-processor'

const LINES =
  'https://shop.example.com:alice@example.com:pw-one\n' +
  'https://shop.example.com:bob@example.com:pw-two\n' +
  'https://shop.example.org:carol@example.org:pw-three\n'
const stream = (text = LINES) => Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>

const commitResult = (extra: Record<string, unknown> = {}) => ({
  rows: 3, distinct: 3, known: 1, inserted: 2, inFileDuplicates: 0, slabs: 1, matches: [], checkMs: 0, commitMs: 0, ...extra,
})
const insertedTables = () => h.insert.mock.calls.map(c => c[0].table as string)
const sourceRows = () => h.insert.mock.calls.filter(c => c[0].table === 'ulp.sources').map(c => c[0].values)

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue(commitResult())
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('processTextStream with novelty-aware ingest', () => {
  it('stages the file, commits it, and returns the new / known / repeated counts', async () => {
    h.commitStage.mockResolvedValue(commitResult({ rows: 3, distinct: 3, known: 1, inserted: 2, inFileDuplicates: 0 }))
    const out = await processTextStream(stream(), 'novelty-a.txt')
    expect(out).toMatchObject({ imported: 2, known: 1, inFileDuplicates: 0, skipped: 0, errors: 0, alreadyImported: false, filename: 'novelty-a.txt' })

    // The rows went to the stage, never straight into the real table.
    const stageTable = insertedTables().find(t => /^ulp\.zz_import_stage_[0-9a-f]{12}$/.test(t))
    expect(stageTable).toBeDefined()
    expect(insertedTables()).not.toContain('ulp.credentials')

    const commit = h.commitStage.mock.calls[0][0]
    expect(commit).toMatchObject({ target: 'ulp.credentials', noveltyAgainst: 'ulp.credentials', parsedRows: 3, slabRows: 20_000_000, matchCap: MAX_INPROCESS_MATCHES })
    expect(commit.tables.stage).toBe(stageTable)
  })

  it('returns the phase timings: the parser wait, the commit\'s check, and the stage insert plus the commit insert', async () => {
    // Staging a batch takes a real 200 ms; the commit reports 700 ms of existence check and 300 ms of insert. Three lines parse in no time.
    h.insert.mockImplementation(async (arg: { table: string }) => {
      if (/^ulp\.zz_import_stage_/.test(arg.table)) await new Promise(resolve => setTimeout(resolve, 200))
    })
    h.commitStage.mockResolvedValue(commitResult({ checkMs: 700, commitMs: 300 }))
    const out = await processTextStream(stream(), 'novelty-timings.txt')
    expect(out.timings).toBeDefined()
    expect(out.timings!.check_ms).toBe(700)
    expect(out.timings!.insert_ms).toBeGreaterThanOrEqual(300 + 190)
    expect(out.timings!.parse_ms).toBeLessThan(150)
  })

  it('leaves in-file dedup to the stage: a repeated line is staged, then counted, not skipped', async () => {
    const line = 'https://shop.example.com:alice@example.com:pw-one\n'
    h.commitStage.mockResolvedValue(commitResult({ rows: 3, distinct: 1, known: 0, inserted: 1, inFileDuplicates: 2 }))
    const out = await processTextStream(stream(line + line + line), 'novelty-repeat.txt')
    expect(h.commitStage.mock.calls[0][0].parsedRows).toBe(3)
    expect(out).toMatchObject({ imported: 1, inFileDuplicates: 2, skipped: 0 })
  })

  it('registers the stage before creating it, and drops and unregisters it after the commit', async () => {
    await processTextStream(stream(), 'novelty-order.txt')
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]
    expect(order(h.registerStage)).toBeLessThan(order(h.createStage))
    expect(order(h.createStage)).toBeLessThan(order(h.insert))
    expect(order(h.commitStage)).toBeLessThan(order(h.dropStage))
    expect(order(h.dropStage)).toBeLessThan(order(h.unregisterStage))
    expect(h.registerStage.mock.calls[0][0]).toBe(h.unregisterStage.mock.calls[0][0])
  })

  it('remembers the file in ulp.sources with the rows it added, even when it added none', async () => {
    h.commitStage.mockResolvedValue(commitResult({ known: 3, inserted: 0 }))
    await processTextStream(stream(), 'novelty-known.txt')
    expect(sourceRows()).toEqual([[{ filename: 'novelty-known.txt', line_count: 0 }]])
  })

  it('records the rows added when there are some', async () => {
    await processTextStream(stream(), 'novelty-added.txt')
    expect(sourceRows()).toEqual([[{ filename: 'novelty-added.txt', line_count: 2 }]])
  })

  it('does not remember a file that had no importable line', async () => {
    h.commitStage.mockResolvedValue(commitResult({ rows: 0, distinct: 0, known: 0, inserted: 0 }))
    const out = await processTextStream(stream('this is not a credential\n'), 'novelty-garbage.txt')
    expect(sourceRows()).toEqual([])
    expect(out).toMatchObject({ imported: 0, known: 0, skipped: 1 })
  })

  it('passes the active monitors to the commit and alerts only for the matches it returns', async () => {
    const monitor = { id: 7, name: 'm', domains: ['example.com'], match_mode: 'both' }
    dm.getActiveMonitors.mockResolvedValue([monitor])
    const matches = [{ monitorId: 7, url: 'https://shop.example.com', email: 'alice@example.com', password: 'pw-one', domain: 'shop.example.com' }]
    h.commitStage.mockResolvedValue(commitResult({ matches }))
    await processTextStream(stream(), 'novelty-monitor.txt')
    expect(h.commitStage.mock.calls[0][0].monitors).toEqual([{ id: 7, domains: ['example.com'], match_mode: 'both' }])
    expect(dm.fireMonitorAlertsFromMatches).toHaveBeenCalledWith('novelty-monitor.txt', matches, expect.any(Map))

    dm.fireMonitorAlertsFromMatches.mockClear()
    h.commitStage.mockResolvedValue(commitResult({ matches: [] }))
    await processTextStream(stream(), 'novelty-monitor-none.txt')
    expect(dm.fireMonitorAlertsFromMatches).not.toHaveBeenCalled()
  })

  it('drops and unregisters the stage, and rethrows, when the commit fails', async () => {
    h.commitStage.mockRejectedValue(new Error('commit failed'))
    await expect(processTextStream(stream(), 'novelty-fail-commit.txt')).rejects.toThrow('commit failed')
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(h.unregisterStage).toHaveBeenCalledTimes(1)
    expect(sourceRows()).toEqual([])
  })

  it('drops and unregisters the stage, and rethrows, when staging fails', async () => {
    h.insert.mockRejectedValue(new Error('Syntax error: bad query'))
    await expect(processTextStream(stream(), 'novelty-fail-stage.txt')).rejects.toThrow(/Syntax error/)
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(h.unregisterStage).toHaveBeenCalledTimes(1)
  })

  it('a stage that cannot be dropped does not mask the result of the import', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.dropStage.mockRejectedValue(new Error('drop failed'))
    const out = await processTextStream(stream(), 'novelty-drop-fails.txt')
    expect(out.imported).toBe(2)
    expect(h.unregisterStage).toHaveBeenCalledTimes(1)
  })

  it('reports parsing, checking and inserting to the job and to the progress hook', async () => {
    h.commitStage.mockImplementation(async (o: any) => {
      o.onPhase({ phase: 'checking', slab: 1, slabs: 2 })
      o.onSlab({ slab: 1, slabs: 2, known: 1, inserted: 1 })
      o.onPhase({ phase: 'checking', slab: 2, slabs: 2 })
      o.onSlab({ slab: 2, slabs: 2, known: 1, inserted: 2 })
      return commitResult()
    })
    const events: Array<{ phase: string }> = []
    const batches: number[] = []
    await processTextStream(stream(), 'novelty-progress.txt', 'job-1', n => batches.push(n), { onImportProgress: e => events.push(e) })

    expect(events.map(e => e.phase)).toEqual(['parsing', 'parsing', 'checking', 'inserting', 'checking', 'inserting'])
    expect(batches).toEqual([1, 2]) // onBatch carries the running count of NEW rows, after each slab
    const patches = h.updateJob.mock.calls.map(c => c[1])
    expect(patches[0]).toMatchObject({ phase: 'parsing', staged: 0, imported: 0 })
    expect(patches.at(-1)).toMatchObject({ phase: 'inserting', staged: 3, imported: 2, known: 1, slab: 2, slabs: 2 })
    expect(h.updateJob.mock.calls.every(c => c[0] === 'job-1')).toBe(true)
  })

  it('INGEST_NOVELTY_SLAB_ROWS reaches the commit', async () => {
    vi.stubEnv('INGEST_NOVELTY_SLAB_ROWS', '5000')
    await processTextStream(stream(), 'novelty-slab.txt')
    expect(h.commitStage.mock.calls[0][0].slabRows).toBe(5000)
  })

  it('INGEST_NOVELTY_CHECK=off keeps the direct path: no stage, rows straight into ulp.credentials', async () => {
    vi.stubEnv('INGEST_NOVELTY_CHECK', 'off')
    const out = await processTextStream(stream(), 'direct.txt')
    expect(h.registerStage).not.toHaveBeenCalled()
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(insertedTables()).toContain('ulp.credentials')
    expect(out).toMatchObject({ imported: 3, known: 0, inFileDuplicates: 0 })
  })

  it('a file already in ulp.sources is skipped before any stage exists, with zero known / repeated', async () => {
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    const out = await processTextStream(stream(), 'again.txt')
    expect(out).toMatchObject({ alreadyImported: true, imported: 0, known: 0, inFileDuplicates: 0 })
    expect(h.registerStage).not.toHaveBeenCalled()
  })
})

describe('the same-name check of a file on disk knows its size', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'same-name-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = (name: string, body = LINES) => { const p = join(dir, name); writeFileSync(p, body); return p }

  it('asks with the size of the file it opens and records that size when it imports it', async () => {
    await processTextFile(file('sized.txt'), 'sized.txt')
    expect((h.query.mock.calls[0][0] as { query_params: Record<string, unknown> }).query_params).toEqual({ f: 'sized.txt', s: Buffer.byteLength(LINES) })
    expect(sourceRows()).toEqual([[{ filename: 'sized.txt', line_count: 2, size: Buffer.byteLength(LINES) }]])
  })

  it('hands the caller a counter of the bytes read, which ends at the size of the file', async () => {
    let bytes = () => -1
    const path = file('counted.txt')
    await processTextFile(path, 'counted.txt', undefined, undefined, { onSourceBytes: read => { bytes = read } })
    expect(bytes()).toBe(Buffer.byteLength(LINES))
  })

  it('skips a file when the name AND the size were imported before, and imports one that only has the name', async () => {
    const SEEN = Buffer.byteLength(LINES)
    h.query.mockImplementation(async (q: { query_params: { s?: number } }) => ({ json: async () => [{ c: q.query_params.s === SEEN ? 1 : 0 }] }))

    const same = await processTextFile(file('shared-name.txt'), 'shared-name.txt')
    expect(same).toMatchObject({ alreadyImported: true, imported: 0 })
    expect(h.registerStage).not.toHaveBeenCalled()

    const other = await processTextFile(file('shared-name-2.txt', LINES + 'https://shop.example.net:dave@example.net:pw-four\n'), 'shared-name.txt')
    expect(other.alreadyImported).toBe(false)
    expect(h.registerStage).toHaveBeenCalledTimes(1)
    expect(sourceRows()[0][0]).toMatchObject({ filename: 'shared-name.txt', size: SEEN + 'https://shop.example.net:dave@example.net:pw-four\n'.length })
  })
})

describe('processTextFile gives the quality gate the file to sample', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sample-check-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('holds a big file that is junk from its first slice, before a stage table exists', async () => {
    vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
    const path = join(dir, 'big-junk.txt')
    writeFileSync(path, Array.from({ length: 5_000 }, (_, i) => junkLine(i)).join('\n') + '\n')
    truncateSync(path, 9 * 1024 * 1024) // the rest reads as zeros: a file past the 8 MiB that the check reads whole, with nothing but the head to sample
    await expect(processTextFile(path, 'big-junk.txt')).rejects.toMatchObject({ name: 'IngestHeldError', report: { phase: 'sample', level: 'hold' } })
    expect(h.registerStage).not.toHaveBeenCalled()
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.commitStage).not.toHaveBeenCalled()
  })
})
