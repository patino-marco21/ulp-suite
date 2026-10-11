import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn(), requireAdminRole: vi.fn() }))
vi.mock('@/lib/disk-watch', () => ({ readDisk: vi.fn() }))
vi.mock('@/lib/ingest-disk-gate', () => ({ getIngestDiskGate: vi.fn() }))

import { validateRequest, requireAdminRole } from '@/lib/auth'
import { readDisk } from '@/lib/disk-watch'
import { getIngestDiskGate } from '@/lib/ingest-disk-gate'
import { GET } from '@/app/api/monitoring/disk/route'

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  m(validateRequest).mockReset().mockResolvedValue({ role: 'admin' })
  m(requireAdminRole).mockReset().mockReturnValue(null)
  m(readDisk).mockReset().mockResolvedValue({ status: 'critical', freeBytes: 1 })
  m(getIngestDiskGate).mockReset().mockReturnValue({ paused: true, waiters: 1 })
})

describe('GET /api/monitoring/disk', () => {
  it('returns the disk reading and the gate state to an admin', async () => {
    const res = await GET({} as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disk: { status: 'critical', freeBytes: 1 }, gate: { paused: true, waiters: 1 } })
  })

  it.each([401, 403])('answers %i without touching the disk when the caller is refused', async status => {
    m(requireAdminRole).mockReturnValue(NextResponse.json({ success: false }, { status }))
    const res = await GET({} as any)
    expect(res.status).toBe(status)
    expect(readDisk).not.toHaveBeenCalled()
    expect(getIngestDiskGate).not.toHaveBeenCalled()
  })
})
