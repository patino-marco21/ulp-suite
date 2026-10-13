import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const src = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')
const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))
const exportButton = src.slice(src.indexOf('onClick={doExport}'), src.indexOf('onClick={doExport}') + 800)

describe('Credentials page — the streamed export', () => {
  test('the slices under test were found', () => {
    expect(doExport.length).toBeGreaterThan(800)
    expect(exportButton.length).toBeGreaterThan(300)
  })

  test('a response with X-Export-Cap is read as a stream and counted', () => {
    expect(src).toContain("import { readCountedStream } from '@/lib/export-stream-client'")
    expect(doExport).toContain("Number(res.headers.get('X-Export-Cap') ?? 0) || 0")
    expect(doExport).toContain("readCountedStream(res.body, exportFmt === 'csv' ? 1 : 0, setExportRows)")
    expect(doExport).toContain('const truncated = cap > 0 ? streamedRows >= cap')
    expect(doExport).toContain('const rows = cap > 0 ? streamedRows')
  })

  test('json (no cap header) still reads its row count and truncation flag from the headers, and the mark call is the same', () => {
    expect(doExport).toContain("res.headers.get('X-Export-Truncated') === '1'")
    expect(doExport).toContain("res.headers.get('X-Export-Rows')")
    expect(doExport).toContain('markAfterExport(')
    expect(doExport).toContain('{ truncated, rows },')
  })

  test('the toasts name the real cap and the number of rows exported', () => {
    expect(doExport).toContain("Export stopped at ${(cap > 0 ? cap : 10_000).toLocaleString('en-US')} rows")
    expect(doExport).toContain("`Exported ${rows.toLocaleString('en-US')} rows`")
  })

  test('the button says Preparing… and then the running count, and the count is reset when the export ends', () => {
    expect(src).toMatch(/const \[exportRows, setExportRows\]\s+= useState<number \| null>\(null\)/)
    expect(exportButton).toContain("exportRows === null ? 'Preparing…'")
    expect(exportButton).toContain("toLocaleString('en-US')} rows")
    expect(doExport).toContain('setExportRows(null)')
  })
})
