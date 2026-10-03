import { describe, test, expect } from 'vitest'
import { DEDUPE_BY, dedupeLimitBy, dedupeCountExpr, dedupeCountPartial } from '@/lib/ulp-dedupe'

describe('ulp-dedupe', () => {
  test('DEDUPE_BY is the precomputed content-key hash column', () => {
    expect(DEDUPE_BY).toBe('content_key_hash')
  })

  describe('dedupeLimitBy', () => {
    test('emits `LIMIT 1 BY content_key_hash` when deduping', () => {
      expect(dedupeLimitBy(true)).toBe('LIMIT 1 BY content_key_hash')
    })
    test('emits nothing when not deduping (keep every copy)', () => {
      expect(dedupeLimitBy(false)).toBe('')
    })
  })

  describe('dedupeCountExpr', () => {
    test('counts distinct credentials via uniq() over the hash column when deduping a filtered search', () => {
      expect(dedupeCountExpr(true, true)).toBe('uniq(content_key_hash)')
    })
    test('defaults to the uniq() form when the caller says nothing about filters (conservative)', () => {
      expect(dedupeCountExpr(true)).toBe('uniq(content_key_hash)')
    })
    test('plain count() for the unfiltered view: storage is deduped at rest, so the row count IS the distinct count and the 10 GiB hash column need not be scanned', () => {
      expect(dedupeCountExpr(true, false)).toBe('count()')
    })
    test('plain count() when not deduping, filtered or not', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
      expect(dedupeCountExpr(false, true)).toBe('count()')
      expect(dedupeCountExpr(false, false)).toBe('count()')
    })

    test('onlyIf turns the distinct form into uniqIf, so the noise filter can live inside the aggregate', () => {
      expect(dedupeCountExpr(true, true, 'is_noise = 0')).toBe('uniqIf(content_key_hash, is_noise = 0)')
    })
    test('onlyIf turns every non-distinct form into countIf', () => {
      expect(dedupeCountExpr(true, false, 'is_noise = 0')).toBe('countIf(is_noise = 0)')
      expect(dedupeCountExpr(false, true, 'is_noise = 0')).toBe('countIf(is_noise = 0)')
      expect(dedupeCountExpr(false, false, 'is_noise = 0')).toBe('countIf(is_noise = 0)')
    })
  })

  describe('dedupeCountPartial', () => {
    // Measured on the live table 2026-10-03 for a term with 1.23M credentials: one scan 1,234,432 unique; the SUM of the two
    // disjoint halves 1,234,344; uniqIfMerge over uniqIfState of the same halves 1,234,432, identical. Counts add exactly.
    test('the distinct forms hand back aggregate STATES and merge them, so two disjoint scans equal one scan', () => {
      const withNoise = dedupeCountPartial(true, true, 'is_noise = 0')
      expect(withNoise.partial).toBe('uniqIfState(content_key_hash, is_noise = 0)')
      expect(withNoise.combine('part_total')).toBe('uniqIfMerge(part_total)')
      const plain = dedupeCountPartial(true, true)
      expect(plain.partial).toBe('uniqState(content_key_hash)')
      expect(plain.combine('part_total')).toBe('uniqMerge(part_total)')
    })

    test('the count forms are plain counts that are summed', () => {
      expect(dedupeCountPartial(false, true).partial).toBe('count()')
      expect(dedupeCountPartial(false, true).combine('c')).toBe('sum(c)')
      expect(dedupeCountPartial(false, true, 'is_noise = 0').partial).toBe('countIf(is_noise = 0)')
      expect(dedupeCountPartial(true, false).partial).toBe('count()')
      expect(dedupeCountPartial(true, false, 'is_noise = 0').partial).toBe('countIf(is_noise = 0)')
    })

    test('defaults to the filtered, distinct form, like dedupeCountExpr', () => {
      expect(dedupeCountPartial(true).partial).toBe('uniqState(content_key_hash)')
    })

    test('chooses the same form as dedupeCountExpr for every input', () => {
      for (const dedupe of [true, false]) {
        for (const filtered of [true, false]) {
          for (const onlyIf of [undefined, 'is_noise = 0']) {
            const expr = dedupeCountExpr(dedupe, filtered, onlyIf)
            const { partial } = dedupeCountPartial(dedupe, filtered, onlyIf)
            // the state form is the plain aggregate with `State` after the function name
            expect(partial).toBe(expr.replace(/^uniqIf\(/, 'uniqIfState(').replace(/^uniq\(/, 'uniqState('))
          }
        }
      }
    })
  })
})
