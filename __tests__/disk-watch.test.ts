import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import {
  diskThresholds,
  evaluateDisk,
  describeReading,
  readDisk,
  runDiskWatchTick,
  defaultNotify,
  getLastDiskReading,
  resetDiskWatch,
  type DiskReading,
} from '@/lib/disk-watch'
import { diskWatchMinutes } from '@/lib/disk-watch-cron'

const GiB = 1024 ** 3
const TOTAL = 872 * GiB // this laptop's data disk
const headroom = (freeGiB: number, total = TOTAL) => ({ freeBytes: freeGiB * GiB, totalBytes: total, ratio: (freeGiB * GiB) / total })

beforeEach(() => {
  resetDiskWatch()
})

describe('diskThresholds', () => {
  test('critical is the disk guard floor: the stricter of 50 GiB and 15% of the disk', () => {
    expect(diskThresholds(TOTAL, {}).criticalBytes).toBeCloseTo(0.15 * TOTAL, -3)
    expect(diskThresholds(100 * GiB, {}).criticalBytes).toBe(50 * GiB)
  })

  test('warn is the largest of 100 GiB, 20% of the disk and 1.25x the critical floor', () => {
    expect(diskThresholds(TOTAL, {}).warnBytes).toBeCloseTo(0.2 * TOTAL, -3)
    // small disk: the 100 GiB term wins
    expect(diskThresholds(200 * GiB, {}).warnBytes).toBe(100 * GiB)
    // a high guard ratio drags the warning level up with it
    expect(diskThresholds(TOTAL, { DISK_GUARD_MIN_FREE_RATIO: '0.3' }).warnBytes).toBeCloseTo(0.3 * 1.25 * TOTAL, -3)
  })

  test('env overrides apply, and empty or invalid values fall back to the defaults', () => {
    expect(diskThresholds(200 * GiB, { DISK_WARN_FREE_BYTES: String(150 * GiB) }).warnBytes).toBe(150 * GiB)
    expect(diskThresholds(200 * GiB, { DISK_WARN_FREE_BYTES: '' }).warnBytes).toBe(100 * GiB)
    expect(diskThresholds(200 * GiB, { DISK_WARN_FREE_BYTES: 'lots' }).warnBytes).toBe(100 * GiB)
  })
})

describe('evaluateDisk', () => {
  test.each([
    [219, 'ok'], // today: 235 GB free of 937 GB
    [170, 'warn'],
    [131, 'warn'],
    [130, 'critical'],
    [10, 'critical'],
  ] as const)('%i GiB free of 872 GiB is %s', (freeGiB, status) => {
    expect(evaluateDisk(headroom(freeGiB), {}).status).toBe(status)
  })

  test('describes each level with the numbers a person needs', () => {
    const warn = describeReading(evaluateDisk(headroom(160), {}))
    expect(warn).toMatch(/^WARNING: 160\.00 GiB free of 872\.00 GiB \(18\.3%\)/)
    const critical = describeReading(evaluateDisk(headroom(50), {}))
    expect(critical).toMatch(/^CRITICAL: 50\.00 GiB free/)
    expect(critical).toContain('refuse to run')
  })
})

describe('readDisk', () => {
  test('a failing read is an `unknown` reading, never a throw', async () => {
    const reading = await readDisk({ check: async () => { throw new Error('ClickHouse unreachable') } })
    expect(reading).toMatchObject({ status: 'unknown', freeBytes: null, error: 'ClickHouse unreachable' })
    expect(describeReading(reading)).toContain('could not be read: ClickHouse unreachable')
  })
})

