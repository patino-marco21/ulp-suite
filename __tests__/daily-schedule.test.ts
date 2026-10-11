import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { msUntilNextRun, scheduleEveryHoursFromAnchor } from '@/lib/daily-schedule'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('msUntilNextRun', () => {
  it('is the delay until the anchor hour later today', () => {
    expect(msUntilNextRun(4, new Date('2026-06-27T02:31:00Z'))).toBe(89 * 60_000)
  })
  it('rolls over to tomorrow when the hour has passed or is exactly now', () => {
    expect(msUntilNextRun(4, new Date('2026-06-27T05:00:00Z'))).toBe(Date.parse('2026-06-28T04:00:00Z') - Date.parse('2026-06-27T05:00:00Z'))
    expect(msUntilNextRun(4, new Date('2026-06-27T04:00:00.000Z'))).toBe(24 * 3_600_000)
  })
})

describe('scheduleEveryHoursFromAnchor', () => {
  it('runs at the anchor hour, then every N hours from it, not from when it was armed', async () => {
    vi.setSystemTime(new Date('2026-10-06T02:31:00Z'))
    const run = vi.fn()
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    expect(new Date(s.nextRunAt()).toISOString()).toBe('2026-10-06T04:00:00.000Z')

    await vi.advanceTimersByTimeAsync(88 * 60_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(new Date(s.nextRunAt()).toISOString()).toBe('2026-10-07T04:00:00.000Z')

    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(run).toHaveBeenCalledTimes(2)
    s.cancel()
  })

  it('never drifts to the arming time of day', async () => {
    vi.setSystemTime(new Date('2026-10-05T23:32:59Z')) // the app's real start time on 2026-10-05
    const times: string[] = []
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 5, everyHours: 24, run: () => { times.push(new Date().toISOString().slice(0, 13)) } })
    await vi.advanceTimersByTimeAsync(3 * 24 * 3_600_000)
    expect(times).toEqual(['2026-10-06T05', '2026-10-07T05', '2026-10-08T05'])
    s.cancel()
  })

  it('honours a period shorter than a day, anchored to the first slot', async () => {
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
    const times: string[] = []
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 5, everyHours: 6, run: () => { times.push(new Date().toISOString().slice(11, 13)) } })
    await vi.advanceTimersByTimeAsync(18 * 3_600_000)
    expect(times).toEqual(['05', '11', '17'])
    s.cancel()
  })

  it('after a long suspend it runs once, not once per missed slot, and re-arms for the next future slot', async () => {
    vi.setSystemTime(new Date('2026-10-06T02:00:00Z'))
    const run = vi.fn()
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z')) // the laptop slept for three days
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(new Date(s.nextRunAt()).toISOString()).toBe('2026-10-10T04:00:00.000Z')
    s.cancel()
  })

  it('cancel stops it', async () => {
    vi.setSystemTime(new Date('2026-10-06T02:00:00Z'))
    const run = vi.fn()
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    s.cancel()
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('a failing run is logged and the schedule goes on', async () => {
    vi.setSystemTime(new Date('2026-10-06T03:59:00Z'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const s = scheduleEveryHoursFromAnchor({ anchorHourUtc: 4, everyHours: 24, run })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('run failed'), expect.any(Error))
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(run).toHaveBeenCalledTimes(2)
    s.cancel()
  })
})
