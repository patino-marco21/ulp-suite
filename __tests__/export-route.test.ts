import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('export route — GROUP BY password memory cap', () => {
  const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8')

  test('imports the export GROUP BY memory cap helper', () => {
    expect(source).toContain("import { exportGroupBySettings } from \"@/lib/clickhouse-query-limits\"")
  })

  test('streamWordlist applies the memory cap to its GROUP BY password query', () => {
    const fn = source.slice(source.indexOf('function streamWordlist'), source.indexOf('function streamSprayList'))
    expect(fn).toContain('GROUP BY password')
    expect(fn).toContain('${exportGroupBySettings(120)}')
    expect(fn).not.toContain('SETTINGS max_execution_time = 120')
  })

  test('exportHcmask applies the memory cap to its GROUP BY password query', () => {
    const fn = source.slice(source.indexOf('async function exportHcmask'), source.indexOf('function streamUniqueList'))
    expect(fn).toContain('GROUP BY password')
    expect(fn).toContain('${exportGroupBySettings(60)}')
  })
})
