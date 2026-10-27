import { describe, test, expect } from 'vitest'
import {
  appliedViewOf,
  matchingHint,
  matchingLabel,
  parseTotals,
  recordsLabel,
  resultsLabel,
  totalsParams,
  withPendingTotals,
  type TotalsFields,
  withTotals,
} from '@/lib/credential-totals'

const page: TotalsFields & { results: string[] } = { results: ['a'], total: 5, raw_total: 8 }

describe('withPendingTotals', () => {
  test('marks the rows as showing with their count still pending, and drops any stale count', () => {
    const p = withPendingTotals(page)
    expect(p).toMatchObject({ total: 0, raw_total: null, totalPending: true, totalFailed: false, results: ['a'] })
  })
})

describe('withTotals', () => {
  test('merges the answer into the page that is showing and clears the pending flag', () => {
    const pending = withPendingTotals(page)
    expect(withTotals(pending, { total: 1_233_798, raw_total: 1_232_511 })).toMatchObject({
      total: 1_233_798, raw_total: 1_232_511, totalPending: false, totalFailed: false, results: ['a'],
    })
  })
  test('a failed request leaves the rows valid and flags the count as unavailable', () => {
    const out = withTotals(withPendingTotals(page), null)
    expect(out).toMatchObject({ totalPending: false, totalFailed: true, results: ['a'] })
  })
  test('does nothing when there is no page any more', () => {
    expect(withTotals(null, { total: 1, raw_total: 1 })).toBeNull()
  })
  test('does not mutate its input', () => {
    const pending = withPendingTotals(page)
    withTotals(pending, { total: 9, raw_total: 9 })
    expect(pending.totalPending).toBe(true)
    expect(pending.total).toBe(0)
  })
})

describe('totalsParams', () => {
  test('keeps the filters, drops the cursor and skip_totals, adds totals_only', () => {
    const src = new URLSearchParams({ q: 'binance.com', sort: 'domain_asc', dedupe: '1', cursor: 'abc', skip_totals: '1', limit: '200' })
    const out = totalsParams(src)
    expect(out.get('q')).toBe('binance.com')
    expect(out.get('dedupe')).toBe('1')
    expect(out.get('totals_only')).toBe('1')
    expect(out.has('cursor')).toBe(false)
    expect(out.has('skip_totals')).toBe(false)
  })
  test('does not mutate the original params', () => {
    const src = new URLSearchParams({ q: 'x', cursor: 'c' })
    totalsParams(src)
    expect(src.get('cursor')).toBe('c')
    expect(src.has('totals_only')).toBe(false)
  })
})

describe('parseTotals', () => {
  test('reads a totals_only success', () => {
    expect(parseTotals({ success: true, total: 7, raw_total: 9, query_ms: 12 })).toEqual({ total: 7, raw_total: 9 })
  })
  test('tolerates a missing raw_total', () => {
    expect(parseTotals({ success: true, total: 7 })).toEqual({ total: 7, raw_total: null })
  })
  test.each([null, undefined, 'x', {}, { success: false, total: 1 }, { success: true }, { success: true, total: 'nope' }, { success: true, total: NaN }])(
    'rejects %j',
    bad => {
      expect(parseTotals(bad)).toBeNull()
    },
  )
})

describe('labels', () => {
  test('recordsLabel: counting, failed, and done', () => {
    expect(recordsLabel(withPendingTotals(page))).toBe('Counting…')
    expect(recordsLabel({ ...page, totalFailed: true })).toBe('Count unavailable')
    expect(recordsLabel({ total: 1234567 })).toBe(`${(1234567).toLocaleString()} records`)
  })
  test('resultsLabel: placeholder while counting, dash on failure, count when done, empty without a page', () => {
    expect(resultsLabel(withPendingTotals(page))).toBe('…')
    expect(resultsLabel({ ...page, totalFailed: true })).toBe('—')
    expect(resultsLabel({ total: 42 })).toBe(`${(42).toLocaleString()} results`)
    expect(resultsLabel(null)).toBe('')
    expect(resultsLabel(undefined)).toBe('')
  })
})

