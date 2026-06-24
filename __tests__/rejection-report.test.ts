import { describe, test, expect } from 'vitest'
import { REASON_LABELS, buildRecommendations, buildTopRejections } from '@/lib/rejection-report'
import { REASON_LABELS as RL } from '@/lib/rejection-report'
import { makeRejectionMap as mkMap } from '@/lib/ulp-parser'

describe('parse-sample-report', () => {
  describe('REASON_LABELS', () => {
    test('covers every rejection reason, including garbage and dedup', () => {
      for (const k of ['blank', 'no_fields', 'no_password', 'dedup', 'garbage']) {
        expect(REASON_LABELS[k]).toBeTruthy()
      }
    })
  })

  describe('buildTopRejections', () => {
    test('keeps only non-zero reasons, sorts by count desc, labels, computes pct', () => {
      const breakdown = { blank: 5, no_fields: 0, no_password: 2, dedup: 0, garbage: 10 }
      const top = buildTopRejections(breakdown, 100)
      expect(top.map(t => t.reason)).toEqual(['garbage', 'blank', 'no_password'])
      expect(top[0]).toMatchObject({ reason: 'garbage', count: 10, pct: 10 })
      expect(top[0].label).toContain('Non-credential')
    })

    test('falls back to the raw reason as label for unknown reasons', () => {
      const top = buildTopRejections({ weird_reason: 4 }, 8)
      expect(top[0]).toMatchObject({ reason: 'weird_reason', label: 'weird_reason', pct: 50 })
    })

    test('caps at 8 reasons', () => {
      const breakdown: Record<string, number> = {}
      for (let i = 0; i < 12; i++) breakdown[`r${i}`] = i + 1
      expect(buildTopRejections(breakdown, 100)).toHaveLength(8)
    })

    test('total=0 yields pct 0 (no divide-by-zero)', () => {
      const top = buildTopRejections({ garbage: 3 }, 0)
      expect(top[0].pct).toBe(0)
    })
  })

  describe('buildRecommendations', () => {
    test('flags a high garbage share', () => {
      const recs = buildRecommendations({ garbage: 30 }, 100, 70)
      expect(recs.some(r => r.startsWith('[garbage]'))).toBe(true)
    })

    test('flags high no_fields and no_password shares', () => {
      const recs = buildRecommendations({ no_fields: 20, no_password: 10 }, 100, 70)
      expect(recs.some(r => r.startsWith('[no_fields]'))).toBe(true)
      expect(recs.some(r => r.startsWith('[no_password]'))).toBe(true)
    })

    test('adds a low-import-rate caution only when no reason-specific rec fired', () => {
      const recs = buildRecommendations({ blank: 60 }, 100, 40)
      expect(recs.some(r => r.includes('below 50%'))).toBe(true)
    })

    test('no low-rate caution when a reason rec already fired', () => {
      const recs = buildRecommendations({ no_fields: 60 }, 100, 40)
      expect(recs.some(r => r.includes('below 50%'))).toBe(false)
      expect(recs.some(r => r.startsWith('[no_fields]'))).toBe(true)
    })

    test('adds a healthy-rate note when importPct >= 80', () => {
      const recs = buildRecommendations({}, 100, 85)
      expect(recs.some(r => r.includes('healthy'))).toBe(true)
    })
  })
})

describe('tier_dropped reason', () => {
  it('is a labeled, zero-initialized rejection reason', () => {
    expect(mkMap().tier_dropped).toBe(0)
    expect(typeof RL.tier_dropped).toBe('string')
    expect(RL.tier_dropped.length).toBeGreaterThan(0)
  })
})
