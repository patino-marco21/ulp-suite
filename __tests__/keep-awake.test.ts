import { describe, expect, test } from 'vitest'
import { GRACE_MS, MAX_HOLD_MS, batteryIsLow, keepAwakeAction, type KeepAwakeFacts } from '@/lib/keep-awake'

const MIN = 60_000
const HOUR = 60 * MIN
const idle: KeepAwakeFacts = { busy: false, holding: false, holdingSinceMs: null, lastBusyMs: null, nowMs: 100 * HOUR, graceMs: GRACE_MS, maxHoldMs: MAX_HOLD_MS, batteryLow: false, capped: false }

describe('keepAwakeAction', () => {
  test('a busy inbox takes the lock', () => {
    expect(keepAwakeAction({ ...idle, busy: true })).toMatchObject({ action: 'take', capped: false })
  })

  test('an idle inbox with no lock does nothing', () => {
    expect(keepAwakeAction(idle)).toMatchObject({ action: 'none' })
  })

  test('a held lock stays while the inbox is busy', () => {
    const f = { ...idle, busy: true, holding: true, holdingSinceMs: idle.nowMs - 10 * MIN, lastBusyMs: idle.nowMs }
    expect(keepAwakeAction(f)).toMatchObject({ action: 'none' })
  })

  test('a held lock is released only after the inbox has been idle for the grace time (5 minutes)', () => {
    expect(GRACE_MS).toBe(5 * MIN)
    const f = { ...idle, holding: true, holdingSinceMs: idle.nowMs - 60 * MIN }
    expect(keepAwakeAction({ ...f, lastBusyMs: idle.nowMs - 4 * MIN })).toMatchObject({ action: 'none' })
    expect(keepAwakeAction({ ...f, lastBusyMs: idle.nowMs - 5 * MIN })).toMatchObject({ action: 'release', reason: expect.stringMatching(/idle/) })
  })

  test('the lock is never held for more than 12 hours at a stretch: a file stuck in the inbox must not keep the laptop on all night', () => {
    expect(MAX_HOLD_MS).toBe(12 * HOUR)
    const f = { ...idle, busy: true, holding: true, lastBusyMs: idle.nowMs }
    expect(keepAwakeAction({ ...f, holdingSinceMs: idle.nowMs - 11 * HOUR })).toMatchObject({ action: 'none' })
    const over = keepAwakeAction({ ...f, holdingSinceMs: idle.nowMs - 12 * HOUR })
    expect(over).toMatchObject({ action: 'release', capped: true })
    expect(over.reason).toMatch(/12 hours/)
  })

  test('once capped, a busy inbox does not take the lock again until the inbox has been idle once', () => {
    expect(keepAwakeAction({ ...idle, busy: true, capped: true })).toMatchObject({ action: 'none', capped: true })
    expect(keepAwakeAction({ ...idle, busy: false, capped: true })).toMatchObject({ action: 'none', capped: false })
  })

  test('a low battery on battery power releases the lock and does not take it', () => {
    expect(keepAwakeAction({ ...idle, busy: true, batteryLow: true })).toMatchObject({ action: 'none', reason: expect.stringMatching(/battery/) })
    const held = { ...idle, busy: true, batteryLow: true, holding: true, holdingSinceMs: idle.nowMs - MIN, lastBusyMs: idle.nowMs }
    expect(keepAwakeAction(held)).toMatchObject({ action: 'release', reason: expect.stringMatching(/battery/) })
  })
})

describe('batteryIsLow', () => {
  test('is true only while discharging under 15 percent', () => {
    expect(batteryIsLow({ status: 'Discharging', capacity: 14 })).toBe(true)
    expect(batteryIsLow({ status: 'Discharging', capacity: 15 })).toBe(false)
    expect(batteryIsLow({ status: 'Charging', capacity: 5 })).toBe(false)
    expect(batteryIsLow({ status: 'Full', capacity: 100 })).toBe(false)
  })
  test('is false when there is no battery to read (a desktop, a read error)', () => {
    expect(batteryIsLow(null)).toBe(false)
  })
})
