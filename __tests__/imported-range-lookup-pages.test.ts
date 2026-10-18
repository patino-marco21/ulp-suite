import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Lookup page and breach export — one optional imported window each (the shared pill)', () => {
  test('Lookup sends imported_after and imported_before in the batch body, each only when it is set', () => {
    const src = read('app/lookup/page.tsx')
    expect(src).toContain('<ImportedWindowFilter value={importedWindow} onChange={setImportedWindow} />')
    expect(src).toContain('...(importedAfterIso ? { imported_after: importedAfterIso } : {})')
    expect(src).toContain('...(importedBeforeIso ? { imported_before: importedBeforeIso } : {})')
    expect(src).toContain('{ emails: queries, ...bound }')
    expect(src).toContain('{ domains: queries, ...bound }')
    expect(src).not.toContain('type="datetime-local"') // the fields live in the shared component
  })

  test('the breach export sends both bounds, names the file from the server, and reports a cut-off export', () => {
    const src = read('app/breaches/[name]/page.tsx')
    expect(src).toContain('<ImportedWindowFilter value={importedWindow} onChange={setImportedWindow} />')
    expect(src).toContain("imported_after: importedAfterIso ?? ''")
    expect(src).toContain("imported_before: importedBeforeIso ?? ''")
    expect(src).toContain("res.headers.get('Content-Disposition')")
    expect(src).toContain("res.headers.get('X-Export-Truncated') === '1'")
    expect(src).not.toContain('type="datetime-local"')
  })

  // Measured at 375 px: the nowrap row put the pill on two lines and pushed "user:pass" and "ULP" past the card edge.
  test('the breach export row wraps, so the window pill and the export buttons stay inside the card on a phone', () => {
    const src = read('app/breaches/[name]/page.tsx')
    const row = src.slice(src.indexOf('{/* Export */}'), src.indexOf('<ImportedWindowFilter'))
    expect(row).toContain('<CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">')
    expect(row).toContain('<div className="flex flex-wrap items-end gap-2">')
  })

  test('both pages convert local time to a UTC instant with the shared helper', () => {
    for (const path of ['app/lookup/page.tsx', 'app/breaches/[name]/page.tsx']) {
      const src = read(path)
      expect(src, path).toContain('localToUtcIso(importedWindow.after)')
      expect(src, path).toContain('localToUtcIso(importedWindow.before)')
    }
  })
})

describe('API docs — the window is documented on every v1 endpoint that takes it', () => {
  const src = read('app/docs/page.tsx')
  test('imported_after and imported_before appear in the search, domain, lookup, batch, associate and password tables and the summary parameters', () => {
    expect(src.match(/name: "imported_after"/g)).toHaveLength(7)
    expect(src.match(/name: "imported_before"/g)).toHaveLength(7)
  })

  test('the summary says a lower bound is required and what a window costs; associate says its own rows stay unfiltered', () => {
    expect(src).toContain('Needs imported_after: an upper bound alone is the whole table up to a date and is a 400.')
    expect(src).toContain('kept for 2 minutes (10 once the window is closed)')
    expect(src).toContain("The login's own rows are always read from the whole table, because they identify the account.")
  })
})
