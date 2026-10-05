import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  parseImportedRange, importedRangeFromSearchParams, hasImportedRange,
  epochToIso, importedRangeEcho, importedRangeEchoIfSet, importedWindowHeaders, importedWindowTag,
  importedRangePlain, importedRangeProjection, importedRangeAndSql, planImportedRange,
  type ImportedRange,
} from '@/lib/imported-range'
import { IMPORTED_KEY_EXPR, resetNewestFirstReadyCache } from '@/lib/newest-first'

// 2026-10-05T14:37:00Z
const T = Date.UTC(2026, 9, 5, 14, 37, 0) / 1000

function range(input: Parameters<typeof parseImportedRange>[0]): ImportedRange {
  const parsed = parseImportedRange(input)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.range
}
const error = (input: Parameters<typeof parseImportedRange>[0]) => {
  const parsed = parseImportedRange(input)
  return parsed.ok ? null : parsed.error
}

describe('parseImportedRange — what each form means', () => {
  test('nothing given: open on both sides', () => {
    expect(range({})).toEqual({ lower: null, upper: null })
    expect(range({ imported_after: '', imported_before: '   ', date_from: null, date_to: undefined })).toEqual({ lower: null, upper: null })
  })

  test('a bare date after: the whole UTC day is included, so the exclusive bound is one second before midnight', () => {
    expect(range({ imported_after: '2026-10-05' }).lower).toBe(Date.UTC(2026, 9, 5) / 1000 - 1)
  })

  test('a bare date before: the whole UTC day is included, to 23:59:59', () => {
    expect(range({ imported_before: '2026-10-05' }).upper).toBe(Date.UTC(2026, 9, 5, 23, 59, 59) / 1000)
  })

  test.each([
    ['space separator, no zone (UTC)', '2026-10-05 14:37:00'],
    ['T separator, no zone (UTC)', '2026-10-05T14:37:00'],
    ['Z', '2026-10-05T14:37:00Z'],
    ['lower-case z', '2026-10-05T14:37:00z'],
    ['+00:00', '2026-10-05T14:37:00+00:00'],
    ['fractional seconds are floored', '2026-10-05T14:37:00.999Z'],
    ['surrounding whitespace is trimmed', '  2026-10-05T14:37:00Z  '],
  ])('an exact instant, %s', (_name, text) => {
    expect(range({ imported_after: text }).lower).toBe(T)
    expect(range({ imported_before: text }).upper).toBe(T)
  })

  test.each([
    ['-05:00', '2026-10-05T09:37:00-05:00'],
    ['-0500 (no colon)', '2026-10-05T09:37:00-0500'],
    ['+02:00', '2026-10-05T16:37:00+02:00'],
    ['+05:30', '2026-10-05T20:07:00+05:30'],
  ])('an offset is converted to the same UTC instant, %s', (_name, text) => {
    expect(range({ imported_after: text }).lower).toBe(T)
  })

  test('an offset can move the instant across a UTC date line', () => {
    expect(range({ imported_after: '2026-10-05T23:30:00-05:00' }).lower).toBe(Date.UTC(2026, 9, 6, 4, 30, 0) / 1000)
  })

  test('the legacy date_from / date_to mean exactly what they always did (whole UTC days)', () => {
    expect(range({ date_from: '2026-10-05' }).lower).toBe(Date.UTC(2026, 9, 5) / 1000 - 1)
    expect(range({ date_to: '2026-10-05' }).upper).toBe(Date.UTC(2026, 9, 5, 23, 59, 59) / 1000)
    // imported_at >= '2026-10-05 00:00:00' (the old SQL) is imported_at > midnight - 1 s for a second-precision column
    expect(range({ date_from: '2026-10-05' })).toEqual(range({ imported_after: '2026-10-05' }))
  })

  test('both spellings given: the stricter bound wins on each side', () => {
    expect(range({ imported_after: '2026-10-05T14:37:00Z', date_from: '2026-10-01' }).lower).toBe(T)
    expect(range({ imported_after: '2026-10-01', date_from: '2026-10-05T14:37:00Z' }).lower).toBe(T)
    expect(range({ imported_before: '2026-10-05T14:37:00Z', date_to: '2026-10-09' }).upper).toBe(T)
    expect(range({ imported_before: '2026-10-09', date_to: '2026-10-05T14:37:00Z' }).upper).toBe(T)
  })

  test('a window with the lower bound at or above the upper bound is valid and simply matches nothing', () => {
    // after the last second of the 5th (exclusive) up to the last second of the 5th (inclusive): the two bounds meet, nothing is inside
    const r = range({ imported_after: '2026-10-06', imported_before: '2026-10-05' })
    expect(r.lower).toBeGreaterThanOrEqual(r.upper!)
  })

  test('chained windows tile: (previous before, next before] has no overlap and no gap', () => {
    const first = range({ imported_before: '2026-10-05T14:35:00Z' })
    const next = range({ imported_after: '2026-10-05T14:35:00Z', imported_before: '2026-10-05T15:00:00Z' })
    expect(next.lower).toBe(first.upper)
  })

  test('a leap day is a real date', () => {
    expect(range({ imported_after: '2028-02-29T00:00:00Z' }).lower).toBe(Date.UTC(2028, 1, 29) / 1000)
  })
})

