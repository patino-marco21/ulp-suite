import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

// The page is a large client component with no component-test harness in this repo, so its wiring to the
// split rows/totals requests is pinned with source checks; the state logic itself is unit-tested in
// credential-totals.test.ts and the server side in credentials-route-totals.test.ts.
describe('Credentials page — rows and totals are fetched separately on a first page', () => {
  const source = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')
  const load = source.slice(source.indexOf('const load = useCallback'), source.indexOf('useEffect(() => { load(null) }'))

  test('imports the totals helpers', () => {
    expect(source).toMatch(/from "@\/lib\/credential-totals"/)
  })

  test('only a first page (no cursor) splits the totals out', () => {
    expect(load).toMatch(/const splitTotals = cursor === null/)
  })

  test('the rows request asks the server to skip the totals', () => {
    expect(load).toContain("${splitTotals ? '&skip_totals=1' : ''}")
  })

  test('the totals request uses the same filters (totalsParams) and the same AbortController as the rows', () => {
    expect(load).toMatch(/fetch\(`\/api\/credentials\?\$\{totalsParams\(params\)\}`, \{ signal: controller\.signal \}\)/)
    expect(load).toMatch(/fetch\(`\/api\/credentials\?\$\{params\}[^`]*`, \{ signal: controller\.signal \}\)/)
  })

  test('a failed or aborted totals request resolves to null instead of rejecting', () => {
    expect(load).toMatch(/\.then\(parseTotals\)\s*\.catch\(\(\) => null\)/)
  })

  test('the rows are shown as "counting" first, and the totals are applied afterwards only if the request is still current', () => {
    const rowsAt = load.indexOf('withPendingTotals(')
    const totalsAt = load.indexOf('withTotals(prev, totals)')
    expect(rowsAt).toBeGreaterThan(-1)
    expect(totalsAt).toBeGreaterThan(rowsAt)
    expect(load).toMatch(/if \(loadAbortRef\.current === controller\) setData\(prev => withTotals\(prev, totals\)\)/)
  })

  test('the spinner is cleared by the rows, not held until the totals arrive', () => {
    // The totals are a detached .then(); nothing between the rows' setData and `finally` awaits them.
    expect(load).not.toMatch(/await totalsRequest/)
    expect(load).toMatch(/finally \{[\s\S]*setLoading\(false\)/)
  })

  test('the header and the footer render through the label helpers', () => {
    expect(source).toContain('{recordsLabel(data)}')
    expect(source).toContain('{resultsLabel(data)}')
  })

  test('the dim "of N" after the records says what it counts, and its tooltip names the chips that hide the rest', () => {
    // read from the view the request asked for, not from what is typed in the filter bar, so it cannot disagree with the rows on screen
    expect(source).toContain('matchingLabel(data, applied.filtered)')
    expect(source).toContain('matchingHint(data, applied, applied.filtered)')
    // the old wording read as "everything imported for this site"
    expect(source).not.toContain('total imported</span>')
  })

  test('the rows and the view they were asked for arrive together, so the header never wears the next search\'s wording over the last one\'s numbers', () => {
    expect(load).toContain('const view = appliedViewOf(params)')
    // applied with the rows (the page, and a timed-out answer), never when the request starts
    expect((source.match(/setApplied\(view\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(source).not.toContain('setApplied(appliedViewOf(params))')
    expect(source).toMatch(/const \[applied, setApplied\] = useState<AppliedView>\(BROWSE_VIEW\)/)
    // and a cleared search is the browse view, once its rows are in
    const clearAll = source.slice(source.indexOf('const clearAll'), source.indexOf('const copy = '))
    expect(clearAll).toMatch(/if \(json\.success\) \{ setData\([^\n]*; setApplied\(BROWSE_VIEW\)/)
  })

  test('Declutter follows the kind of search until the chip is clicked: null is automatic, a click fixes it, Clear gives it back', () => {
    expect(source).toMatch(/const \[declutterChoice, setDeclutterChoice\] = useState<boolean \| null>\(null\)/)
    expect(source).not.toMatch(/const \[excludeNoise, setExcludeNoise\]/)
    // the default is worked out from the values the request carries: a click on an e-mail or a domain in a row hands them over as overrides
    const build = source.slice(source.indexOf('const buildParams'), source.indexOf('const loadAbortRef'))
    expect(build).toContain('overrides?.excludeNoise ?? declutterChoice ?? declutterByDefault({')
    expect(build).toMatch(/q: effectiveQ,[\s\S]*domain: effectiveDomain,[\s\S]*urlHost: urlHostFilter,[\s\S]*emailDomain: emailDomainFilter/)
    const clearAll = source.slice(source.indexOf('const clearAll'), source.indexOf('const copy = '))
    expect(clearAll).toContain('setDeclutterChoice(null)')
    // the fetch of the cleared view asks for both chips, which is what an empty search gets
    expect(clearAll).toContain('exclude_noise=1&dedupe=1')
  })

  test('the chip follows a click at once and otherwise the view the rows on screen were asked for, and a click on it is kept', () => {
    expect(source).toContain('const chipOn = declutterChoice ?? applied.declutter')
    expect(source).toContain('const v = !chipOn; setDeclutterChoice(v)')
    expect(source).toContain("{chipOn ? 'Decluttered' : 'Declutter'}")
  })

  test('an export asks for the Declutter state the typed search would get', () => {
    expect(source).toContain("exclude_noise: declutterNow ? '1' : ''")
  })

  test('the Declutter chip says it hides every URL ending in .php, not only login pages', () => {
    expect(source).toContain('URLs ending in .php')
    expect(source).not.toContain('.php login pages')
  })

  test('an empty page with a pending count says it is counting rather than "No credentials found"', () => {
    expect(source).toMatch(/data\?\.totalPending\s*\?\s*<span[^>]*>No rows yet — counting matches…<\/span>/)
  })

  test('the "clear all" default view keeps using the single combined request', () => {
    const clearAll = source.slice(source.indexOf('const clearAll'), source.indexOf('const copy = '))
    expect(clearAll).not.toContain('skip_totals')
  })
})
