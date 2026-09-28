import { describe, it, expect } from 'vitest'
import {
  formatBytes,
  resolveDiskGuardOptions,
  computeEffectiveFloorBytes,
  checkProjection,
} from '@/lib/clickhouse-disk-guard'

describe('formatBytes', () => {
  it('renders GiB to two decimal places', () => {
    expect(formatBytes(50 * 1024 ** 3)).toBe('50.00 GiB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GiB')
  })
})

describe('resolveDiskGuardOptions', () => {
  it('defaults to 50 GiB / 0.15 when nothing is set', () => {
    const resolved = resolveDiskGuardOptions({}, {})
    expect(resolved).toEqual({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.15 })
  })

  it('honors explicit options over env', () => {
    const resolved = resolveDiskGuardOptions(
      { minFreeBytes: 1000, minFreeRatio: 0.5 },
      { DISK_GUARD_MIN_FREE_BYTES: '999', DISK_GUARD_MIN_FREE_RATIO: '0.99' },
    )
    expect(resolved).toEqual({ minFreeBytes: 1000, minFreeRatio: 0.5 })
  })

  it('honors env vars when no explicit options are given', () => {
    const resolved = resolveDiskGuardOptions({}, { DISK_GUARD_MIN_FREE_BYTES: '2000', DISK_GUARD_MIN_FREE_RATIO: '0.2' })
    expect(resolved).toEqual({ minFreeBytes: 2000, minFreeRatio: 0.2 })
  })

  it('falls back to defaults on invalid env values', () => {
    const resolved = resolveDiskGuardOptions({}, { DISK_GUARD_MIN_FREE_BYTES: 'not-a-number', DISK_GUARD_MIN_FREE_RATIO: '' })
    expect(resolved).toEqual({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.15 })
  })
})

describe('computeEffectiveFloorBytes', () => {
  it('picks the absolute floor when it is stricter (larger)', () => {
    // 50 GiB absolute vs. 1% of a 100 GiB disk (1 GiB) -- absolute wins
    const totalBytes = 100 * 1024 ** 3
    const floor = computeEffectiveFloorBytes({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.01 }, totalBytes)
    expect(floor).toBe(50 * 1024 ** 3)
  })

  it('picks the percentage floor when it is stricter (larger)', () => {
    // 50 GiB absolute vs. 15% of a 937 GiB disk (~140.5 GiB) -- percentage wins
    const totalBytes = 937 * 1024 ** 3
    const floor = computeEffectiveFloorBytes({ minFreeBytes: 50 * 1024 ** 3, minFreeRatio: 0.15 }, totalBytes)
    expect(floor).toBeCloseTo(0.15 * totalBytes, 0)
    expect(floor).toBeGreaterThan(50 * 1024 ** 3)
  })
})

describe('checkProjection', () => {
  const floor = 100

  it('trips floor-breached when current free is already under the floor, even at index 0', () => {
    const result = checkProjection({ startFreeBytes: 50, currentFreeBytes: 50, effectiveFloorBytes: floor, index: 0, total: 10 })
    expect(result).toEqual({ trip: true, reason: 'floor-breached' })
  })

  it('does not project at index 0, regardless of how tight total is', () => {
    // Healthy now, but if a projection somehow ran at index 0 with total=1 it would divide by zero / misbehave.
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 1000, effectiveFloorBytes: floor, index: 0, total: 1 })
    expect(result).toEqual({ trip: false })
  })

  it('does not trip when projected consumption stays comfortably above the floor', () => {
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 950, effectiveFloorBytes: floor, index: 1, total: 10 })
    // consumed 50 in 1 iteration, 9 remain -> projects 950 - 450 = 500, well above floor=100
    expect(result).toEqual({ trip: false })
  })

  it('trips projected-breach when the observed rate would breach the floor before finishing', () => {
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 500, effectiveFloorBytes: floor, index: 1, total: 10 })
    // consumed 500 in 1 iteration, 9 remain -> projects 500 - 4500, deeply negative
    expect(result).toEqual({ trip: true, reason: 'projected-breach' })
  })

  it('uses the running average across all completed iterations, not just the most recent one', () => {
    const result = checkProjection({ startFreeBytes: 1000, currentFreeBytes: 800, effectiveFloorBytes: floor, index: 2, total: 10 })
    // 2 completed iterations, avg 100/iteration, 8 remain -> projects 800 - 800 = 0, breaches floor=100
    expect(result).toEqual({ trip: true, reason: 'projected-breach' })
  })

  it('clamps apparent negative consumption to zero rather than projecting growing headroom', () => {
    const result = checkProjection({ startFreeBytes: 500, currentFreeBytes: 600, effectiveFloorBytes: floor, index: 1, total: 10 })
    // currentFreeBytes > startFreeBytes -- consumedSoFar clamped to 0 -> avgPerIteration 0 -> projectedFree = 600, above floor=100
    expect(result).toEqual({ trip: false })
  })
})
