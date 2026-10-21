import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 0, pendingCount: 0 }, getCurrentJob: () => null }))
vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getHeld: () => [], getDoneCount: () => 0 }))
vi.mock('@/lib/ingest-gate-store', () => ({ latestHeldReport: () => null }))
vi.mock('@/lib/inbox-watcher', () => ({ getInboxJobProgress: () => null, getInboxJobsProgress: () => [], getInFlightCount: () => 0 }))

import { GET as inboxStatus } from '@/app/api/inbox/status/route'
import { GET as queueStatus } from '@/app/api/upload/queue-status/route'
import { logJob } from '@/lib/processing-log'

// The routes' SQL runs here against the real application table, so a column the routes ask for but the table lacks cannot hide behind a mock.
describe('the job lists of the Inbox and the Upload page', () => {
  it('return the repeated rows and the note of a job as recorded, and null for a job that recorded neither', async () => {
    logJob({ source: 'inbox', filename: 'routes-repeats-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, repeats: 12 })
    logJob({ source: 'inbox', filename: 'routes-repeats-b.txt', status: 'done', imported: 0, skipped: 0, duration_ms: 10, repeats: 0, note: 'already-imported' })
    logJob({ source: 'inbox', filename: 'routes-repeats-c.txt', status: 'failed', imported: 0, skipped: 0, duration_ms: 10, error_message: 'boom' })

    const inbox = await (await inboxStatus(new NextRequest('http://localhost/api/inbox/status'))).json()
    const byName = (rows: Array<{ filename: string }>, name: string) => rows.find(r => r.filename === name)
    expect(byName(inbox.done_recent, 'routes-repeats-a.txt')).toMatchObject({ repeats: 12, note: null })
    expect(byName(inbox.done_recent, 'routes-repeats-b.txt')).toMatchObject({ repeats: 0, note: 'already-imported' })
    expect(byName(inbox.done_recent, 'routes-repeats-c.txt')).toMatchObject({ repeats: null, note: null })

    const queue = await (await queueStatus(new NextRequest('http://localhost/api/upload/queue-status'))).json()
    expect(byName(queue.recent, 'routes-repeats-a.txt')).toMatchObject({ repeats: 12, note: null })
    expect(byName(queue.recent, 'routes-repeats-b.txt')).toMatchObject({ repeats: 0, note: 'already-imported' })
  })
})
