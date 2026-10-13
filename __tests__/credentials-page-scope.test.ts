import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const src = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')
const buildParams = src.slice(src.indexOf('const buildParams'), src.indexOf('const loadAbortRef'))
const clearAll = src.slice(src.indexOf('const clearAll'), src.indexOf('const copy = '))
const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))
const filterRow = src.slice(src.indexOf('Filter row 1: text search'), src.indexOf('Filter row 2: chip filters'))

describe('Credentials page — the "Search in" scope', () => {
  test('the slices under test were found', () => {
    expect(buildParams.length).toBeGreaterThan(200)
    expect(clearAll.length).toBeGreaterThan(100)
    expect(doExport.length).toBeGreaterThan(500)
    expect(filterRow.length).toBeGreaterThan(200)
  })

  test('the scope is state that starts at All fields', () => {
    expect(src).toMatch(/const \[scope, setScope\]\s+= useState<SearchScope>\('all'\)/)
    expect(src).toContain("import { SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE, type SearchScope } from '@/lib/search-scope'")
  })

  test('the request carries scope only when it is not All fields, and the callback depends on it', () => {
    expect(buildParams).toMatch(/if \(scope !== 'all'\)\s+ps\.set\('scope', scope\)/)
    expect(buildParams).toMatch(/\n\s+q, scope, domain, breach,/)
  })

  test('the CSV export sends it', () => {
    expect(doExport).toMatch(/\n\s+scope,\n/)
    expect(doExport).toContain('[q, scope, domain, breach, tierInclude,')
  })

  test('Clear puts it back to All fields', () => {
    expect(clearAll).toContain("setScope('all')")
  })

  test('the select sits beside the search box, lists the three options and sets only state (Apply or Enter runs the search)', () => {
    expect(filterRow).toContain('value={scope}')
    expect(filterRow).toContain('aria-label="Search in"')
    expect(filterRow).toContain('SEARCH_SCOPE_OPTIONS.map')
    expect(filterRow).toContain('title={SEARCH_SCOPE_TITLE}')
    expect(filterRow).toContain('onChange={e => setScope(e.target.value as SearchScope)}')
    expect(filterRow).toContain('SEARCH_SCOPE_PLACEHOLDERS[scope]')
    expect(filterRow.slice(filterRow.indexOf('value={scope}'), filterRow.indexOf('SEARCH_SCOPE_OPTIONS.map'))).not.toContain('load(')
  })

  test('a changed scope counts as an active filter, and the since-last-export memory is per scope without changing the old keys', () => {
    expect(src).toMatch(/const hasBasicFilters = !!\(q \|\| scope !== 'all' \|\|/)
    expect(src).toContain("scope: scope === 'all' ? '' : scope")
  })
})
