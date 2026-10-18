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

  test('both pages convert local time to a UTC instant with the shared helper', () => {
    for (const path of ['app/lookup/page.tsx', 'app/breaches/[name]/page.tsx']) {
      const src = read(path)
      expect(src, path).toContain('localToUtcIso(importedWindow.after)')
      expect(src, path).toContain('localToUtcIso(importedWindow.before)')
    }
  })
})

describe('API docs — the new parameters are documented on all four v1 lookups', () => {
  const src = read('app/docs/page.tsx')
  test('imported_after and imported_before appear in the search, domain, lookup and batch tables', () => {
    expect(src.match(/name: "imported_after"/g)).toHaveLength(4)
    expect(src.match(/name: "imported_before"/g)).toHaveLength(4)
  })
})
