import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  IMPORTED_DESC_PROJECTION_BODY,
  buildAddImportedDescProjectionSql,
  buildDropImportedDescProjectionSql,
  buildImportedDescProjectionCurrentSql,
} from '@/lib/credentials-projections'

/**
 * DDL v27 re-creates proj_imported_desc with is_noise and content_key_hash (see lib/newest-first.ts for why), and a fresh
 * install must start with the same definition. The expensive part -- building the projection for 495M rows -- is NOT done at
 * app start (see v23/v26): scripts/rebuild-imported-desc-projection.sh does it, supervised.
 */

const migrations = readFileSync('lib/clickhouse-migrations.ts', 'utf8')
const normalize = (s: string) => s.replace(/\s+/g, '')

describe('DDL v27 — proj_imported_desc with is_noise and content_key_hash', () => {
  test('the SQL builders: drop is IF EXISTS and touches no rows; the current-definition check is metadata only', () => {
    expect(buildDropImportedDescProjectionSql()).toBe('ALTER TABLE ulp.credentials DROP PROJECTION IF EXISTS proj_imported_desc')
    const check = buildImportedDescProjectionCurrentSql()
    expect(check).toMatch(/system\.projections/)
    expect(check).toContain("position(query, 'is_noise') > 0")
    expect(check).toContain("position(query, 'content_key_hash') > 0")
    expect(check).not.toMatch(/FROM ulp\.credentials/)
  })

  test('v27 runs once, inside its own try/catch, before the version is saved', () => {
    expect(migrations).toMatch(/const DDL_VERSION = (2[7-9]|[3-9]\d)\b/)
    const start = migrations.indexOf('if (lastDdl < 27)')
    expect(start).toBeGreaterThan(-1)
    const block = migrations.slice(start, migrations.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toMatch(/try \{[\s\S]*\} catch/)
  })

  test('it only replaces the projection when the live one is not already current, and never materializes at app start', () => {
    const start = migrations.indexOf('if (lastDdl < 27)')
    const block = migrations.slice(start, migrations.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toContain('buildImportedDescProjectionCurrentSql()')
    expect(block.indexOf('buildImportedDescProjectionCurrentSql()')).toBeLessThan(block.indexOf('buildDropImportedDescProjectionSql()'))
    expect(block.indexOf('buildDropImportedDescProjectionSql()')).toBeLessThan(block.indexOf('buildAddImportedDescProjectionSql()'))
    expect(block).not.toMatch(/MATERIALIZE/)
    expect(block).toContain('rebuild-imported-desc-projection.sh')
  })

  test('the ADD uses the shared body, so migration v14, v27, the restore and the init SQL cannot drift', () => {
    expect(buildAddImportedDescProjectionSql()).toContain(IMPORTED_DESC_PROJECTION_BODY)
  })
})

describe('the init SQL mirrors the projection body, so a fresh install starts with the current definition', () => {
  const init = readFileSync('docker/clickhouse/init/01-ulp-tables.sql', 'utf8')

  test('PROJECTION proj_imported_desc in 01-ulp-tables.sql is IMPORTED_DESC_PROJECTION_BODY (whitespace aside)', () => {
    const block = init.match(/PROJECTION proj_imported_desc \(([\s\S]*?)\n    \),/)?.[1]
    expect(block).toBeDefined()
    expect(normalize(block!)).toBe(normalize(IMPORTED_DESC_PROJECTION_BODY))
  })

  test('the comment above it no longer claims the view "reads in order" (measured: the projection is read whole, then sorted)', () => {
    const comment = init.slice(init.indexOf('-- proj_imported_desc:'), init.indexOf('PROJECTION proj_imported_desc ('))
    expect(comment).not.toMatch(/read in order/i)
    expect(comment).toContain('lib/newest-first.ts')
  })
})
