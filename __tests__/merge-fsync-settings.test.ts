import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import { MERGE_FSYNC_SETTINGS, buildMergeFsyncSettingsSql } from '@/lib/clickhouse-migrations'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('fsync after merges (DDL v25)', () => {
  test('the settings are 1M rows / 128 MiB: every wide part is fsynced, tiny compact-part merges are not', () => {
    expect(MERGE_FSYNC_SETTINGS.min_rows_to_fsync_after_merge).toBe(1_000_000)
    expect(MERGE_FSYNC_SETTINGS.min_compressed_bytes_to_fsync_after_merge).toBe(128 * 1024 * 1024)
  })

  test('the migration is a metadata-only MODIFY SETTING on ulp.credentials, nothing that rewrites data', () => {
    const sql = buildMergeFsyncSettingsSql()
    expect(sql).toMatch(/^ALTER TABLE ulp\.credentials MODIFY SETTING/)
    expect(sql).toContain('min_rows_to_fsync_after_merge = 1000000')
    expect(sql).toContain('min_compressed_bytes_to_fsync_after_merge = 134217728')
    expect(sql).not.toMatch(/MATERIALIZE|UPDATE|DELETE|DROP|OPTIMIZE/)
  })

  test('v25 runs the migration once, inside its own try/catch, before the version is saved', () => {
    const src = read('../lib/clickhouse-migrations.ts')
    expect(src).toMatch(/const DDL_VERSION = (2[5-9]|[3-9]\d)\b/)
    const start = src.indexOf('if (lastDdl < 25)')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toContain('buildMergeFsyncSettingsSql()')
    expect(block).toMatch(/catch \(err\)/)
  })

  test('the init SQL for fresh installs carries the same two numbers', () => {
    const sql = read('../docker/clickhouse/init/01-ulp-tables.sql')
    const credentials = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS ulp.credentials'), sql.indexOf('CREATE TABLE IF NOT EXISTS ulp.sources'))
    expect(credentials).toMatch(/min_rows_to_fsync_after_merge\s*=\s*1000000/)
    expect(credentials).toMatch(/min_compressed_bytes_to_fsync_after_merge\s*=\s*134217728/)
    // the SETTINGS list must stay a valid comma-separated list ending in a single semicolon
    const settings = credentials.slice(credentials.lastIndexOf('SETTINGS'))
    expect(settings.match(/;/g)).toHaveLength(1)
  })

  test('the server-level merge_tree defaults carry them too', () => {
    const xml = read('../docker/clickhouse/config/ulp-performance.xml')
    const mergeTree = xml.slice(xml.indexOf('<merge_tree>'), xml.indexOf('</merge_tree>'))
    expect(mergeTree).toContain('<min_rows_to_fsync_after_merge>1000000</min_rows_to_fsync_after_merge>')
    expect(mergeTree).toContain('<min_compressed_bytes_to_fsync_after_merge>134217728</min_compressed_bytes_to_fsync_after_merge>')
    // the existing insert-side durability settings are untouched
    expect(mergeTree).toContain('<fsync_after_insert>1</fsync_after_insert>')
    expect(mergeTree).toContain('<fsync_part_directory>1</fsync_part_directory>')
  })
})