describe('parseImportedRange — rejects, naming the parameter', () => {
  test.each([
    'yesterday', '2026-10-05T14:37', '2026-10-5', '20261005', '2026-13-01', '2026-02-30', '2026-10-05T24:00:00Z',
    '2026-10-05T14:60:00Z', '2026-10-05T14:37:60Z', '2026-10-05T14:37:00+24:00', '2026-10-05T14:37:00+05:60',
    '2026-10-05T14:37:00 UTC', '0001-01-01', "2026-10-05'; DROP TABLE x", '1787959800',
  ])('not an accepted form: %j', text => {
    const message = error({ imported_after: text })
    expect(message).toMatch(/^imported_after must be a date/)
    expect(message).toContain('2026-10-05T14:37:00-05:00')
  })

  test('the parameter name in the message is the one that was wrong', () => {
    expect(error({ imported_before: 'x' })).toMatch(/^imported_before must be/)
    expect(error({ date_from: 'x' })).toMatch(/^date_from must be/)
    expect(error({ date_to: 'x' })).toMatch(/^date_to must be/)
  })

  test('values that are not strings', () => {
    expect(error({ imported_after: 20261005 })).toMatch(/^imported_after must be/)
    expect(error({ imported_after: ['2026-10-05'] })).toMatch(/^imported_after must be/)
    expect(error({ imported_before: {} })).toMatch(/^imported_before must be/)
    expect(error({ imported_before: true })).toMatch(/^imported_before must be/)
  })

  test('outside the range ClickHouse DateTime can hold', () => {
    expect(error({ imported_after: '1969-12-31T23:59:59Z' })).toMatch(/^imported_after is outside the supported range/)
    expect(error({ imported_before: '2106-02-07T06:28:16Z' })).toMatch(/^imported_before is outside the supported range/)
    expect(range({ imported_before: '2106-02-07T06:28:15Z' }).upper).toBe(4_294_967_295)
  })

  test('edge dates that clamp instead of failing', () => {
    expect(range({ imported_after: '1970-01-01' }).lower).toBeNull() // "one second before 1970" is just "everything"
    expect(range({ imported_before: '2106-02-07' }).upper).toBe(4_294_967_295) // the end of that day is past what DateTime holds
  })

  test('the first bad parameter wins even when a later one is fine', () => {
    expect(error({ imported_after: 'nope', imported_before: '2026-10-05' })).toMatch(/^imported_after/)
  })
})

