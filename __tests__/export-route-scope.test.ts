import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8')
const postStart = source.indexOf('export async function POST')
const postFn = source.slice(postStart, source.indexOf('// ─────', postStart))
const sprayFn = source.slice(source.indexOf('function streamSprayList'), source.indexOf('function streamSprayList') + 1200)

describe('export route — the search scope', () => {
  test('imports the scope helpers', () => {
    expect(source).toContain('import { parseSearchScope, type SearchScope } from "@/lib/search-scope"')
  })

  test('reads scope from the body and refuses an unknown one with a 400 before any query runs', () => {
    expect(postFn).toMatch(/scope:\s*scopeRaw\s*=\s*'all'/)
    expect(postFn).toContain('const scope = parseSearchScope(scopeRaw)')
    expect(postFn).toContain("error: 'scope must be all, login or login_contains' }, { status: 400 }")
    expect(postFn.indexOf('parseSearchScope(scopeRaw)')).toBeLessThan(postFn.indexOf("format === 'wordlist'"))
  })

  test('the main query and the spray list both parse the search with the scope', () => {
    expect(postFn).toContain('parseULPQuery(query, scope)')
    expect(sprayFn).toContain('parseULPQuery(query, scope)')
    expect(postFn).toMatch(/streamSprayList\(query, domain, breach_name, incTiers, excTiers, loginTypes, importedRange, scope\)/)
    expect(sprayFn).toMatch(/range: ImportedRange,\s*scope: SearchScope,/)
  })
})
