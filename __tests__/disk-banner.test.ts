import { describe, it, expect } from 'vitest'
import { describeDiskBanner } from '@/lib/disk-banner'
import type { DiskReading } from '@/lib/disk-watch'
import type { IngestDiskGateState } from '@/lib/ingest-disk-gate'

const GiB = 1024 ** 3
const reading = (status: DiskReading['status'], freeGiB: number | null): DiskReading => ({
  status,
  freeBytes: freeGiB === null ? null : freeGiB * GiB,
  totalBytes: freeGiB === null ? null : 936.8 * GiB,
  freeRatio: freeGiB === null ? null : freeGiB / 936.8,
  thresholds: freeGiB === null ? null : { warnBytes: 187.4 * GiB, criticalBytes: 140.5 * GiB },
  checkedAt: 0,
})
const gate = (over: Partial<IngestDiskGateState> = {}): IngestDiskGateState => ({
  paused: false, since: null, waiters: 0, freeBytes: null, floorBytes: 50 * GiB, resumeBytes: 55 * GiB, checkedAt: null, ...over,
})

describe('describeDiskBanner', () => {
  it('shows nothing when the disk is fine, unknown, or not known yet', () => {
    expect(describeDiskBanner(reading('ok', 300), gate())).toBeNull()
    expect(describeDiskBanner(reading('unknown', null), gate())).toBeNull()
    expect(describeDiskBanner(null, null)).toBeNull()
  })

  it('critical: says how much is free, what is blocked and where imports pause', () => {
    expect(describeDiskBanner(reading('critical', 121.5), gate())).toEqual({
      level: 'critical',
      message: 'Disk critical: 121.5 GiB free of 936.8 GiB (13%). Dedup and projection jobs are blocked below 140.5 GiB; imports pause below 50.0 GiB.',
    })
  })

  it('warn: the same facts in a softer voice', () => {
    expect(describeDiskBanner(reading('warn', 150), gate())).toEqual({
      level: 'warn',
      message: 'Disk is getting low: 150.0 GiB free of 936.8 GiB (16%). Dedup and projection jobs stop below 140.5 GiB; imports pause below 50.0 GiB.',
    })
  })

  it('an older server that sends no gate state still gets a banner, without the imports clause', () => {
    expect(describeDiskBanner(reading('critical', 121.5), null)?.message).toBe(
      'Disk critical: 121.5 GiB free of 936.8 GiB (13%). Dedup and projection jobs are blocked below 140.5 GiB.',
    )
  })

  it('paused beats critical: imports are the thing the operator is waiting for', () => {
    expect(describeDiskBanner(reading('critical', 48.2), gate({ paused: true, waiters: 1, freeBytes: 48.2 * GiB }))).toEqual({
      level: 'paused',
      message: 'Imports are paused: 48.2 GiB free, floor 50.0 GiB. They resume by themselves above 55.0 GiB.',
    })
  })

  it('paused with an unreadable disk says why', () => {
    const b = describeDiskBanner(null, gate({ paused: true, waiters: 1, error: 'connection refused' }))
    expect(b).toEqual({
      level: 'paused',
      message: 'Imports are paused: free space could not be read (connection refused). They resume by themselves above 55.0 GiB.',
    })
  })
})
