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

  test('an empty page with a pending count says it is counting rather than "No credentials found"', () => {
    expect(source).toMatch(/data\?\.totalPending\s*\?\s*<span[^>]*>No rows yet — counting matches…<\/span>/)
  })

  test('the "clear all" default view keeps using the single combined request', () => {
    const clearAll = source.slice(source.indexOf('const clearAll'), source.indexOf('const copy = '))
    expect(clearAll).not.toContain('skip_totals')
  })
})
