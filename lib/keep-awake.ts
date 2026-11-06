/**
 * The decisions of scripts/keep-awake-while-busy.ts (ticket 06 of .scratch/ingest-yield-and-throughput): hold a sleep inhibitor while the inbox has work, release it a few
 * minutes after the work is done. Plain values in, an action out, so each rule is tested without a clock, a lid or systemd. The inbox is "busy" as inboxIsBusy() says
 * (lib/archive-replace.ts): a top-level file waiting, or anything in inbox/processing/.
 */
/** How long the inbox must have been idle before the lock is released: a batch has small gaps between files. */
export const GRACE_MS = 5 * 60_000
/** The longest the lock is held at a stretch. A file that sits in the inbox and is never claimed would otherwise keep the laptop on, shut in a bag, until the battery is empty. */
export const MAX_HOLD_MS = 12 * 60 * 60_000
/** Under this charge, on battery power, the lock is not held: a laptop that goes to sleep is better than one that dies in the middle of a commit. */
export const LOW_BATTERY_PERCENT = 15

export interface KeepAwakeFacts {
  busy: boolean
  holding: boolean
  holdingSinceMs: number | null
  /** The last time the inbox was seen busy; null when it has not been seen busy. */
  lastBusyMs: number | null
  nowMs: number
  graceMs: number
  maxHoldMs: number
  batteryLow: boolean
  /** The ceiling released the lock and the inbox has not been idle since. */
  capped: boolean
}

export interface KeepAwakeDecision { action: 'take' | 'release' | 'none'; capped: boolean; reason: string }

export function keepAwakeAction(f: KeepAwakeFacts): KeepAwakeDecision {
  if (!f.busy) {
    // an idle observation ends a capped stretch; the lock goes after the grace time
    if (f.holding && f.lastBusyMs !== null && f.nowMs - f.lastBusyMs >= f.graceMs) return { action: 'release', capped: false, reason: `the inbox has been idle for ${Math.round(f.graceMs / 60_000)} minutes` }
    return { action: 'none', capped: false, reason: 'the inbox is idle' }
  }
  if (f.batteryLow) {
    return f.holding
      ? { action: 'release', capped: f.capped, reason: `the battery is under ${LOW_BATTERY_PERCENT}% and not charging` }
      : { action: 'none', capped: f.capped, reason: `the battery is under ${LOW_BATTERY_PERCENT}% and not charging` }
  }
  if (f.capped) return { action: 'none', capped: true, reason: 'held for the maximum already; waits for the inbox to go idle once' }
  if (f.holding && f.holdingSinceMs !== null && f.nowMs - f.holdingSinceMs >= f.maxHoldMs) {
    return { action: 'release', capped: true, reason: `held for ${Math.round(f.maxHoldMs / 3_600_000)} hours without the inbox going idle` }
  }
  if (!f.holding) return { action: 'take', capped: false, reason: 'the inbox has work' }
  return { action: 'none', capped: false, reason: 'the inbox has work' }
}

export interface BatteryReading { status: string; capacity: number }

/** True while discharging under LOW_BATTERY_PERCENT. A machine with no battery (null) is never low. */
export function batteryIsLow(b: BatteryReading | null): boolean {
  return b !== null && b.status === 'Discharging' && b.capacity < LOW_BATTERY_PERCENT
}
