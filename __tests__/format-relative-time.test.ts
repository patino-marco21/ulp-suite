/**
 * lib/format-relative-time.ts turns a SQLite datetime('now') string
 * ("YYYY-MM-DD HH:MM:SS", no timezone marker, always UTC) into relative
 * text for the saved-searches hub's last-viewed indicator. The dedicated
 * UTC-handling test below exists because without an explicit "Z", JS parses
 * that space-separated form as *local* time — so on any machine not
 * running in UTC, a naive implementation would silently produce a wrong
 * offset. A test that only runs in UTC would never catch that.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatRelativeTime } from '@/lib/format-relative-time'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatRelativeTime', () => {
  test('under a minute reads "Just now"', () => {
    vi.setSystemTime(new Date('2026-08-24T10:00:30Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('Just now')
  })

  test('singular minute', () => {
    vi.setSystemTime(new Date('2026-08-24T10:01:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('1 minute ago')
  })

  test('plural minutes', () => {
    vi.setSystemTime(new Date('2026-08-24T10:05:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('5 minutes ago')
  })

  test('singular hour', () => {
    vi.setSystemTime(new Date('2026-08-24T11:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('1 hour ago')
  })

  test('plural hours', () => {
    vi.setSystemTime(new Date('2026-08-24T13:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('3 hours ago')
  })

  test('plural days', () => {
    vi.setSystemTime(new Date('2026-08-26T10:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('2 days ago')
  })

  test('treats the SQLite string as UTC regardless of the host timezone', () => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      vi.setSystemTime(new Date('2026-08-24T10:05:00Z'))
      // A naive `new Date(dateStr)` parse would read '2026-08-24 10:00:00'
      // as 10:00 America/New_York (UTC-4 in August), i.e. 14:00 UTC — after
      // the fake "now" of 10:05 UTC, producing a negative diff clamped to
      // "Just now" instead of the correct "5 minutes ago".
      expect(formatRelativeTime('2026-08-24 10:00:00')).toBe('5 minutes ago')
    } finally {
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    }
  })

  test('clamps a timestamp that is in the future (clock skew) to "Just now" rather than negative', () => {
    vi.setSystemTime(new Date('2026-08-24T10:00:00Z'))
    expect(formatRelativeTime('2026-08-24 10:05:00')).toBe('Just now')
  })
})
