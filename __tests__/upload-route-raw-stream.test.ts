import { NextRequest } from 'next/server'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ role: 'admin' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/clickhouse-migrations', () => ({
  runClickHouseMigrations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/processing-log', () => ({
  logJob: vi.fn(),
}))
vi.mock('@/lib/upload-processor', () => ({
  processTextStream: vi.fn().mockResolvedValue({
    imported: 1, skipped: 0, errors: 0, filename: 'dump.txt',
    breach_name: 'test', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
  }),
  processZipFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { id: 'test-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn((response) => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))

import { readFileSync } from 'fs'
import { processTextStream, processZipFile } from '@/lib/upload-processor'
import { POST } from '@/app/api/upload/route'
import { POST as POST_V1 } from '@/app/api/v1/upload/route'

const mockProcessTextStream = processTextStream as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>

describe('POST /api/upload — raw-stream body', () => {
  beforeEach(() => {
    mockProcessTextStream.mockClear()
    mockProcessZipFile.mockClear()
  })

  it('rejects a request with no filename query param', async () => {
    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: 'irrelevant body content',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ success: false, error: 'No filename provided' })
  })

  it('rejects an unsupported file extension', async () => {
    const req = new NextRequest('http://localhost/api/upload?filename=dump.exe', {
      method: 'POST',
      body: 'irrelevant body content',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toContain('Unsupported file type')
  })

  it('streams request.body straight into processTextStream with the query-param filename', async () => {
    const req = new NextRequest('http://localhost/api/upload?filename=dump.txt', {
      method: 'POST',
      body: 'https://a.com:user@a.com:pass\n',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.jobId).toBeTruthy()

    // runWithProgress fires processTextStream without the route handler
    // awaiting it — give the queued microtask a turn to run before asserting.
    await new Promise(r => setTimeout(r, 10))

    expect(mockProcessTextStream).toHaveBeenCalledTimes(1)
    const [streamArg, filenameArg, jobIdArg] = mockProcessTextStream.mock.calls[0]
    expect(streamArg).toBeInstanceOf(ReadableStream)
    expect(filenameArg).toBe('dump.txt')
    expect(jobIdArg).toBe(json.jobId)
  })

  it('preserves original filename casing for processing while matching extensions case-insensitively', async () => {
    const req = new NextRequest('http://localhost/api/upload?filename=Mixed-Case-Dump.TXT', {
      method: 'POST',
      body: 'https://a.com:user@a.com:pass\n',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)

    await new Promise(r => setTimeout(r, 10))

    expect(mockProcessTextStream).toHaveBeenCalledTimes(1)
    const [, filenameArg] = mockProcessTextStream.mock.calls[0]
    expect(filenameArg).toBe('Mixed-Case-Dump.TXT')
  })
})

describe('POST /api/v1/upload — raw-stream body', () => {
  beforeEach(() => {
    mockProcessTextStream.mockClear()
    mockProcessZipFile.mockClear()
  })

  it('rejects a request with no filename query param', async () => {
    const req = new NextRequest('http://localhost/api/v1/upload', {
      method: 'POST',
      body: 'irrelevant body content',
    })
    const res = await POST_V1(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ success: false, error: 'No filename provided' })
  })

  it('streams request.body straight into processTextStream and awaits it before responding', async () => {
    const req = new NextRequest('http://localhost/api/v1/upload?filename=dump.txt', {
      method: 'POST',
      body: 'https://a.com:user@a.com:pass\n',
    })
    const res = await POST_V1(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      success: true, imported: 1, skipped: 0, errors: 0, filename: 'dump.txt',
    })

    expect(mockProcessTextStream).toHaveBeenCalledTimes(1)
    const [streamArg, filenameArg] = mockProcessTextStream.mock.calls[0]
    expect(streamArg).toBeInstanceOf(ReadableStream)
    expect(filenameArg).toBe('dump.txt')
  })

  it('no longer buffers zip uploads into memory before processing (regression test for the v1 OOM-pattern fix)', () => {
    const source = readFileSync(new URL('../app/api/v1/upload/route.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('arrayBuffer()')
    expect(source).not.toContain('processZipBuffer')
  })
})
