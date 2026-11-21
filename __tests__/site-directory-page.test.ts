import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The page is a large client component with no component-test harness in this repo, so its wiring is pinned with source checks; the decisions themselves are
// unit-tested (site-directory-input.test.ts, site-directory-order.test.ts, list-footer-line.test.ts) and the behaviour is checked in a browser on the rehearsal
// app (the plan's Task 9), because only a browser can show that the endless list loads one page at a time.
const root = join(__dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const page = read('app/directory/page.tsx')
const row = read('components/site-count-row.tsx')
const detail = read('components/site-directory-detail.tsx')
const sidebar = read('components/app-sidebar.tsx')
const countsPage = read('app/counts/page.tsx')
const between = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to))
const load = between('const load = useCallback', 'const loadMore = useCallback')
const loadMore = between('const loadMore = useCallback', '// The end of the rows and what scrolls them')
const observer = between('// The end of the rows and what scrolls them', '// What the line above the list says')

describe('the sidebar', () => {
  test('lists Site Directory right under Site Counts, in the Search group, open to every signed-in user', () => {
    const search = sidebar.match(/title: "Search",[\s\S]*?items: \[([\s\S]*?)\]/)![1]
    const titles = [...search.matchAll(/title: "([^"]+)"/g)].map(m => m[1])
    expect(titles.indexOf('Site Directory')).toBe(titles.indexOf('Site Counts') + 1)
    const entry = sidebar.match(/\{\s*title:\s*"Site Directory"[^}]*\}/)![0]
    expect(entry).toContain('url: "/directory"')
    expect(entry).not.toContain('adminOnly')
  })
})

describe('the Site Directory page — one endless list', () => {
  test('is for signed-in users and reads the three session routes', () => {
    expect(page).toContain('useAuth(true)')
    expect(page).toContain('/api/lookup/directory?')
    expect(page).toContain('"/api/lookup/directory/breakdown"')
    expect(page).toContain('"/api/lookup/directory/status"')
    expect(page).toContain('method: "DELETE"')
    expect(page).toContain('"/api/lookup/counts"')
  })

  test('shares the Credentials page\'s machinery instead of copying it', () => {
    expect(page).toContain('import { ListFooterLine } from "@/components/list-footer-line"')
    expect(page).toContain('import { SortHeader } from "@/components/site-sort-header"')
    expect(countsPage).toContain('import { SortHeader } from "@/components/site-sort-header"')
    expect(page).toMatch(/import \{[^}]*LOAD_AHEAD_PX[^}]*\} from "@\/lib\/credential-pages"/)
    expect(page).toMatch(/import \{[^}]*scrollParentOf[^}]*\} from "@\/lib\/credential-pages"/)
    expect(page).toMatch(/import \{[^}]*shouldAutoLoad[^}]*\} from "@\/lib\/credential-pages"/)
    expect(page).toContain('noun="sites"')
    expect(page).toContain('endLabel="end of the directory"')
  })

  test('the next page continues THE LIST ON SCREEN, is appended without a site that is already shown, and is dropped if the list has moved on', () => {
    expect(load).toContain('shownQueryRef.current = base.toString()')
    expect(loadMore).toContain('new URLSearchParams(shownQueryRef.current)')
    expect(loadMore).toContain("ps.set('offset', String(nextOffset))")
    expect(loadMore).toContain('new Set(prev.map(s => s.host))')
    expect(load).toContain('if (id !== searchRef.current) return')
    expect(loadMore).toContain('if (id !== searchRef.current) return')
    expect(page).not.toContain('Show more')
  })

  test('the observer watches the end of the rows against what REALLY scrolls, LOAD_AHEAD_PX early, and is made again after every page', () => {
    expect(observer).toMatch(/if \(!autoLoad \|\| !target \|\| typeof IntersectionObserver === 'undefined'\) return/)
    expect(observer).toContain('{ root: scrollParentOf(target), rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` }')
    expect(observer).toMatch(/\}, \[autoLoad, rows\.length\]\)/)
    expect(page).toContain('<div ref={sentinelRef} aria-hidden="true" className="h-px" />')
    // rooted on the list's own box it would see the end as visible all the time when the box grows with its rows (the Credentials page's first version did)
    expect(observer).not.toContain('listBoxRef')
  })

  test('a failure or a stop keeps the rows, says so, and nothing retries by itself', () => {
    expect(loadMore).toContain('setMoreError(')
    expect(loadMore).toContain("'Stopped.'")
    expect(page).toContain('error: moreError !== null')
    expect(page).toContain('onStop={() => moreAbortRef.current?.abort()}')
  })

  test('a sort, a chip and the typed search (after a pause) replace the list and scroll back to the top', () => {
    expect(page).toContain('nextSiteSort(')
    expect(page).toContain('}, [sort, applied, markFilter, marksStore])')
    expect(page).toContain('setTimeout(() => setApplied(search.trim()), 300)')
    expect(load).toContain('scrollListToTop(listBoxRef.current)')
    // the document scrolls in this layout, not the list's box: found only by driving the page (a sort while far down fetched every page again)
    expect(page).toContain('else window.scrollTo({ top: 0 })')
  })

  test('the marks come with the list: the store is handed each page\'s marks, and a changed mark reads the chips again', () => {
    expect(load).toContain('marksStore.adopt(marksOf(json.sites), true)')
    expect(loadMore).toContain('marksStore.adopt(marksOf(json.sites))')
    expect(page).toContain('marksStore.change(host, patch).then(')
    expect(page).toContain('refreshChipsRef.current()')
  })

  test('the rows are memoised and fed stable callbacks (thousands of rows must not render again for a poll or a click)', () => {
    expect(page).toContain('const DirectoryRow = memo(function DirectoryRow(')
    expect(page).toContain('const onMarkChange = useCallback(')
    expect(page).toContain('const startBreakdown = useCallback(')
  })

  test('opening a row with no split works it out, one at a time per site; there is no per-row button', () => {
    expect(page).toContain('needsBreakdown(site)')
    expect(page).toContain("if (uiRef.current[host]?.breakdown === \"working\") return")
    expect(page).not.toContain('Break down')
  })

  test('the status line is asked for every 30 s while the tab is visible, and a finished refresh offers a reload instead of moving the rows', () => {
    expect(page).toContain('setInterval(poll, 30_000)')
    expect(page).toContain('document.visibilityState')
    expect(page).toContain('Reload the list')
    expect(page).toContain('statusLine(status)')
  })
})

describe('the row and its detail', () => {
  test('SiteRow takes an optional detail that opens every row; Site Counts passes none', () => {
    expect(row).toContain('export interface SiteRowDetail')
    expect(row).toContain('const expandable = detail !== undefined || (result.count ?? 0) > 0')
    expect(row).toContain('detail?.onOpen?.()')
    expect(row).toContain('{detail?.body}')
    expect(countsPage).not.toContain('detail=')
  })

  test('the detail shows the split with its counts and shares, a stale note, Try again, Recount and a two-step Remove', () => {
    for (const text of ['Logins by type', 'Working out the split…', 'Try again', 'Recount', 'Remove', 'Click again to remove', 'No rows, so nothing to split', 'Not counted yet']) {
      expect(detail).toContain(text)
    }
    expect(detail).toContain('breakdownNote(site)')
    // "Just now" inside a sentence reads "just now"
    expect(detail).toContain('const ago = ')
    expect(detail).not.toContain('Counted ${formatRelativeTime')
    expect(detail).toContain('<BreakdownLegend')
  })
})
