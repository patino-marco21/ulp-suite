import { describe, expect, it } from 'vitest'
import { sumTimings } from '@/lib/phase-timings'

describe('sumTimings', () => {
  it('is zero for nothing', () => {
    expect(sumTimings([])).toEqual({ parse_ms: 0, check_ms: 0, insert_ms: 0 })
  })

  it('adds the three phases of several imports (the entries of a ZIP)', () => {
    expect(sumTimings([
      { timings: { parse_ms: 10, check_ms: 20, insert_ms: 30 } },
      { timings: { parse_ms: 1, check_ms: 2, insert_ms: 3 } },
    ])).toEqual({ parse_ms: 11, check_ms: 22, insert_ms: 33 })
  })

  it('an import that has no timings adds nothing', () => {
    expect(sumTimings([{ timings: { parse_ms: 5, check_ms: 6, insert_ms: 7 } }, {}, undefined]))
      .toEqual({ parse_ms: 5, check_ms: 6, insert_ms: 7 })
  })

  it('returns a new object and leaves its input alone', () => {
    const first = { timings: { parse_ms: 1, check_ms: 1, insert_ms: 1 } }
    const out = sumTimings([first, first])
    expect(out).toEqual({ parse_ms: 2, check_ms: 2, insert_ms: 2 })
    expect(first.timings).toEqual({ parse_ms: 1, check_ms: 1, insert_ms: 1 })
    expect(out).not.toBe(first.timings)
  })
})