describe('runDiskWatchTick — reports changes, not every reading', () => {
  const notify = vi.fn()
  let free = 219
  let clock = 1_000_000
  const tick = (env: NodeJS.ProcessEnv = {}) =>
    runDiskWatchTick({ check: async () => headroom(free), notify, env, now: () => clock })

  beforeEach(() => {
    notify.mockReset()
    free = 219
    clock = 1_000_000
  })

  test('a healthy first reading is silent but recorded', async () => {
    await tick()
    expect(notify).not.toHaveBeenCalled()
    expect(getLastDiskReading()?.status).toBe('ok')
  })

  test('a bad first reading is reported at once', async () => {
    free = 100
    await tick()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatch(/^CRITICAL/)
  })

  test('ok -> warn -> critical -> ok each report once; staying put does not repeat', async () => {
    await tick()
    free = 160
    await tick()
    await tick()
    free = 100
    await tick()
    await tick()
    free = 219
    await tick()
    const messages = notify.mock.calls.map(c => c[0] as string)
    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatch(/^WARNING/)
    expect(messages[1]).toMatch(/^CRITICAL/)
    expect(messages[2]).toMatch(/^disk space is fine/)
  })

  test('while the status stays bad it repeats as a reminder every DISK_ALERT_REMINDER_HOURS', async () => {
    free = 160
    await tick({ DISK_ALERT_REMINDER_HOURS: '2' })
    clock += 90 * 60_000
    await tick({ DISK_ALERT_REMINDER_HOURS: '2' })
    expect(notify).toHaveBeenCalledTimes(1)
    clock += 40 * 60_000
    await tick({ DISK_ALERT_REMINDER_HOURS: '2' })
    expect(notify).toHaveBeenCalledTimes(2)
  })

  test('DISK_ALERT_REMINDER_HOURS=0 turns the reminders off', async () => {
    free = 160
    await tick({ DISK_ALERT_REMINDER_HOURS: '0' })
    clock += 48 * 3_600_000
    await tick({ DISK_ALERT_REMINDER_HOURS: '0' })
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('a disk that cannot be read is reported once, then recovery is reported', async () => {
    const run = (check: () => Promise<ReturnType<typeof headroom>>) =>
      runDiskWatchTick({ check, notify, env: {}, now: () => clock })
    await run(async () => headroom(219))
    await run(async () => { throw new Error('boom') })
    await run(async () => { throw new Error('boom') })
    await run(async () => headroom(219))
    const messages = notify.mock.calls.map(c => c[0] as string)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('could not be read')
    expect(messages[1]).toMatch(/^disk space is fine/)
  })
})

describe('defaultNotify', () => {
  const warnReading: DiskReading = evaluateDisk(headroom(160), {})
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('without DISK_ALERT_WEBHOOK_URL it only logs, and sends nothing anywhere', async () => {
    const fetchImpl = vi.fn()
    await defaultNotify({}, fetchImpl as unknown as typeof fetch)('WARNING: low', warnReading)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[disk-watch] WARNING: low')
  })

  test('critical goes to console.error so it survives the production console stripping', async () => {
    await defaultNotify({}, vi.fn() as unknown as typeof fetch)('CRITICAL: full', evaluateDisk(headroom(10), {}))
    expect(error).toHaveBeenCalledWith('[disk-watch] CRITICAL: full')
  })

  test('with the variable set it POSTs a Slack-compatible JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await defaultNotify({ DISK_ALERT_WEBHOOK_URL: 'https://hooks.example.test/x' }, fetchImpl as unknown as typeof fetch)('WARNING: low', warnReading)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://hooks.example.test/x')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ text: 'ulp-suite: WARNING: low', status: 'warn', total_bytes: TOTAL })
  })

  test('a failing or non-2xx webhook is logged and never thrown', async () => {
    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(defaultNotify({ DISK_ALERT_WEBHOOK_URL: 'https://h.example.test' }, down as unknown as typeof fetch)('x', warnReading)).resolves.toBeUndefined()
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(defaultNotify({ DISK_ALERT_WEBHOOK_URL: 'https://h.example.test' }, bad as unknown as typeof fetch)('x', warnReading)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(2)
  })
})

describe('diskWatchMinutes', () => {
  test('defaults to 10, accepts 0 to disable, ignores garbage', () => {
    expect(diskWatchMinutes({})).toBe(10)
    expect(diskWatchMinutes({ DISK_WATCH_MINUTES: '' })).toBe(10)
    expect(diskWatchMinutes({ DISK_WATCH_MINUTES: '0' })).toBe(0)
    expect(diskWatchMinutes({ DISK_WATCH_MINUTES: '30' })).toBe(30)
    expect(diskWatchMinutes({ DISK_WATCH_MINUTES: 'soon' })).toBe(10)
    expect(diskWatchMinutes({ DISK_WATCH_MINUTES: '-5' })).toBe(10)
  })
})
