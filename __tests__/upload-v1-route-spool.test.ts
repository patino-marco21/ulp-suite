import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/processing-log', () => ({ logJob: vi.fn() }))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { keyId: '5', userId: '2', userName: 'ci', name: 'ci-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
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
import { POST } from '@/app/api/v1/upload/route'

const mockProcessTextFile = processTextFile as ReturnType<typeof vi.fn>
const mockProcessZipFile = processZipFile as ReturnType<typeof vi.fn>
const mockGetMax = settingsManager.getMaxUploadFileSizeBytes as ReturnType<typeof vi.fn>
const mockLogJob = logJob as ReturnType<typeof vi.fn>
const mockAudit = logUploadAction as ReturnType<typeof vi.fn>

let spoolRoot: string

beforeAll(() => {
  spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-v1-spool-'))
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
const post = (name: string, body: string) =>
  POST(new NextRequest(`http://localhost/api/v1/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', body }))

describe('POST /api/v1/upload: spool first, answer when the import has finished', () => {
  it('rejects a request with no filename query param', async () => {
    const res = await POST(new NextRequest('http://localhost/api/v1/upload', { method: 'POST', body: 'x' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No filename provided' })
  })

  it('imports a text upload from the spool file and answers with the result', async () => {
    const body = 'https://a.com:user@a.com:pass\n'

    const res = await post('dump.txt', body)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, imported: 1, skipped: 0, errors: 0, filename: 'dump.txt' })
    const [filePath, filename, jobId, onBatch, hooks] = mockProcessTextFile.mock.calls[0]
    expect(path.dirname(filePath)).toBe(spoolRoot)
    expect(filename).toBe('dump.txt')
    expect(jobId).toBeUndefined()
    expect(onBatch).toBeUndefined()
    expect(hooks).toEqual({ signal: expect.any(AbortSignal), beat: expect.any(Function) })
    expect(captured.text).toBe(body)
    expect(spoolFiles()).toEqual([]) // removed before the response
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', status: 'done', imported: 1 }))
  })

  it('audits the start and the end with the API key', async () => {
    await post('dump.txt', 'https://a.com:user@a.com:pass\n')

    expect(mockAudit).toHaveBeenCalledWith(
      'upload.api.start', { id: 2, email: null }, null,
      expect.objectContaining({ api_key_id: '5', api_key_name: 'ci-key', filename: 'dump.txt' }),
      expect.anything(),
    )
    expect(mockAudit).toHaveBeenCalledWith(
      'upload.api.complete', { id: 2, email: null }, null,
      expect.objectContaining({ api_key_id: '5', filename: 'dump.txt', imported: 1 }),
    )
  })

  it('no longer buffers zip uploads into memory before processing (regression test for the v1 OOM-pattern fix)', () => {
    const source = fs.readFileSync(new URL('../app/api/v1/upload/route.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('arrayBuffer()')
    expect(source).not.toContain('processZipBuffer')
  })

  it('imports a zip from the spool file and lists its entries', async () => {
    mockProcessZipFile.mockImplementationOnce(async (filePath: string, onEntry: (r: unknown) => void) => {
      captured.path = filePath
      onEntry({
        imported: 2, skipped: 0, errors: 0, filename: 'inner.txt', breach_name: 'test',
        rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
      })
    })

    const res = await post('archive.zip', 'pretend zip bytes')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, imported: 2, skipped: 0, errors: 0,
      files: [{ filename: 'inner.txt', imported: 2 }], filename: 'archive.zip',
    })
    expect(path.dirname(captured.path)).toBe(spoolRoot)
    expect(spoolFiles()).toEqual([])
  })

  it('respects a smaller admin-configured max file size, not just the 10 GB default', async () => {
    mockGetMax.mockResolvedValueOnce(10) // 10 bytes, for this call only

    const res = await post('dump.txt', 'this body is well over 10 bytes long')

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ success: false, error: 'File too large (max 10 Bytes)' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(spoolFiles()).toEqual([])
  })

  it('answers 400 and imports nothing when the client disconnects mid-body', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('https://a.com:user@a.com:pass\n')) }, // and never ends
    })
    const request = new NextRequest('http://localhost/api/v1/upload?filename=cut.txt', {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' })

    const pending = POST(request)
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort()
    const res = await pending

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Upload cancelled' })
    expect(mockProcessTextFile).not.toHaveBeenCalled()
    expect(spoolFiles()).toEqual([])
  })
})
