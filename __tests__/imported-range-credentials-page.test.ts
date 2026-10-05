import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Credentials page — the imported window', () => {
  const src = read('app/credentials/page.tsx')
  const buildParams = src.slice(src.indexOf('const buildParams'), src.indexOf('const loadAbortRef'))
  const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))

  test('the slices under test were found', () => {
    expect(buildParams.length).toBeGreaterThan(200)
    expect(doExport.length).toBeGreaterThan(500)
  })

  test('the filter is a pair of local date-time inputs, not date-only pickers', () => {
    expect(src).toContain('type="datetime-local"')
    expect(src).toContain('Imported after')
    expect(src).toContain('Imported before')
    expect(src).not.toContain('From date')
    expect(src).not.toContain('type="date"')
  })

  test('local time is converted to a UTC instant before it is sent: the browse request and the export carry imported_after / imported_before', () => {
    expect(src).toContain('localInputToUtcIso(value, new Date(value).getTimezoneOffset())')
    expect(buildParams).toContain("ps.set('imported_after', afterIso)")
    expect(buildParams).toContain("ps.set('imported_before', beforeIso)")
    expect(doExport).toContain("imported_after:  afterIso ?? ''")
    expect(doExport).toContain("imported_before: beforeIso ?? ''")
    expect(src).not.toContain("ps.set('date_from'")
    expect(src).not.toContain('date_from:')
  })

  test('an export reads the truncation header, tells the operator, and only then moves the since-last-export mark', () => {
    expect(doExport).toContain("res.headers.get('X-Export-Truncated') === '1'")
    expect(doExport).toContain('markAfterExport(')
    expect(doExport).toContain('writeMark(browserStorage(), markKey, next)')
    expect(doExport).toContain('Export stopped at 10,000 rows')
  })

  test('the since-last-export memory is keyed by the search, not by dates, sort or format', () => {
    const fingerprint = src.slice(src.indexOf('const markKey'), src.indexOf('useEffect(() => { setExportMark'))
    expect(fingerprint).toContain('searchFingerprint({')
    for (const field of ['q', 'domain', 'breach', 'tierInclude', 'excludeNoise', 'dedupe']) expect(fingerprint).toContain(field)
    for (const field of ['importedAfter', 'importedBefore', 'sortKey', 'exportFmt', 'limit']) expect(fingerprint).not.toContain(field)
  })

  test('setting a lower bound switches a non-time sort to Newest first (the plan with the fast path)', () => {
    expect(src).toContain("if (sortKey !== 'imported_desc' && sortKey !== 'imported_asc') setSortKey('imported_desc')")
  })

  test('the detail view labels imported_at as UTC, so the number matches what the filter takes', () => {
    expect(src).toContain('{cred.imported_at} UTC')
  })

  test('the operator is told what "added" means', () => {
    expect(src).toContain('a credential imported again later counts as added')
  })
})
