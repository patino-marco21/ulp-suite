import { describe, test, expect } from 'vitest'
import {
  parseTotals,
  recordsLabel,
  resultsLabel,
  totalsParams,
  withPendingTotals,
  withTotals,
} from '@/lib/credential-totals'

const page = { results: ['a'], total: 5, raw_total: 8 as number | null }

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
