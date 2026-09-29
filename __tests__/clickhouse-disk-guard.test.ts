import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatBytes,
  resolveDiskGuardOptions,
  computeEffectiveFloorBytes,
  checkProjection,
  checkDiskHeadroom,
  checkTableBytes,
  createDiskGuard,
  DiskHeadroomError,
} from '@/lib/clickhouse-disk-guard'

const h = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ query: h.query }) }))

const TEST_TABLE = 'ulp.test_dedup_target'

const diskResult = (unreserved: number, total: number) =>
  h.query.mockResolvedValue({ json: async () => [{ unreserved_space: String(unreserved), total_space: String(total) }] })

const tableResult = (bytes: number) =>
  h.query.mockResolvedValue({ json: async () => [{ bytes: String(bytes) }] })

/**
 * createDiskGuard's preflight/checkBeforeIteration each issue a disk-space
 * query THEN a table-size query, in that order -- this lets a single test
 * set up both answers regardless of how many times each is called.
 */
function mockDiskThenTable(disk: { unreserved: number; total: number }, tableBytes: number) {
  h.query.mockImplementation(({ query }: { query: string }) => {
    if (query.includes('system.disks')) {
      return Promise.resolve({ json: async () => [{ unreserved_space: String(disk.unreserved), total_space: String(disk.total) }] })
    }
    return Promise.resolve({ json: async () => [{ bytes: String(tableBytes) }] })
  })
}

beforeEach(() => {
  h.query.mockReset()
})

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
    const result = checkProjection({ startTableBytes: 0, currentTableBytes: 0, currentFreeBytes: 50, effectiveFloorBytes: floor, index: 0, total: 10 })
    expect(result).toEqual({ trip: true, reason: 'floor-breached' })
  })

  it('does not project at index 0, regardless of how tight total is', () => {
    // Healthy now, but if a projection somehow ran at index 0 with total=1 it would divide by zero / misbehave.
    const result = checkProjection({ startTableBytes: 0, currentTableBytes: 0, currentFreeBytes: 1000, effectiveFloorBytes: floor, index: 0, total: 1 })
    expect(result).toEqual({ trip: false })
  })

  it('does not trip when projected table growth stays comfortably above the floor', () => {
    const result = checkProjection({ startTableBytes: 0, currentTableBytes: 50, currentFreeBytes: 950, effectiveFloorBytes: floor, index: 1, total: 10 })
    // table grew 50 in 1 iteration, 9 remain -> projects 950 - 450 = 500, well above floor=100
    expect(result).toEqual({ trip: false })
  })

  it('trips projected-breach when the observed table growth rate would breach the floor before finishing', () => {
    const result = checkProjection({ startTableBytes: 0, currentTableBytes: 500, currentFreeBytes: 500, effectiveFloorBytes: floor, index: 1, total: 10 })
    // table grew 500 in 1 iteration, 9 remain -> projects 500 - 4500, deeply negative
    expect(result).toEqual({ trip: true, reason: 'projected-breach' })
  })

  it('uses the running average across all completed iterations, not just the most recent one', () => {
    const result = checkProjection({ startTableBytes: 0, currentTableBytes: 200, currentFreeBytes: 800, effectiveFloorBytes: floor, index: 2, total: 10 })
    // 2 completed iterations, avg 100/iteration, 8 remain -> projects 800 - 800 = 0, breaches floor=100
    expect(result).toEqual({ trip: true, reason: 'projected-breach' })
  })

  it('clamps apparent negative table growth to zero rather than projecting growing headroom', () => {
    const result = checkProjection({ startTableBytes: 600, currentTableBytes: 500, currentFreeBytes: 600, effectiveFloorBytes: floor, index: 1, total: 10 })
    // currentTableBytes < startTableBytes (shouldn't happen, but defensive) -- grownSoFar clamped to 0 -> avgPerIteration 0 -> projectedFree = 600, above floor=100
    expect(result).toEqual({ trip: false })
  })

  it('does not mistake non-compounding transient free-space overhead for real growth (2026-09-29 finding)', () => {
    // The actual live shape that motivated this fix: each bucket's real table
    // growth is a steady 18, but free-space drops by 48 per bucket (18 real +
    // ~30 transient, e.g. disk-spill temp files) -- and that 30 does NOT
    // compound bucket-to-bucket. A free-space-delta-based projection would
    // extrapolate the full 48/iteration and trip; table-growth-based doesn't.
    const result = checkProjection({
      startTableBytes: 0, currentTableBytes: 18, // one bucket's real growth
      currentFreeBytes: 1000 - 48, // one bucket's full free-space drop (real + transient)
      effectiveFloorBytes: 100, index: 1, total: 16,
    })
    // avg table growth 18/iteration, 15 remain -> projects 952 - 270 = 682, comfortably above floor=100
    expect(result).toEqual({ trip: false })
  })
})

describe('checkDiskHeadroom', () => {
  it('reads unreserved_space and total_space for the default disk', async () => {
    diskResult(300 * 1024 ** 3, 1000 * 1024 ** 3)

    const result = await checkDiskHeadroom()

    expect(result).toEqual({ freeBytes: 300 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3, ratio: 0.3 })
    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining(`WHERE name = 'default'`),
    }))
  })

  it('passes the abort signal through when one is given', async () => {
    diskResult(1, 2)
    const controller = new AbortController()

    await checkDiskHeadroom(controller.signal)

    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ abort_signal: controller.signal }))
  })

  it('works with no signal at all (the real call site has none)', async () => {
    diskResult(1, 2)
    await expect(checkDiskHeadroom()).resolves.toBeDefined()
  })

  it('throws if system.disks returns no row for "default"', async () => {
    h.query.mockResolvedValue({ json: async () => [] })
    await expect(checkDiskHeadroom()).rejects.toThrow('no usable row')
  })
})