describe('matchingLabel and matchingHint — what the dim "of N" in the header counts', () => {
  const n = (x: number) => x.toLocaleString()
  const hidden: TotalsFields = { total: 3036, raw_total: 5025 }

  test('with a search or filter it says "matching", with none it says "total imported"', () => {
    expect(matchingLabel(hidden, true)).toBe(`of ${n(5025)} matching`)
    expect(matchingLabel(hidden, false)).toBe(`of ${n(5025)} total imported`)
  })

  test('nothing is said while counting, after a failed count, or when no row is hidden', () => {
    expect(matchingLabel(withPendingTotals(hidden), true)).toBeNull()
    expect(matchingLabel({ ...hidden, totalFailed: true }, true)).toBeNull()
    expect(matchingLabel({ total: 5025, raw_total: 5025 }, true)).toBeNull()
    expect(matchingLabel({ total: 5025, raw_total: null }, true)).toBeNull()
    expect(matchingLabel({ total: 5025 }, true)).toBeNull()
  })

  test('the tooltip says how many rows match, how many the view shows and what hides the rest', () => {
    expect(matchingHint(hidden, { declutter: true, unique: true }, true)).toBe(
      `${n(5025)} rows match this search; this view shows ${n(3036)}. ` +
      'Declutter hides .php pages, IP-address hosts, URLs with a :port and mangled hosts; ' +
      'Unique shows one row per credential (counted approximately). Turn them off to see every row.',
    )
  })

  test('with no search the rows are the imported ones, not matches', () => {
    expect(matchingHint(hidden, { declutter: true, unique: true }, false)).toContain(`${n(5025)} rows are imported; this view shows ${n(3036)}.`)
  })

  test('only the chips that are on are named', () => {
    const declutterOnly = matchingHint(hidden, { declutter: true, unique: false }, true)!
    expect(declutterOnly).toContain('Declutter hides')
    expect(declutterOnly).not.toContain('Unique')
    expect(declutterOnly).toContain('Turn it off to see every row.')
    const uniqueOnly = matchingHint(hidden, { declutter: false, unique: true }, true)!
    expect(uniqueOnly).toContain('Unique shows one row per credential')
    expect(uniqueOnly).not.toContain('Declutter')
  })

  test('there is no tooltip when there is nothing to explain', () => {
    expect(matchingHint({ total: 5025, raw_total: 5025 }, { declutter: true, unique: true }, true)).toBeUndefined()
    expect(matchingHint(withPendingTotals(hidden), { declutter: true, unique: true }, true)).toBeUndefined()
  })
})

describe('appliedViewOf — the view a request asked for, read from its own parameters', () => {
  const p = (s: string) => new URLSearchParams(s)

  test('the chips are the exclude_noise and dedupe parameters', () => {
    expect(appliedViewOf(p('limit=200&sort=domain_asc&exclude_noise=1&dedupe=1'))).toMatchObject({ declutter: true, unique: true })
    expect(appliedViewOf(p('limit=200&sort=domain_asc&dedupe=1'))).toMatchObject({ declutter: false, unique: true })
    expect(appliedViewOf(p('limit=200&sort=domain_asc&exclude_noise=1'))).toMatchObject({ declutter: true, unique: false })
    expect(appliedViewOf(p('limit=200&sort=domain_asc'))).toMatchObject({ declutter: false, unique: false })
  })

  test('with nothing but the sort, the page size, the page and the chips it is not a filtered view', () => {
    expect(appliedViewOf(p('limit=200&sort=domain_asc&exclude_noise=1&dedupe=1')).filtered).toBe(false)
    expect(appliedViewOf(p('limit=200&sort=imported_desc&cursor=abc&skip_totals=1&totals_only=1')).filtered).toBe(false)
  })

  test.each([
    ['a search text', 'q=example.tld'],
    ['a scope', 'scope=login'],
    ['the Domain box', 'domain=example.tld'],
    ['a window', 'imported_after=2026-10-01T00%3A00%3A00.000Z'],
    ['a tier', 'tier_include=T1'],
    ['a host filter', 'url_host=example.tld'],
    ['a regex', 'regex=1'],
  ])('%s makes it a filtered view', (_what, qs) => {
    expect(appliedViewOf(p(`limit=200&sort=domain_asc&exclude_noise=1&dedupe=1&${qs}`)).filtered).toBe(true)
  })
})
