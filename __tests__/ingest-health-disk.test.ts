import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))

const GiB = 1024 ** 3
let disks: () => Promise<Array<{ unreserved_space: number; total_space: number }>>
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async () => [{ c: 8, v: 1_000_000, bytes: 100 * 1024 ** 3 }]),
  getClient: vi.fn(() => ({ query: vi.fn(async () => ({ json: () => disks() })) })),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/monitoring/ingest-health/route'
import { resetDiskWatch } from '@/lib/disk-watch'

const get = () => GET(new NextRequest('http://localhost/api/monitoring/ingest-health'))

beforeEach(() => {
  resetDiskWatch()
  disks = async () => [{ unreserved_space: 219 * GiB, total_space: 872 * GiB }]
})

describe('GET /api/monitoring/ingest-health — free space on the data disk', () => {
  test('reports free bytes, total, ratio and a status next to the table-budget figure', async () => {
    const json = await (await get()).json()
    expect(json.diskBudget).toBeDefined()
    expect(json.disk).toMatchObject({ status: 'ok', freeBytes: 219 * GiB, totalBytes: 872 * GiB })
    expect(json.disk.freeRatio).toBeCloseTo(219 / 872, 5)
  })

  test('a nearly full disk is critical', async () => {
    disks = async () => [{ unreserved_space: 40 * GiB, total_space: 872 * GiB }]
    expect((await (await get()).json()).disk.status).toBe('critical')
  })

  test('an unreadable disk is reported as unknown without failing the request', async () => {
    disks = async () => { throw new Error('system.disks unavailable') }
    const res = await get()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.disk).toMatchObject({ status: 'unknown', freeBytes: null })
    expect(json.clickhouse.activeParts).toBe(8)
  })
})
