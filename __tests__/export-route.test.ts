import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('export route — GROUP BY password memory cap', () => {
  const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8')

  test('imports the export GROUP BY memory cap helper', () => {
    expect(source).toContain("import { exportGroupBySettings, exportSortSettings } from \"@/lib/clickhouse-query-limits\"")
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

describe('export route — POST main query avoids inlining NORM_COLS with ORDER BY/LIMIT (MEMORY_LIMIT_EXCEEDED regression)', () => {
  const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8')
  const postFn = source.slice(source.indexOf('export async function POST'), source.indexOf('// ─────', source.indexOf('export async function POST')))

  test('SORT_MAP domain_asc/domain_desc no longer carry the synthetic blank-domain prefix', () => {
    // Same symptom as the bug fixed in lib/cursor-pagination.ts's SORT_MAP —
    // `(domain='') ASC` is not a valid ORDER BY prefix for the table's actual
    // primary key and forces a full sort instead of a bounded key-ordered read.
    expect(source).not.toContain(`(domain='') ASC`)
  })

  test('defines a raw-column list for the inner sorted/limited/deduped query', () => {
    expect(source).toContain('const RAW_COLS')
  })

  test('inner query reads RAW_COLS only — NORM_COLS is confined to an outer wrapper', () => {
    const innerStart = postFn.indexOf('FROM (')
    const innerEnd = postFn.indexOf(') AS t')
    expect(innerStart).toBeGreaterThan(-1)
    expect(innerEnd).toBeGreaterThan(innerStart)

    const inner = postFn.slice(innerStart, innerEnd)
    expect(inner).toContain('RAW_COLS')
    expect(inner).not.toContain('NORM_COLS')
    expect(inner).toContain('ORDER BY')
    expect(inner).toContain('LIMIT 10000')

    // NORM_COLS must appear in the outer SELECT (before the inner subquery starts),
    // applied only to the already-bounded LIMIT 10000 result — not evaluated
    // per-scanned-row alongside the sort/limit like the pre-fix version did.
    const outer = postFn.slice(0, innerStart)
    expect(outer).toContain('NORM_COLS')
  })

  test('main query forces an external sort so dedupe + a non-domain sort spills to disk instead of crashing', () => {
    // Confirmed live: dedupe's LIMIT BY still forces ClickHouse to fully sort
    // the filtered set (see the comment above SORT_MAP) — this setting converts
    // that MEMORY_LIMIT_EXCEEDED crash into a slower success.
    expect(postFn).toContain('${exportSortSettings()}')
  })

  test('every SORT_MAP entry has at least two ORDER BY columns for stable tie-breaking', () => {
    // NOTE: this guards determinism (stable ordering when the leading column
    // repeats), not the dedupe MEMORY_LIMIT_EXCEEDED issue — live testing showed
    // extra tiebreaker columns do NOT prevent that. See the comment above SORT_MAP.
    const mapStart = source.indexOf('const SORT_MAP')
    const mapBlock = source.slice(mapStart, source.indexOf('\n}', mapStart))
    const values = [...mapBlock.matchAll(/:\s*[`']([^`']+)[`']/g)].map(m => m[1])
    expect(values.length).toBeGreaterThanOrEqual(7)
    for (const val of values) {
      expect(val.split(',').length).toBeGreaterThanOrEqual(2)
    }
  })
})
