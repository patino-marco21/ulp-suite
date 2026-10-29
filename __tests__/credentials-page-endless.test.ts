import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

// The page is a large client component with no component-test harness in this repo, so its wiring is pinned with source checks; the decisions themselves are
// unit-tested in credential-pages.test.ts and login-type-default.test.ts, and the behaviour in a browser on the rehearsal app
// (docs/superpowers/specs/2026-10-28-next-page-speed-design.md).
const source = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')
const between = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to))
const load = between('const load = useCallback', 'const loadMore = useCallback')
const loadMore = between('const loadMore = useCallback', '// The end of the rows and the box that scrolls them')
const observer = between('// The end of the rows and the box that scrolls them', '// First load. An address that names')

describe('Credentials page — one endless list instead of pages', () => {
  test('the previous/next buttons and the page-cursor state are gone', () => {
    expect(source).not.toContain('cursorStack')
    expect(source).not.toContain('currentCursor')
    expect(source).not.toContain('resetCursor')
    expect(source).not.toContain('ChevronLeft')
    expect(source).not.toContain('ChevronRight')
  })

  test('a new search keeps the query string it asked, and the next page continues THAT search, not whatever the filter bar says by then', () => {
    expect(load).toContain('shownQueryRef.current = params.toString()')
    expect(loadMore).toContain('new URLSearchParams(shownQueryRef.current)')
    expect(loadMore).toContain("ps.set('cursor', cursor)")
    expect(loadMore).not.toContain('buildParams')
    // "Clear" is a search too
    expect(between('const clearAll', 'const copy = ')).toContain('shownQueryRef.current = defaults')
  })

  test('a later page appends to the rows on screen and never replaces them or the spinner of a search', () => {
    expect(loadMore).toContain('setData(prev => (prev ? appendPage(prev, json) : prev))')
    expect(loadMore).not.toContain('setLoading(')
    expect(loadMore).toContain('setLoadingMore(true)')
  })

  test('a later page has its own controller, so a scroll cannot cancel the first page\'s totals; a new search cancels both and drops a late answer', () => {
    expect(loadMore).toContain('moreAbortRef.current = controller')
    expect(loadMore).not.toContain('loadAbortRef')
    expect(load).toContain('loadAbortRef.current?.abort()')
    expect(load).toContain('moreAbortRef.current?.abort()')
    // the search counter moves BEFORE the aborts, so the aborted page sees that it was replaced and stays silent
    expect(load.indexOf('++searchRef.current')).toBeLessThan(load.indexOf('moreAbortRef.current?.abort()'))
    expect(loadMore).toContain('if (searchRef.current !== search) return')
  })

  test('one later page at a time, also between two renders', () => {
    expect(loadMore).toContain('moreInFlightRef.current')
    expect(loadMore).toMatch(/if \(!cursor \|\| loading \|\| moreInFlightRef\.current\) return/)
  })

  test('a failure or a stop keeps the rows, says so, and nothing retries by itself', () => {
    expect(loadMore).toContain('setMoreError(')
    expect(loadMore).toContain("'Stopped.'")
    // the observer exists only while the list may load by itself (shouldAutoLoad is false after an error)
    expect(source).toContain('error: moreError !== null')
    expect(observer).toMatch(/if \(!autoLoad \|\| !root \|\| !target/)
    expect(source).toContain('onStop={() => moreAbortRef.current?.abort()}')
  })

  test('the observer watches the end of the rows in the table\'s own scroll box, LOAD_AHEAD_PX early, and is made again after every page and search', () => {
    expect(observer).toContain('{ root, rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` }')
    expect(observer).toMatch(/\}, \[autoLoad, rowCount\]\)/)
    expect(source).toContain('<div ref={scrollRef} className="flex-1 overflow-auto">')
    expect(source).toContain('<div ref={sentinelRef} aria-hidden="true" className="h-px" />')
  })

  test('the rows are a memoised component fed with stable callbacks (thousands of rows must not render again for a page or a click)', () => {
    expect(source).toContain('const CredentialRow = memo(function CredentialRow(')
    expect(source).toContain('<CredentialRow key={i} cred={cred} selected={selectedCred === cred && sheetOpen} onOpen={openDetail} onCopy={copy} />')
    expect(source).toContain('const openDetail = useCallback(')
    expect(source).toContain('const copy = useCallback(')
  })

  test('the footer counts its seconds itself, so that the table does not render once a second', () => {
    const footer = between('function ListFooterLine', '// ─── Main page')
    expect(footer).toContain('setInterval(')
    expect(footer).toContain('clearInterval(id)')
    // not in the page component, whose state would re-render the whole table every second
    expect(load).not.toContain('setInterval')
    expect(loadMore).not.toContain('setInterval')
    expect(observer).not.toContain('setInterval')
  })
})

describe('Credentials page — Email by default for a search', () => {
  const build = between('const buildParams', 'const loadAbortRef')

  test('the chips start automatic: null is the default of the search, a click is a choice that holds until Clear', () => {
    expect(source).toMatch(/const \[loginTypeChoice, setLoginTypeChoice\] = useState<string \| null>\(null\)/)
    expect(source).not.toMatch(/const \[loginType, setLoginType\]/)
    expect(between('const clearAll', 'const copy = ')).toContain('setLoginTypeChoice(null)')
  })

  test('the request carries the effective type, worked out from the values it carries (a click on a row hands them over as overrides)', () => {
    expect(build).toContain('effectiveLoginType(overrides?.loginTypeChoice !== undefined ? overrides.loginTypeChoice : loginTypeChoice, { q: effectiveQ, domain: effectiveDomain })')
    expect(build).toContain("if (effectiveType)      ps.set('login_type', effectiveType)")
  })

  test('the chips, the export and the "same search" key all read the type a search typed now would get', () => {
    expect(source).toContain('const loginTypeNow = effectiveLoginType(loginTypeChoice, { q, domain })')
    expect(source).toContain('onClick={() => setLoginTypeChoice(loginTypeNow === lt ? \'\' : lt)}')
    expect(source).toContain("loginTypeNow === lt ? 'border-primary/30 bg-primary/10")
    expect(source).toContain('login_type:    loginTypeNow,')
    expect(source).toContain('loginType: loginTypeNow,')
  })

  test('the automatic Email does not light the Clear button: only a choice of a type counts as a filter', () => {
    expect(source).toContain("(loginTypeChoice ?? '') !== ''")
  })

  test('"search this login" on a row that is not Email-type drops the type, so the row that was clicked is in the answer', () => {
    expect(source).toContain('onSearchEmail(cred.email, cred.login_type)')
    const handler = between('const handleSearchEmail', 'const handleSearchDomain')
    expect(handler).toContain("rowLoginType === 'email' ? loginTypeChoice : ''")
    expect(handler).toContain('load({ q: email, loginTypeChoice: choice })')
  })
})
