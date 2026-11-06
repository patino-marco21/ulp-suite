import { describe, expect, it } from 'vitest'
import { sumTimings } from '@/lib/phase-timings'

describe('sumTimings', () => {
  it('is zero for nothing', () => {
    expect(sumTimings([])).toEqual({ parse_ms: 0, check_ms: 0, insert_ms: 0, lock_wait_ms: 0 })
  })

  it('adds the three phases of several imports (the entries of a ZIP)', () => {
    expect(sumTimings([
      { timings: { parse_ms: 10, check_ms: 20, insert_ms: 30 } },
      { timings: { parse_ms: 1, check_ms: 2, insert_ms: 3 } },
    ])).toEqual({ parse_ms: 11, check_ms: 22, insert_ms: 33, lock_wait_ms: 0 })
  })

  it('an import that has no timings adds nothing', () => {
    expect(sumTimings([{ timings: { parse_ms: 5, check_ms: 6, insert_ms: 7 } }, {}, undefined]))
      .toEqual({ parse_ms: 5, check_ms: 6, insert_ms: 7, lock_wait_ms: 0 })
  })

  it('adds the wait for the commit lock too, and an import that has none adds 0', () => {
    expect(sumTimings([
      { timings: { parse_ms: 1, check_ms: 2, insert_ms: 3, lock_wait_ms: 400 } },
      { timings: { parse_ms: 1, check_ms: 2, insert_ms: 3, lock_wait_ms: 50 } },
      { timings: { parse_ms: 1, check_ms: 2, insert_ms: 3 } },
    ])).toEqual({ parse_ms: 3, check_ms: 6, insert_ms: 9, lock_wait_ms: 450 })
  })

  it('returns a new object and leaves its input alone', () => {
    const first = { timings: { parse_ms: 1, check_ms: 1, insert_ms: 1 } }
    const out = sumTimings([first, first])
    expect(out).toEqual({ parse_ms: 2, check_ms: 2, insert_ms: 2, lock_wait_ms: 0 })
    expect(first.timings).toEqual({ parse_ms: 1, check_ms: 1, insert_ms: 1 })
    expect(out).not.toBe(first.timings)
  })
})
