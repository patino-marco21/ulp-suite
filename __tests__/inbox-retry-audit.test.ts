import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '4', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/inbox-helpers', () => ({
  retryFiles: vi.fn().mockReturnValue(['a.txt']),
  retryAllFailed: vi.fn().mockReturnValue(['a.txt', 'b.zip']),
}))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: vi.fn().mockResolvedValue(1) }))

import { logUploadAction } from '@/lib/audit-log'
import { POST } from '@/app/api/inbox/retry/route'

const mockAudit = logUploadAction as ReturnType<typeof vi.fn>
const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/inbox/retry', { method: 'POST', body: JSON.stringify(body) }))
const admin = { id: 4, email: 'admin@example.com' }

beforeEach(() => mockAudit.mockClear())

describe('POST /api/inbox/retry: audit', () => {
  it('records who retried which file', async () => {
    const res = await post({ filename: 'a.txt' })

    expect(res.status).toBe(200)
    expect(mockAudit).toHaveBeenCalledWith('inbox.retry', admin, null, { moved: ['a.txt'], mode: 'one' }, expect.anything())
  })

  it('records a retry of every failed file', async () => {
    await post({ all: true })

    expect(mockAudit).toHaveBeenCalledWith('inbox.retry', admin, null, { moved: ['a.txt', 'b.zip'], mode: 'all' }, expect.anything())
  })

  it('records nothing for a malformed body', async () => {
    const res = await post({ nothing: true })

    expect(res.status).toBe(400)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
