import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ insert: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))

import { recordSource, sourceAlreadyImported } from '@/lib/upload-processor'
import { SOURCES_IDENTITY_ALTER, sourcesSyncSql } from '@/lib/source-archive'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const SOURCE = { sha256: 'ab'.repeat(32), size: 1234, archiveId: 'ab'.repeat(12) }

beforeEach(() => {
  h.insert.mockReset().mockResolvedValue(undefined)
  h.query.mockReset().mockResolvedValue({ json: async () => [{ c: 0 }] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DDL v28: ulp.sources identity columns', () => {
  const migrations = read('lib/clickhouse-migrations.ts')

  it('is version 28, applied once before the version is saved, inside its own try/catch, from the shared statement', () => {
    expect(migrations).toMatch(/const DDL_VERSION = (2[8-9]|[3-9]\d)\b/)
    const start = migrations.indexOf('if (lastDdl < 28)')
    expect(start).toBeGreaterThan(-1)
    const block = migrations.slice(start, migrations.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toContain('SOURCES_IDENTITY_ALTER')
    expect(block).toMatch(/try \{[\s\S]*\} catch \(err\)/)
  })

  it('the fresh-install table has the same three columns, in the same order', () => {
    const sql = read('docker/clickhouse/init/01-ulp-tables.sql')
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS ulp.sources'), sql.indexOf('CREATE TABLE IF NOT EXISTS ulp.domains'))
    expect(table).toMatch(/size\s+UInt64\s+DEFAULT 0/)
    expect(table).toMatch(/sha256\s+String\s+DEFAULT ''/)
    expect(table).toMatch(/archive_id\s+String\s+DEFAULT ''/)
    expect(table.indexOf('imported_at')).toBeLessThan(table.indexOf('size'))
    expect(table.indexOf('size')).toBeLessThan(table.indexOf('sha256'))
    expect(table.indexOf('sha256')).toBeLessThan(table.indexOf('archive_id'))
  })

  it('the archive tool and the migration share one statement', () => {
    expect(SOURCES_IDENTITY_ALTER).toBe(
      "ALTER TABLE ulp.sources ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''",
    )
    expect(sourcesSyncSql([]).startsWith(`${SOURCES_IDENTITY_ALTER};`)).toBe(true)
  })
})

describe('the duplicate-file guard with a content hash', () => {
  const sqlOf = (call: number) => h.query.mock.calls[call][0] as { query: string; query_params: Record<string, string> }

  it('asks by name only when the import has no identity (a plain file), exactly as before', async () => {
    await sourceAlreadyImported('a.txt')
    expect(sqlOf(0).query).toBe('SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1')
    expect(sqlOf(0).query_params).toEqual({ f: 'a.txt' })
  })

  it('counts only rows with that name and an empty or the same hash when the import has an identity', async () => {
    await sourceAlreadyImported('a.txt', { source: SOURCE })
    expect(sqlOf(0).query).toBe("SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} AND (sha256 = '' OR sha256 = {h:String}) LIMIT 1")
    expect(sqlOf(0).query_params).toEqual({ f: 'a.txt', h: SOURCE.sha256 })
  })

  // A plain file's content is not known at claim time (hashing 4 GB would cost a read), but its size is. A row whose recorded size differs is another file
  // that happens to share the name; a row without a size (an import from before sizes were recorded, or one from a source that has none) still blocks by name.
  it('asks by name and size when the caller knows the size of a plain file', async () => {
    await sourceAlreadyImported('a.txt', { fileSize: 4096 })
    expect(sqlOf(0).query).toBe('SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} AND (size = 0 OR size = {s:UInt64}) LIMIT 1')
    expect(sqlOf(0).query_params).toEqual({ f: 'a.txt', s: 4096 })
  })

  it('prefers the hash to the size when the import has both, and treats a size of 0 as no size', async () => {
    await sourceAlreadyImported('a.txt', { source: SOURCE, fileSize: 4096 })
    expect(sqlOf(0).query).toContain('sha256 = {h:String}')
    expect(sqlOf(0).query).not.toContain('size')
    await sourceAlreadyImported('b.txt', { fileSize: 0 })
    expect(sqlOf(1).query).toBe('SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1')
  })

  it('says "already imported" when such a row exists and "new file" when only rows with another hash exist', async () => {
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    expect(await sourceAlreadyImported('a.txt', { source: SOURCE })).toBe(true)
    h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
    expect(await sourceAlreadyImported('a.txt', { source: SOURCE })).toBe(false)
  })
})

describe('recordSource', () => {
  const sourcesInsert = () => h.insert.mock.calls.map(c => c[0]).find(c => c.table === 'ulp.sources')

  it('writes only the name and the line count for a plain file', async () => {
    await recordSource('a.txt', 10)
    expect(sourcesInsert().values).toEqual([{ filename: 'a.txt', line_count: 10 }])
  })

  it('writes the size, the sha256 and the archive id when the import came from the archive', async () => {
    await recordSource('a.txt', 10, { source: SOURCE })
    expect(sourcesInsert().values).toEqual([{ filename: 'a.txt', line_count: 10, size: 1234, sha256: SOURCE.sha256, archive_id: SOURCE.archiveId }])
  })

  it('writes the size of a plain file whose size is known, and nothing else', async () => {
    await recordSource('a.txt', 10, { fileSize: 4096 })
    expect(sourcesInsert().values).toEqual([{ filename: 'a.txt', line_count: 10, size: 4096 }])
  })

  it('checks for an earlier record with the same name and size, so another file with the name still gets its own row', async () => {
    await recordSource('a.txt', 10, { fileSize: 4096 })
    expect((h.query.mock.calls[0][0] as { query_params: Record<string, unknown> }).query_params).toEqual({ f: 'a.txt', s: 4096 })
    expect(sourcesInsert()).toBeDefined()
  })

  it('stays idempotent: a name already recorded with the same content is not recorded again', async () => {
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await recordSource('a.txt', 10, { source: SOURCE })
    expect(sourcesInsert()).toBeUndefined()
    expect(Readable).toBeDefined()
  })
})
