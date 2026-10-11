/**
 * Runs a job every N hours, counted from an anchor hour of the UTC day.
 *
 * lib/dedup-cron.ts and lib/projection-scope-cron.ts used to arm `setTimeout(first tick at the anchor hour)` and
 * `setInterval(24 h)` side by side at boot. The interval starts at boot, so after the first anchored tick both fired at the
 * boot time of day instead (observed: 23:32:59Z on 2026-10-06..09 instead of 04:00Z and 05:00Z). This keeps the next slot as a
 * wall-clock time and compares it with the clock every 30 s. That also survives a laptop suspend: Node timers run on the
 * monotonic clock, which does not advance while the machine sleeps, so one long timer would land late by the length of the sleep.
 * After a long gap it runs once (not once per missed slot) and re-arms for the next slot still in the future.
 */

/** Ms from `now` until the next `hourUtc:00 UTC` (today if still ahead, else tomorrow). */
export function msUntilNextRun(hourUtc: number, now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

export interface DailyScheduleOptions {
  /** Hour of the UTC day of the first run. */
  anchorHourUtc: number
  /** Hours between runs, counted from the first run. */
  everyHours: number
  /** The job. Its result is ignored; a returned promise is awaited only so that a rejection is logged. */
  run: () => unknown
  /** Wall clock in ms; tests replace it. */
  now?: () => number
  pollMs?: number
}

export interface DailySchedule {
  cancel(): void
  /** When the next run is due (epoch ms). */
  nextRunAt(): number
}

export function scheduleEveryHoursFromAnchor(opts: DailyScheduleOptions): DailySchedule {
  const now = opts.now ?? Date.now
  const stepMs = opts.everyHours * 3_600_000
  let next = now() + msUntilNextRun(opts.anchorHourUtc, new Date(now()))

  const check = () => {
    const t = now()
    if (t < next) return
    do next += stepMs
    while (next <= t)
    Promise.resolve()
      .then(() => opts.run())
      .catch(err => console.error('[daily-schedule] run failed:', err))
  }

  const timer = setInterval(check, opts.pollMs ?? 30_000)
  timer.unref?.()
  return { cancel: () => clearInterval(timer), nextRunAt: () => next }
}
