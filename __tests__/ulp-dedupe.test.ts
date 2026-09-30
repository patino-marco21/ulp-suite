import { describe, test, expect } from 'vitest'
import { DEDUPE_BY, dedupeLimitBy, dedupeCountExpr } from '@/lib/ulp-dedupe'

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
  })
})
