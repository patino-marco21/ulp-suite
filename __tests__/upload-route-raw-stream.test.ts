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
vi.mock('@/lib/breach-matcher', () => ({
  matchBreach: vi.fn().mockReturnValue('test-breach'),
}))

const captured = vi.hoisted(() => ({ text: '' }))

vi.mock('@/lib/upload-processor', () => ({
  processTextStream: vi.fn(async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    captured.text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
    return {
      imported: 1, skipped: 0, errors: 0, filename: 'dump.txt',
      breach_name: 'test', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
    }
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
vi.mock('@/lib/settings', () => ({
  settingsManager: {
    getMaxUploadFileSizeBytes: vi.fn().mockResolvedValue(10 * 1024 ** 3),
  },
}))

import { readFileSync } from 'fs'
import { processTextStream, processZipFile } from '@/lib/upload-processor'
import { settingsManager } from '@/lib/settings'
import { logJob } from '@/lib/processing-log'
import { POST } from '@/app/api/upload/route'
import { POST as POST_V1 } from '@/app/api/v1/upload/route'

const mockProcessTextStream = processTextStream as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>
const mockGetMaxUploadFileSizeBytes = settingsManager.getMaxUploadFileSizeBytes as ReturnType<typeof vi.fn>
const mockLogJob = logJob as ReturnType<typeof vi.fn>

describe('POST /api/upload — raw-stream body', () => {
  beforeEach(() => {
    mockProcessTextStream.mockClear()
    mockProcessZipFile.mockClear()
    captured.text = ''
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
    expect(captured.text).toBe('https://a.com:user@a.com:pass\n')
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

  it('respects a smaller admin-configured max file size, not just the 10 GB default', async () => {
    mockGetMaxUploadFileSizeBytes.mockResolvedValueOnce(10) // 10 bytes, for this call only
    const req = new NextRequest('http://localhost/api/upload?filename=dump.txt', {
      method: 'POST',
      body: 'this body is well over 10 bytes long',
    })
    const res = await POST(req)
    expect(res.status).toBe(200) // job accepted synchronously; the cap trips downstream

    // The text/csv branch is fire-and-forget: processTextStream's mock (see
    // top of file) drains the capped stream itself, so it rejects as soon as
    // the cap trips, and runWithProgress's catch logs the failure — give
    // that a turn before asserting.
    await new Promise(r => setTimeout(r, 10))
    expect(mockLogJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_message: expect.stringContaining('exceeded 10 bytes') })
    )
  })

  it('surfaces a skipped zip entry\'s actual reason in the response, not just its filename', async () => {
    mockProcessZipFile.mockImplementationOnce(async (_path: string, onEntry: (r: unknown) => void) => {
      onEntry({
        imported: 0, skipped: 0, errors: 1, filename: 'bomb.txt', breach_name: 'test',
        rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
        error_reason: 'entry uncompressed size 999999999999 exceeds 53687091200-byte cap',
      })
    })
    const req = new NextRequest('http://localhost/api/upload?filename=archive.zip', {
      method: 'POST',
      body: 'irrelevant — processZipFile is mocked, only the onEntry wiring is under test',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.errors).toBe(1)

    // The summary reaches the admin via logJob's error_message (shown in the
    // /inbox monitor) — filename alone ("1 entry skipped: bomb.txt") used to
    // be all that was visible; the reason was only ever console.error'd.
    expect(mockLogJob).toHaveBeenCalledWith(
      expect.objectContaining({
        error_message: expect.stringContaining('bomb.txt (entry uncompressed size 999999999999 exceeds 53687091200-byte cap)'),
      })
    )
  })
})

describe('POST /api/v1/upload — raw-stream body', () => {
  beforeEach(() => {
    mockProcessTextStream.mockClear()
    mockProcessZipFile.mockClear()
    captured.text = ''
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
    expect(captured.text).toBe('https://a.com:user@a.com:pass\n')
  })

  it('no longer buffers zip uploads into memory before processing (regression test for the v1 OOM-pattern fix)', () => {
    const source = readFileSync(new URL('../app/api/v1/upload/route.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('arrayBuffer()')
    expect(source).not.toContain('processZipBuffer')
  })

  it('respects a smaller admin-configured max file size, not just the 10 GB default', async () => {
    mockGetMaxUploadFileSizeBytes.mockResolvedValueOnce(10) // 10 bytes, for this call only
    const req = new NextRequest('http://localhost/api/v1/upload?filename=dump.txt', {
      method: 'POST',
      body: 'this body is well over 10 bytes long',
    })
    const res = await POST_V1(req) // fully awaited here, unlike the fire-and-forget /api/upload
    expect(res.status).toBe(413)
    const json = await res.json()
    expect(json).toEqual({ success: false, error: 'File too large (max 10 Bytes)' })
  })
})
