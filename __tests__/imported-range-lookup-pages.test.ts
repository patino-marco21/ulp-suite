import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Lookup page and breach export — one optional imported-after input each', () => {
  test('Lookup sends imported_after in the batch body only when it is set', () => {
    const src = read('app/lookup/page.tsx')
    expect(src).toContain('type="datetime-local"')
    expect(src).toContain("const bound = importedAfterIso ? { imported_after: importedAfterIso } : {}")
    expect(src).toContain('{ emails: queries, ...bound }')
    expect(src).toContain('{ domains: queries, ...bound }')
  })

  test('the breach export sends it, names the file from the server, and reports a cut-off export', () => {
    const src = read('app/breaches/[name]/page.tsx')
    expect(src).toContain('type="datetime-local"')
    expect(src).toContain("imported_after: importedAfterIso ?? ''")
    expect(src).toContain("res.headers.get('Content-Disposition')")
    expect(src).toContain("res.headers.get('X-Export-Truncated') === '1'")
  })
})

describe('API docs — the new parameters are documented on all four v1 lookups', () => {
  const src = read('app/docs/page.tsx')
  test('imported_after and imported_before appear in the search, domain, lookup and batch tables', () => {
    expect(src.match(/name: "imported_after"/g)).toHaveLength(4)
    expect(src.match(/name: "imported_before"/g)).toHaveLength(4)
  })
})
