import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import { msUntilNextRun } from '@/lib/dedup-cron'

describe('msUntilNextRun', () => {
  test('returns the delay until the target hour later today', () => {
    const now = new Date('2026-06-27T02:31:00Z')
    expect(msUntilNextRun(4, now)).toBe(89 * 60 * 1000) // 02:31 -> 04:00 = 89 min
  })

  test('rolls over to tomorrow when the target hour today has already passed', () => {
    const now = new Date('2026-06-27T05:00:00Z')
    const expected = Date.parse('2026-06-28T04:00:00Z') - now.getTime()
    expect(msUntilNextRun(4, now)).toBe(expected)
  })

  test('rolls over to tomorrow when now is exactly the target hour', () => {
    const now = new Date('2026-06-27T04:00:00.000Z')
    expect(msUntilNextRun(4, now)).toBe(24 * 60 * 60 * 1000)
  })
})

describe('dedup-cron source contract', () => {
  const source = readFileSync(new URL('../lib/dedup-cron.ts', import.meta.url), 'utf8')

  test('anchors the first tick to msUntilNextRun instead of a fixed 60s startup delay', () => {
    expect(source).toContain('msUntilNextRun(')
    expect(source).not.toContain('}, 60_000)')
  })
})
