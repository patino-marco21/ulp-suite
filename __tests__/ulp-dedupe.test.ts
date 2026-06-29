import { describe, test, expect } from 'vitest'
import { DEDUPE_BY, dedupeLimitBy, dedupeCountExpr } from '@/lib/ulp-dedupe'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('ulp-dedupe', () => {
  test('DEDUPE_BY is the content key (scheme/slash-insensitive url, email, password)', () => {
    expect(DEDUPE_BY).toBe(`${URL_CONTENT_KEY}, email, password`)
  })

  describe('dedupeLimitBy', () => {
    test('emits `LIMIT 1 BY <content key>` when deduping', () => {
      expect(dedupeLimitBy(true)).toBe(`LIMIT 1 BY ${URL_CONTENT_KEY}, email, password`)
    })
    test('emits nothing when not deduping (keep every copy)', () => {
      expect(dedupeLimitBy(false)).toBe('')
    })
  })

  describe('dedupeCountExpr', () => {
    test('counts distinct credentials via uniq() when deduping', () => {
      expect(dedupeCountExpr(true)).toBe(`uniq(${URL_CONTENT_KEY}, email, password)`)
    })
    test('plain count() when not deduping', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
    })
  })
})
