import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('v1 search route — cursor pagination (keyset, additive)', () => {
  const source = readFileSync(new URL('../app/api/v1/search/credentials/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('imports the shared cursor-pagination primitives', () => {
    expect(source).toMatch(/from ["']@\/lib\/cursor-pagination["']/)
    expect(source).toContain('decodeCursor')
    expect(source).toContain('buildCursorWhere')
    expect(source).toContain('encodeCursor')
  })

  test('reads an optional cursor query param', () => {
    expect(getFn).toMatch(/searchParams\.get\(['"]cursor['"]\)/)
  })

  test('an invalid or foreign-sort cursor token falls back to offset mode instead of erroring', () => {
    expect(getFn).toMatch(/cursor\s*&&\s*cursor\.sort\s*===\s*SORT_KEY/)
  })

  test('skips the count() query when a cursor is present', () => {
    expect(getFn).toMatch(/usingCursor[\s\S]{0,40}\?\s*Promise\.resolve\(null\)/)
  })

  test('drops OFFSET from the data query when a cursor is present', () => {
    expect(getFn).toContain("usingCursor ? '' : ' OFFSET {offset:UInt32}'")
  })

  test('computes next_cursor from the last row only when a full page was returned', () => {
    expect(getFn).toMatch(/rowsArr\.length === limit/)
    expect(getFn).toContain('encodeCursor(SORT_KEY')
  })

  test('response always includes next_cursor, additive to the existing shape', () => {
    expect(getFn).toContain('next_cursor')
    expect(getFn).toContain('results: rows')
    expect(getFn).toContain('query: q')
  })

  test('page/pages become null specifically in cursor mode, not removed from the response', () => {
    expect(getFn).toMatch(/page:\s*usingCursor \? null : page/)
    expect(getFn).toMatch(/pages:\s*usingCursor \? null : Math\.ceil/)
  })
})
