import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/clickhouse-migrations', () => ({
  runClickHouseMigrations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/processing-log', () => ({ logJob: vi.fn() }))
vi.mock('@/lib/breach-matcher', () => ({ matchBreach: vi.fn().mockReturnValue('test-breach') }))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/settings', () => ({
  settingsManager: { getMaxUploadFileSizeBytes: vi.fn().mockResolvedValue(10 * 1024 ** 3) },
}))

const captured = vi.hoisted(() => ({ text: '', path: '' }))

vi.mock('@/lib/upload-processor', () => ({
  processTextFile: vi.fn(async (filePath: string, filename: string) => {
    const { readFileSync } = await import('node:fs')
    captured.text = readFileSync(filePath, 'utf8')
    captured.path = filePath
    return {
      imported: 1, skipped: 0, errors: 0, filename, breach_name: 'test',
      rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
    }
  }),
  processZipFile: vi.fn().mockResolvedValue(undefined),
}))

import { settingsManager } from '@/lib/settings'
import { logJob } from '@/lib/processing-log'
import { logUploadAction } from '@/lib/audit-log'
import { processTextFile, processZipFile } from '@/lib/upload-processor'
import { POST } from '@/app/api/upload/route'

const mockProcessTextFile = processTextFile as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>
const mockGetMax = settingsManager.getMaxUploadFileSizeBytes as ReturnType<typeof vi.fn>
const mockLogJob = logJob as ReturnType<typeof vi.fn>
const mockAudit = logUploadAction as ReturnType<typeof vi.fn>

const admin = { id: 1, email: 'admin@example.com' }
let spoolRoot: string

beforeAll(() => {
  spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-route-spool-'))
  process.env.UPLOAD_SPOOL_DIR = spoolRoot
  process.env.UPLOAD_SPOOL_MIN_FREE_BYTES = '0'
})

afterAll(() => {
  fs.rmSync(spoolRoot, { recursive: true, force: true })
  delete process.env.UPLOAD_SPOOL_DIR
  delete process.env.UPLOAD_SPOOL_MIN_FREE_BYTES
})

beforeEach(() => {
  mockProcessTextFile.mockClear()
  mockProcessZipFile.mockReset()
  mockProcessZipFile.mockResolvedValue(undefined)
  mockLogJob.mockClear()
  mockAudit.mockClear()
  captured.text = ''
  captured.path = ''
})

