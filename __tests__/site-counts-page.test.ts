import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const page = readFileSync(join(root, 'app/counts/page.tsx'), 'utf8')
const row = readFileSync(join(root, 'components/site-count-row.tsx'), 'utf8')
const sidebar = readFileSync(join(root, 'components/app-sidebar.tsx'), 'utf8')

describe('Site Counts page', () => {
  test('is in the Search group of the sidebar, open to every signed-in user, and points at /counts', () => {
    const entry = sidebar.match(/\{\s*title:\s*"Site Counts"[^}]*\}/)
    expect(entry).toBeTruthy()
    expect(entry![0]).toContain('url: "/counts"')
    expect(entry![0]).not.toContain('adminOnly')
    const searchGroup = sidebar.match(/title: "Search",[\s\S]*?items: \[([\s\S]*?)\]/)
    expect(searchGroup![1]).toContain('"Site Counts"')
  })

  test('asks the session route, in requests of the size the library names, and shows progress', () => {
    expect(page).toContain('"/api/lookup/counts"')
    expect(page).toContain('splitRequests(sites, SITE_COUNTS_REQUEST_SIZE)')
    expect(page).toContain('Counted ')
    expect(page).toContain('AbortController')
    expect(page).toContain('Stopped after ')
  })

  test('takes a pasted list or an uploaded file, and exports what it shows', () => {
    expect(page).toContain('type="file"')
    expect(page).toContain('siteCountsCsv(')
    expect(page).toContain('onDrop')
  })

  test('sorts by a column when its header is clicked, and exports in the order and the content it shows', () => {
    expect(page).toContain('nextSiteSort(')
    expect(page).toContain('orderSiteRows(rows, sort, ')
    expect(page).toContain('siteCountsCsv(shown)')
    for (const key of ['count', 'host_count', 'subdomain_count', 'subdomains', 'mark']) expect(page).toContain(`sortKey="${key}"`)
  })

  test('every sortable number column is on screen from the xl breakpoint, so each can be clicked at a laptop width', () => {
    expect(row).toMatch(/host: "hidden xl:block/)
    expect(row).toMatch(/subs: "hidden xl:block/)
    expect(row).toMatch(/distinct: "hidden xl:block/)
  })

  test('says when only hosts could be counted, and never shows a failed count as a zero', () => {
    expect(page).toContain('subdomains_counted === false')
    expect(row).toContain('fmt = (n: number | null) => (n === null ? "—"')
  })

  test('requires a signed-in user like the other pages', () => {
    expect(page).toContain('useAuth(true)')
  })
})

describe('Site Counts page — how its rows relate to the Credentials page', () => {
  test('says that Declutter and Unique are not applied here, so a search on the Credentials page can show fewer rows', () => {
    expect(page).toContain('Declutter and Unique are not applied')
    expect(page).toContain('.php pages')
  })
})

describe('Site Counts page — the marks', () => {
  test('asks for the marks of the whole list once per count, before the first request, through the store', () => {
    expect(page).toContain('void marksStore.load(planSites(sites).hosts)')
    expect(page.indexOf('marksStore.load(')).toBeLessThan(page.indexOf('splitRequests(sites, SITE_COUNTS_REQUEST_SIZE)'))
    expect(page).toContain('useSyncExternalStore(marksStore.subscribe, marksStore.getSnapshot, marksStore.getSnapshot)')
  })

  test('the page does not talk to the marks route itself: the store does, with its order of saves and its way back from a failed one', () => {
    expect(page).not.toContain('/api/lookup/marks')
    expect(page).toContain('createSiteMarksStore(')
    expect(page).toContain('onSaveFailed:')
    expect(page).toContain('void marksStore.change(host, patch)')
  })

  test('until the marks are loaded no row reads as "No mark" and nothing is filtered by mark, or the table would empty itself', () => {
    expect(page).toContain('markStateOf(row.result.host, marksSnap.marks, marksLoaded)')
    expect(page).toContain('const effectiveFilter: MarkFilter = marksLoaded ? markFilter : "all"')
    expect(page).toContain('disabled={!marksLoaded}')
  })

  test('the Mark column sorts by the rank of each row, and the table is the sorted rows narrowed by the chip', () => {
    expect(page).toContain('orderSiteRows(rows, sort, row => markRank(markStateOfRow(row)))')
    expect(page).toContain('const shown = ordered.filter(row => matchesMarkFilter(markStateOfRow(row), effectiveFilter))')
    expect(page).toContain('shown.map(row => (')
    expect(page).not.toContain('ordered.map(')
  })

  test('a failed load says so, with a Retry, and the counts stay as they are', () => {
    expect(page).toContain('marksSnap.status === "failed"')
    expect(page).toContain('The marks could not be loaded')
    expect(page).toContain('marksStore.retry()')
  })

  test('the chips say how many rows are shown of how many, and a chip that matches nothing offers the way back', () => {
    expect(page).toContain('Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()}')
    expect(page).toContain('No sites with this mark.')
    expect(page).toContain('onClick={() => setMarkFilter("all")}')
  })

  test('Export CSV follows the table on screen and carries the number of rows while a chip is on', () => {
    expect(page).toContain('siteCountsCsv(shown)')
    expect(page).toContain('Export CSV{effectiveFilter !== "all" ? ` (${shown.length.toLocaleString()})` : ""}')
  })

  test('each row is given its stored mark, how available the marks are, and the way to change them', () => {
    expect(page).toContain('mark={marksSnap.marks[row.result.host] ?? null}')
    expect(page).toContain('availability={markAvailability}')
    expect(page).toContain('onMarkChange={onMarkChange}')
  })

  test('the row lives in its own file, as a div with a real chevron button', () => {
    expect(page).not.toContain('function SiteRow(')
    expect(row).toContain('export function SiteRow(')
    expect(row).toContain('aria-expanded={open}')
    expect(row).not.toMatch(/<button\s+onClick=\{\(\) => expandable/)
  })
})
