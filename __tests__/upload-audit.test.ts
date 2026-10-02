import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbRun: vi.fn().mockReturnValue({ lastId: 7 }),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(undefined),
}))

import { dbRun } from '@/lib/sqlite'
import { logUploadAction } from '@/lib/audit-log'

const mockDbRun = dbRun as ReturnType<typeof vi.fn>

beforeEach(() => mockDbRun.mockClear())

describe('logUploadAction', () => {
  it('records an upload start with the acting user, the job id and the client details', async () => {
    const request = new Request('http://localhost/api/upload', { headers: { 'user-agent': 'vitest-agent' } })

    const id = await logUploadAction(
      'upload.start',
      { id: 3, email: 'admin@example.com' },
      'job-1',
      { filename: 'a.txt', bytes: 10 },
      request,
    )

    expect(id).toBe(7)
    const [sql, params] = mockDbRun.mock.calls[0]
    expect(sql).toContain('INSERT INTO audit_logs')
    expect(params[0]).toBe(3)
    expect(params[1]).toBe('admin@example.com')
    expect(params[2]).toBe('upload.start')
    expect(params[3]).toBe('upload')
    expect(params[4]).toBe('job-1')
    expect(JSON.parse(params[5])).toEqual({ filename: 'a.txt', bytes: 10 })
    expect(params[7]).toBe('vitest-agent')
  })

  it('files an inbox retry under the inbox resource type and works without a request', async () => {
    await logUploadAction('inbox.retry', { id: 3, email: null }, null, { moved: ['a.txt'], mode: 'one' })

    const [, params] = mockDbRun.mock.calls[0]
    expect(params[2]).toBe('inbox.retry')
    expect(params[3]).toBe('inbox')
    expect(params[4]).toBeNull()
    expect(params[6]).toBeNull() // ip address
    expect(params[7]).toBeNull() // user agent
  })
})
