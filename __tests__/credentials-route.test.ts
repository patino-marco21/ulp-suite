import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('credentials route — dedupe + non-domain-sort memory cap (MEMORY_LIMIT_EXCEEDED regression)', () => {
  const source = readFileSync(new URL('../app/api/credentials/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('defines a named external-sort memory cap constant at 4 GiB', () => {
    expect(source).toMatch(/SORT_MAX_MEMORY_BYTES\s*=\s*4_294_967_296/)
  })

  test('main query settings force an external (disk-spill) sort', () => {
    // Confirmed live against ulp.credentials (91M rows): with dedupe=1, any sort
    // whose leading column isn't `domain` (the table's actual primary-key leading
    // column) hits MEMORY_LIMIT_EXCEEDED (code 241) — ClickHouse's
    // `ORDER BY ... LIMIT 1 BY <key> ... LIMIT n` can't bound the sort to the
    // primary key or to proj_imported_desc once LIMIT BY is present, so it fully
    // materializes and sorts the filtered set first, regardless of the final
    // LIMIT. This setting converts that crash into a slower (~16-30s) but
    // successful query instead.
    expect(getFn).toContain('max_bytes_before_external_sort = ${SORT_MAX_MEMORY_BYTES}')
  })

  test('does not drop the existing execution-time/timeout settings', () => {
    expect(getFn).toContain('max_execution_time = 300')
    expect(getFn).toContain(`timeout_overflow_mode = 'throw'`)
  })
})

describe('credentials route — raw_total (unfiltered count alongside the noise/dedupe-filtered total)', () => {
  const source = readFileSync(new URL('../app/api/credentials/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('builds a WHERE clause without the noise filter, for the raw total', () => {
    expect(source).toMatch(/whereRaw\s*=/)
  })

  test('computes raw_total as a plain count(), not uniq(), in the same scan as the total', () => {
    // One query yields both numbers (it used to be two scans of the same predicate: 13.9 s + 32.6 s in
    // parallel vs 11.0 s measured cold for a domain-token search); see credentials-route-totals.test.ts.
    expect(getFn).toMatch(/count\(\) AS raw_total\s+FROM ulp\.credentials WHERE \$\{whereRaw\}/)
  })

  test('response includes raw_total', () => {
    expect(getFn).toMatch(/raw_total\s*[,:]/)
  })
})

describe('credentials route — Unique total skips the hash scan when nothing is filtered (measured 5.57 s -> 0.19 s on 1.39B rows)', () => {
  const source = readFileSync(new URL('../app/api/credentials/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('derives hasUserFilter from the raw conditions and the tier / login-type extras', () => {
    expect(getFn).toMatch(/const hasUserFilter\s*=\s*conditionsRaw\.length > 1 \|\| tierExtra !== '' \|\| loginTypeExtra !== ''/)
  })

  test('passes it to dedupeCountExpr for the total', () => {
    expect(getFn).toContain('dedupeCountExpr(dedupe, hasUserFilter,')
  })
})
