import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('projection-scope-cron source contract', () => {
  const source = readFileSync(new URL('../lib/projection-scope-cron.ts', import.meta.url), 'utf8')

  test('uses the shared scheduler instead of its own timers', () => {
    expect(source).toContain("import { msUntilNextRun, scheduleEveryHoursFromAnchor } from '@/lib/daily-schedule'")
    expect(source).toContain('scheduleEveryHoursFromAnchor(')
    expect(source).not.toContain('setInterval(')
    expect(source).not.toContain('setTimeout(')
  })
  test('anchors to 05:00 UTC, one hour after the dedup cron', () => {
    expect(source).toContain('anchorHourUtc: 5')
  })
})
