import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const page = readFileSync(join(root, 'app/counts/page.tsx'), 'utf8')
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

  test('says when only hosts could be counted, and never shows a failed count as a zero', () => {
    expect(page).toContain('subdomains_counted === false')
    expect(page).toContain('fmt = (n: number | null) => (n === null ? "—"')
  })

  test('requires a signed-in user like the other pages', () => {
    expect(page).toContain('useAuth(true)')
  })
})
