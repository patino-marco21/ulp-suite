import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Credentials page — the imported window', () => {
  const src = read('app/credentials/page.tsx')
  const widget = read('components/imported-window-filter.tsx')
  const buildParams = src.slice(src.indexOf('const buildParams'), src.indexOf('const loadAbortRef'))
  const mountEffect = src.slice(src.indexOf('// First load. An address that names'), src.indexOf('const applyFilters'))
  const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))
  const chips = src.slice(src.indexOf('Filter row 2: chip filters'), src.indexOf('Advanced filters panel'))
  const advanced = src.slice(src.indexOf('Advanced filters panel'))
  const header = src.slice(src.indexOf('{/* ── Header'), src.indexOf('Filter row 1: text search'))

  test('the slices under test were found', () => {
    expect(buildParams.length).toBeGreaterThan(200)
    expect(mountEffect.length).toBeGreaterThan(200)
    expect(doExport.length).toBeGreaterThan(500)
    expect(chips.length).toBeGreaterThan(500)
    expect(advanced.length).toBeGreaterThan(500)
    expect(header.length).toBeGreaterThan(500)
  })

  test('the window is a pill in the chips row, in view without opening Advanced', () => {
    expect(chips).toContain('<ImportedWindowFilter')
    expect(chips.indexOf('<ImportedWindowFilter')).toBeLessThan(chips.indexOf('Advanced filters toggle'))
    // nothing of it is left inside the drawer
    for (const gone of ['datetime-local', 'Imported after', 'Imported before', 'Since last export', 'IMPORTED_PRESETS']) {
      expect(advanced, gone).not.toContain(gone)
    }
    expect(src).not.toContain('type="date"')
  })

  test('inside the popover it is a pair of local date-time inputs, not date-only pickers', () => {
    expect(widget).toContain('type="datetime-local"')
    expect(widget).toContain('Imported after')
    expect(widget).toContain('Imported before')
    expect(widget).not.toContain('type="date"')
  })

  test('local time is converted to a UTC instant before it is sent: the browse request and the export carry imported_after / imported_before', () => {
    expect(src).toContain('localToUtcIso,') // the shared helper, not a copy
    expect(src).not.toContain('getTimezoneOffset') // one place knows the zone: lib/imported-window.ts
    expect(buildParams).toContain("ps.set('imported_after', afterIso)")
    expect(buildParams).toContain("ps.set('imported_before', beforeIso)")
    expect(doExport).toContain("imported_after:  afterIso ?? ''")
    expect(doExport).toContain("imported_before: beforeIso ?? ''")
    expect(src).not.toContain("ps.set('date_from'")
    expect(src).not.toContain('date_from:')
  })

  test('a change from the pill searches at once, with the values it just set (state is not rendered yet)', () => {
    const onChange = src.slice(src.indexOf('const onWindowChange'), src.indexOf('const sinceLastExport'))
    expect(onChange).toContain('setImportedWindow(next)')
    expect(onChange).toContain('resetCursor()')
    expect(onChange).toContain('load(null, { importedAfter: next.after, importedBefore: next.before')
    expect(chips).toContain('onChange={onWindowChange}')
  })

  test('setting a lower bound switches a non-time sort to Newest first (the plan with the fast path)', () => {
    const onChange = src.slice(src.indexOf('const onWindowChange'), src.indexOf('const sinceLastExport'))
    expect(onChange).toContain("next.after && sortKey !== 'imported_desc' && sortKey !== 'imported_asc'")
    expect(onChange).toContain("'imported_desc' as const")
    expect(onChange).toContain('setSortKey(sort)')
  })

  test('the window counts as a filter: Clear shows, and Clear empties it and the address', () => {
    expect(src).toContain('tierExclude.length || importedAfter || importedBefore)')
    const hasAdv = src.slice(src.indexOf('const hasAdvFilters'), src.indexOf('const hasFilters'))
    expect(hasAdv).not.toContain('imported')
    const clearAll = src.slice(src.indexOf('const clearAll'), src.indexOf('const copy ='))
    expect(clearAll).toContain('setImportedWindow(EMPTY_IMPORTED_WINDOW)')
    expect(clearAll).toContain('syncWindowToUrl(new URLSearchParams())')
  })

  test('the address: a window or file in it is applied before the first search, and every search writes it back', () => {
    expect(mountEffect).toContain('readWindowFromSearch(window.location.search, browserOffsetAt)')
    expect(mountEffect).toContain('setImportedWindow({ after: fromUrl.after, before: fromUrl.before, source: null })')
    expect(mountEffect).toContain('setSourceFileFilter(fromUrl.sourceFile)')
    expect(mountEffect).toContain('load(null, { importedAfter: fromUrl.after, importedBefore: fromUrl.before, sourceFile: fromUrl.sourceFile')
    expect(mountEffect).toContain("'imported_desc' as const") // a window opens on Newest first
    expect(mountEffect).toContain('was ignored') // a bad value is said out loud
    const load = src.slice(src.indexOf('const load = useCallback'), src.indexOf('// First load. An address that names'))
    expect(load.length).toBeGreaterThan(500)
    expect(load).toContain('syncWindowToUrl(params)')
    // only the three managed parameters are touched, with replaceState: the Back button is not trapped by filter changes
    expect(src).toContain('window.history.replaceState(window.history.state')
    expect(src).not.toContain('history.pushState')
  })

  test('the window and file in force are spelled out under the count, with the UTC instants and a way to clear each', () => {
    expect(header).toContain('Showing rows {windowText.text}')
    expect(header).toContain('{windowText.utc}')
    expect(header).toContain('aria-label="Clear the imported window"')
    expect(header).toContain('onClick={() => onWindowChange({ ...EMPTY_IMPORTED_WINDOW })}')
    expect(header).toContain('from file')
    expect(header).toContain('aria-label="Clear the source file"')
    expect(src).toContain('const clearSourceFile')
  })

  test('an export reads the truncation header, tells the operator, and only then moves the since-last-export mark', () => {
    expect(doExport).toContain("res.headers.get('X-Export-Truncated') === '1'")
    expect(doExport).toContain('markAfterExport(')
    expect(doExport).toContain('writeMark(browserStorage(), markKey, next)')
    expect(doExport).toContain("Export stopped at ${(cap > 0 ? cap : 10_000).toLocaleString('en-US')} rows")
  })

  test('Since last export is a preset of the popover, and the mark note sits inside it', () => {
    expect(chips).toContain('extraPresets={[sinceLastExport]}')
    expect(chips).toContain('Last export of this search ended')
    expect(src).toContain("key: 'since-last-export'")
    expect(src).toContain('sinceLastExportWindow(exportMark, Date.now())')
  })

  test('the since-last-export memory is keyed by the search, not by dates, sort or format', () => {
    const fingerprint = src.slice(src.indexOf('const markKey'), src.indexOf('useEffect(() => { setExportMark'))
    expect(fingerprint).toContain('searchFingerprint({')
    for (const field of ['q', 'domain', 'breach', 'tierInclude', 'excludeNoise', 'dedupe']) expect(fingerprint).toContain(field)
    for (const field of ['importedAfter', 'importedBefore', 'importedWindow', 'sortKey', 'exportFmt', 'limit']) expect(fingerprint).not.toContain(field)
  })

  test('the detail view labels imported_at as UTC, so the number matches what the filter takes', () => {
    expect(src).toContain('{cred.imported_at} UTC')
  })

  test('the operator is told what "added" means, in the popover', () => {
    expect(widget).toContain('a credential imported again later counts as added')
  })
})
