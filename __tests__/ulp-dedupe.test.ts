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
    test('counts distinct credentials via uniq() over the hash column when deduping', () => {
      expect(dedupeCountExpr(true)).toBe('uniq(content_key_hash)')
    })
    test('plain count() when not deduping', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
    })
  })
})
