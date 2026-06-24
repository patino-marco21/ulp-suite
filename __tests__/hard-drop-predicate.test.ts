import { describe, it, expect } from 'vitest'
import { makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'

describe('makeHardDropPredicate', () => {
  it('returns undefined when no hard tiers are configured', () => {
    expect(makeHardDropPredicate(parseIngestPolicy({}))).toBeUndefined()
  })

  it('drops the configured hard tier and keeps the rest', () => {
    const pred = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' }))!
    expect(typeof pred).toBe('function')
    expect(pred('x@mail.ru', '')).toBe(true)      // mail.ru → T3 → drop
    expect(pred('x@comcast.net', '')).toBe(false) // T1 → keep
    expect(pred('x@web.de', '')).toBe(false)       // T2 → keep
    expect(pred('x@gmail.com', '')).toBe(false)    // untiered → keep
  })
})