describe('importedRangeFromSearchParams / hasImportedRange', () => {
  test('reads all four names from a query string', () => {
    const sp = new URLSearchParams('imported_after=2026-10-05T14:37:00Z&imported_before=2026-10-06&date_from=2026-10-01&date_to=2026-10-09')
    const parsed = importedRangeFromSearchParams(sp)
    expect(parsed.ok && parsed.range).toEqual({ lower: T, upper: Date.UTC(2026, 9, 6, 23, 59, 59) / 1000 })
  })

  test('an empty query string is an open range', () => {
    const parsed = importedRangeFromSearchParams(new URLSearchParams(''))
    expect(parsed.ok && hasImportedRange(parsed.range)).toBe(false)
    expect(hasImportedRange({ lower: 1, upper: null })).toBe(true)
    expect(hasImportedRange({ lower: null, upper: 1 })).toBe(true)
  })
})

describe('echo, headers and file-name tag', () => {
  test('epochToIso is second-precision UTC', () => {
    expect(epochToIso(T)).toBe('2026-10-05T14:37:00Z')
  })

  test('the echo is the EFFECTIVE window, so a caller can chain it directly', () => {
    expect(importedRangeEcho({ lower: T, upper: null })).toEqual({ imported_after: '2026-10-05T14:37:00Z', imported_before: null })
    expect(importedRangeEcho(range({ imported_before: '2026-10-05' }))).toEqual({ imported_after: null, imported_before: '2026-10-05T23:59:59Z' })
  })

  test('the echo is left out entirely when no bound was given, so existing response shapes do not change', () => {
    expect(importedRangeEchoIfSet({ lower: null, upper: null })).toEqual({})
    expect(importedRangeEchoIfSet({ lower: T, upper: null })).toEqual({ imported_after: '2026-10-05T14:37:00Z', imported_before: null })
  })

  test('headers only for the bounds that are set', () => {
    expect(importedWindowHeaders({ lower: null, upper: null })).toEqual({})
    expect(importedWindowHeaders({ lower: T, upper: T + 3600 })).toEqual({
      'X-Export-Imported-After': '2026-10-05T14:37:00Z',
      'X-Export-Imported-Before': '2026-10-05T15:37:00Z',
    })
  })

  test('the file-name suffix is empty, one-sided or two-sided, with characters that are safe in a file name', () => {
    expect(importedWindowTag({ lower: null, upper: null })).toBe('')
    expect(importedWindowTag({ lower: T, upper: null })).toBe('_after-20261005T143700Z')
    expect(importedWindowTag({ lower: null, upper: T })).toBe('_before-20261005T143700Z')
    expect(importedWindowTag({ lower: T, upper: T + 3600 })).toBe('_after-20261005T143700Z_before-20261005T153700Z')
    expect(importedWindowTag({ lower: T, upper: T + 3600 })).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('the SQL forms', () => {
  test('plain: the column stays bare on the left, bounds are Int64 parameters, nothing for an open side', () => {
    expect(importedRangePlain({ lower: null, upper: null })).toEqual({ conditions: [], params: {} })
    expect(importedRangePlain({ lower: T, upper: null })).toEqual({
      conditions: ['imported_at > toDateTime({impAfter:Int64})'],
      params: { impAfter: T },
    })
    expect(importedRangePlain({ lower: T, upper: T + 60 })).toEqual({
      conditions: ['imported_at > toDateTime({impAfter:Int64})', 'imported_at <= toDateTime({impBefore:Int64})'],
      params: { impAfter: T, impBefore: T + 60 },
    })
  })

  test('projection: the plain bounds plus the same bounds on proj_imported_desc\'s key expression, negated and swapped', () => {
    const sql = importedRangeProjection({ lower: T, upper: T + 60 })
    expect(sql.conditions).toEqual([
      'imported_at > toDateTime({impAfter:Int64})',
      'imported_at <= toDateTime({impBefore:Int64})',
      `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`,
      `${IMPORTED_KEY_EXPR} >= {impKeyLo:Int64}`,
    ])
    expect(sql.params).toEqual({ impAfter: T, impBefore: T + 60, impKeyHi: -T, impKeyLo: -(T + 60) })
  })

  test('projection with only a lower bound has no upper key predicate', () => {
    const sql = importedRangeProjection({ lower: T, upper: null })
    expect(sql.conditions).toHaveLength(2)
    expect(sql.params).toEqual({ impAfter: T, impKeyHi: -T })
  })

  test('the key predicate is the exact string lib/newest-first.ts pins as the only form that range-prunes the projection', () => {
    expect(importedRangeProjection({ lower: T, upper: null }).conditions[1]).toBe('negate(toUnixTimestamp(imported_at)) < {impKeyHi:Int64}')
  })

  test('a zero bound does not turn into a negative zero', () => {
    const sql = importedRangeProjection({ lower: 0, upper: 0 })
    expect(Object.is(sql.params.impKeyHi, 0)).toBe(true)
    expect(Object.is(sql.params.impKeyLo, 0)).toBe(true)
  })

  test('neither form ever touches skip indexes or projections settings', () => {
    for (const sql of [importedRangePlain({ lower: T, upper: T + 1 }), importedRangeProjection({ lower: T, upper: T + 1 })]) {
      expect(sql.conditions.join(' ')).not.toMatch(/use_skip_indexes|optimize_use_projections|SETTINGS/i)
    }
  })

  test('importedRangeAndSql prefixes every condition with AND for string-built WHEREs', () => {
    expect(importedRangeAndSql({ conditions: [], params: {} })).toBe('')
    expect(importedRangeAndSql(importedRangePlain({ lower: T, upper: T + 1 }))).toBe(
      ' AND imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})',
    )
  })
})

describe('planImportedRange — the projection form only where it is safe and useful', () => {
  const READY = [{ defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }]
  const NOT_READY = [{ defined: 0, parts: 1, with_projection: 0, covered_from: 0 }]
  let run: ReturnType<typeof vi.fn>
  const ctx = (over: Partial<Parameters<typeof planImportedRange>[1]> = {}) => ({ shape: 'time' as const, indexNeutral: true, run, ...over })
  const hasKey = (sql: { conditions: string[] }) => sql.conditions.some(c => c.includes(IMPORTED_KEY_EXPR))

  beforeEach(() => {
    resetNewestFirstReadyCache()
    run = vi.fn().mockResolvedValue(READY)
  })

  test('time-ordered, index-neutral, lower bound set, projection ready: the projection form', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx()))).toBe(true)
  })

  test('an aggregate (totals, DISTINCT, GROUP BY) gets it too', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx({ shape: 'aggregate' })))).toBe(true)
  })

  test('another order (domain, email, password length) or a key-narrowed lookup: plain, and the readiness query is not even run', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx({ shape: 'other' })))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  test('a word, LIKE-fallback or regex search is not index-neutral: plain (a projection part has no text index)', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx({ indexNeutral: false })))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  test('no lower bound (only an upper one, or none): plain', async () => {
    expect(hasKey(await planImportedRange({ lower: null, upper: T }, ctx()))).toBe(false)
    expect(hasKey(await planImportedRange({ lower: null, upper: null }, ctx()))).toBe(false)
  })

  test('the projection is not ready: plain, never wrong', async () => {
    run.mockResolvedValue(NOT_READY)
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx()))).toBe(false)
  })

  test('the readiness check fails: plain (it fails closed)', async () => {
    run.mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx()))).toBe(false)
    warn.mockRestore()
  })

  test('both forms select the same rows: the projection form is the plain one plus an equivalent predicate on the key', async () => {
    const plain = importedRangePlain({ lower: T, upper: T + 60 })
    const projection = await planImportedRange({ lower: T, upper: T + 60 }, ctx())
    expect(projection.conditions.slice(0, plain.conditions.length)).toEqual(plain.conditions)
    expect(projection.params).toMatchObject(plain.params)
  })
})