describe('checkTableBytes', () => {
  it('reads sum(bytes_on_disk) for the given database.table, active parts only', async () => {
    tableResult(42)

    const result = await checkTableBytes(TEST_TABLE)

    expect(result).toBe(42)
    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining(`database = 'ulp' AND table = 'test_dedup_target' AND active`),
    }))
  })

  it('passes the abort signal through when one is given', async () => {
    tableResult(1)
    const controller = new AbortController()

    await checkTableBytes(TEST_TABLE, controller.signal)

    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ abort_signal: controller.signal }))
  })

  it('returns 0 for a table with no parts yet (sum() over zero rows is NULL)', async () => {
    h.query.mockResolvedValue({ json: async () => [{ bytes: null }] })
    await expect(checkTableBytes(TEST_TABLE)).resolves.toBe(0)
  })
})

describe('createDiskGuard', () => {
  it('preflight passes when headroom is above the floor', async () => {
    mockDiskThenTable({ unreserved: 300 * 1024 ** 3, total: 1000 * 1024 ** 3 }, 0) // 30% free, well above 15%/50GiB defaults
    const guard = createDiskGuard(TEST_TABLE)
    await expect(guard.preflight()).resolves.toBeUndefined()
  })

  it('preflight throws DiskHeadroomError(floor-breached) when already below the floor', async () => {
    mockDiskThenTable({ unreserved: 1 * 1024 ** 3, total: 1000 * 1024 ** 3 }, 0) // 0.1% free, way under both floors
    const guard = createDiskGuard(TEST_TABLE)
    await expect(guard.preflight()).rejects.toThrow(DiskHeadroomError)
    await expect(guard.preflight()).rejects.toMatchObject({ reason: 'floor-breached' })
  })

  it('preflight throws DiskHeadroomError(check-failed) when the disk query itself fails', async () => {
    h.query.mockRejectedValue(new Error('connection refused'))
    const guard = createDiskGuard(TEST_TABLE)
    await expect(guard.preflight()).rejects.toMatchObject({ reason: 'check-failed' })
  })

  it('checkBeforeIteration throws if called before preflight', async () => {
    const guard = createDiskGuard(TEST_TABLE)
    await expect(guard.checkBeforeIteration(undefined, { index: 0, total: 10 })).rejects.toThrow('before preflight')
  })

  it('checkBeforeIteration trips projected-breach using the target table\'s growth since preflight as the baseline', async () => {
    mockDiskThenTable({ unreserved: 1000 * 1024 ** 3, total: 2000 * 1024 ** 3 }, 0) // preflight: table empty, floor = max(50, 300) = 300 GiB
    const guard = createDiskGuard(TEST_TABLE)
    await guard.preflight()

    mockDiskThenTable({ unreserved: 500 * 1024 ** 3, total: 2000 * 1024 ** 3 }, 1000 * 1024 ** 3) // after bucket 0: table grew to 1000 GiB
    await expect(guard.checkBeforeIteration(undefined, { index: 1, total: 3 }))
      .rejects.toMatchObject({ reason: 'projected-breach' }) // 2 remain -> projects 500 - 2000 = -1500, under the 300 GiB floor
  })

  it('checkBeforeIteration does not trip when projected table growth stays comfortably above the floor', async () => {
    mockDiskThenTable({ unreserved: 1000 * 1024 ** 3, total: 2000 * 1024 ** 3 }, 0) // preflight: table empty, floor 300 GiB
    const guard = createDiskGuard(TEST_TABLE)
    await guard.preflight()

    mockDiskThenTable({ unreserved: 950 * 1024 ** 3, total: 2000 * 1024 ** 3 }, 50 * 1024 ** 3) // after bucket 0: table grew only 50 GiB
    await expect(guard.checkBeforeIteration(undefined, { index: 1, total: 3 }))
      .resolves.toBeUndefined() // 2 remain -> projects 950 - 100 = 850, well above 300 GiB floor
  })

  it('checkBeforeIteration does NOT trip on a large free-space drop that is transient overhead, not real table growth (2026-09-29 finding)', async () => {
    mockDiskThenTable({ unreserved: 1000 * 1024 ** 3, total: 2000 * 1024 ** 3 }, 0) // preflight: table empty, floor 300 GiB
    const guard = createDiskGuard(TEST_TABLE)
    await guard.preflight()

    // Free space dropped by 480 GiB, but the table itself only grew 10 GiB --
    // the other 470 GiB was transient (e.g. disk-spill temp files) and must
    // not be extrapolated as if it were compounding real growth. A
    // free-space-delta-based projection would extrapolate 480/iteration and
    // trip hard; table-growth-based sees only 10/iteration.
    mockDiskThenTable({ unreserved: 520 * 1024 ** 3, total: 2000 * 1024 ** 3 }, 10 * 1024 ** 3)
    await expect(guard.checkBeforeIteration(undefined, { index: 1, total: 16 }))
      .resolves.toBeUndefined() // 15 remain -> projects 520 - 150 = 370 GiB, above the 300 GiB floor
  })
})