const spoolFiles = () => fs.readdirSync(spoolRoot)
const post = (name: string, body: string, headers: Record<string, string> = {}) =>
  POST(new NextRequest(`http://localhost/api/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', body, headers }))

describe('POST /api/upload: receive first, then reply', () => {
  it('rejects a request with no filename query param', async () => {
    const res = await POST(new NextRequest('http://localhost/api/upload', { method: 'POST', body: 'x' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No filename provided' })
  })

  it('rejects an unsupported file extension without spooling anything', async () => {
    const res = await post('dump.exe', 'irrelevant')

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Unsupported file type')
    expect(spoolFiles()).toEqual([])
  })

  it('receives the whole body, replies with the job, then imports from the spool file and removes it', async () => {
    const body = 'https://a.com:user@a.com:pass\n'

    const res = await post('dump.txt', body)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      success: true,
      jobId: expect.any(String),
      streamUrl: `/api/upload/progress/${json.jobId}`,
      queue_position: expect.any(Number),
    })

    await vi.waitFor(() => expect(mockProcessTextFile).toHaveBeenCalledTimes(1))
    const [filePath, filename, jobId, onBatch, hooks] = mockProcessTextFile.mock.calls[0]
    expect(path.dirname(filePath)).toBe(spoolRoot)
    expect(filePath.endsWith('.upload')).toBe(true)
    expect(filename).toBe('dump.txt')
    expect(jobId).toBe(json.jobId)
    expect(onBatch).toBeUndefined()
    expect(hooks).toEqual({ signal: expect.any(AbortSignal), beat: expect.any(Function) })
    await vi.waitFor(() => expect(captured.text).toBe(body)) // the mock reads the spool file after it is called

    await vi.waitFor(() => expect(spoolFiles()).toEqual([])) // deleted once the import has finished
    expect(mockAudit).toHaveBeenCalledWith(
      'upload.start', admin, json.jobId,
      expect.objectContaining({ filename: 'dump.txt', bytes: Buffer.byteLength(body) }),
      expect.anything(),
    )
    await vi.waitFor(() => expect(mockAudit).toHaveBeenCalledWith(
      'upload.complete', admin, json.jobId, expect.objectContaining({ filename: 'dump.txt', imported: 1 }),
    ))
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', status: 'done', imported: 1 }))
  })

  it('preserves the original filename casing for processing while matching extensions case-insensitively', async () => {
    const res = await post('Mixed-Case-Dump.TXT', 'https://a.com:user@a.com:pass\n')

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(mockProcessTextFile).toHaveBeenCalledTimes(1))
    expect(mockProcessTextFile.mock.calls[0][1]).toBe('Mixed-Case-Dump.TXT')
  })

  it('answers 413 and creates no job when the body exceeds the admin-configured cap', async () => {
    mockGetMax.mockResolvedValueOnce(10) // 10 bytes, for this call only

    const res = await post('dump.txt', 'this body is well over 10 bytes long')

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ success: false, error: 'File too large (max 10 Bytes)' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })

  it('answers 400 and imports nothing when the body is shorter than its Content-Length', async () => {
    const res = await post('dump.txt', 'only ten b', { 'content-length': '100' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Upload incomplete')
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })

  it('answers 400 "Upload cancelled", creates no job and leaves no spool file when the client disconnects mid-body', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('https://a.com:user@a.com:pass\n')) }, // and never ends
    })
    const request = new NextRequest('http://localhost/api/upload?filename=cut.txt', {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' })

    const pending = POST(request)
    await new Promise(resolve => setTimeout(resolve, 30)) // the first chunk reaches the spool file
    controller.abort()
    const res = await pending

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Upload cancelled' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })
})

describe('POST /api/upload: zip archives', () => {
  const entry = (filename: string, imported: number, extra: Record<string, unknown> = {}) => ({
    imported, skipped: 0, errors: 0, filename, breach_name: 'test',
    rejection_breakdown: {}, alreadyImported: false, tierDropped: 0, ...extra,
  })

  it('spools the archive, imports it from the file under the runner and removes the file', async () => {
    mockProcessZipFile.mockImplementationOnce(async (filePath: string, onEntry: (r: unknown) => void) => {
      captured.path = filePath
      onEntry(entry('inner.txt', 2))
    })

    const res = await post('archive.zip', 'pretend zip bytes')

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.imported).toBe(2)
    expect(json.files).toEqual([{ filename: 'inner.txt', breach_name: 'test', imported: 2 }])
    expect(path.dirname(captured.path)).toBe(spoolRoot)
    expect(mockProcessZipFile.mock.calls[0][2]).toEqual({ signal: expect.any(AbortSignal), beat: expect.any(Function) })
    expect(spoolFiles()).toEqual([])
  })

  it("surfaces a skipped zip entry's actual reason in the response, not just its filename", async () => {
    mockProcessZipFile.mockImplementationOnce(async (_path: string, onEntry: (r: unknown) => void) => {
      onEntry(entry('bomb.txt', 0, {
        errors: 1,
        error_reason: 'entry uncompressed size 999999999999 exceeds 53687091200-byte cap',
      }))
    })

    const res = await post('archive.zip', 'irrelevant: processZipFile is mocked')

    expect(res.status).toBe(200)
    expect((await res.json()).errors).toBe(1)
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({
      error_message: expect.stringContaining('bomb.txt (entry uncompressed size 999999999999 exceeds 53687091200-byte cap)'),
    }))
  })

  it('answers 500, audits the failure and removes the spool file when the archive cannot be imported', async () => {
    mockProcessZipFile.mockRejectedValueOnce(new Error('bad archive'))

    const res = await post('archive.zip', 'not really a zip')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'bad archive' })
    expect(mockAudit).toHaveBeenCalledWith('upload.fail', admin, null, expect.objectContaining({ error: 'bad archive' }))
    expect(spoolFiles()).toEqual([])
  })
})
