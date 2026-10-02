import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import {
  UploadNetworkError,
  postFileWithProgress,
  transferPercent,
  uploadErrorMessage,
  type XhrLike,
} from '@/lib/upload-client'

class FakeXhr implements XhrLike {
  opened: { method: string; url: string } | null = null
  sent: Blob | null = null
  status = 0
  responseText = ''
  upload: XhrLike['upload'] = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  open(method: string, url: string) { this.opened = { method, url } }
  send(body: Blob) { this.sent = body }
  abort() { this.onabort?.() }
}

describe('postFileWithProgress', () => {
  it('posts the file, reports transfer progress and resolves with the parsed reply', async () => {
    const xhr = new FakeXhr()
    const onProgress = vi.fn()
    const file = new Blob(['abc'])

    const promise = postFileWithProgress('/api/upload?filename=a.txt', file, onProgress, () => xhr)
    expect(xhr.opened).toEqual({ method: 'POST', url: '/api/upload?filename=a.txt' })
    expect(xhr.sent).toBe(file)

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 })
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 2, total: 0 }) // ignored: the browser does not know the total
    xhr.status = 200
    xhr.responseText = JSON.stringify({ success: true, jobId: 'j1' })
    xhr.onload?.()

    await expect(promise).resolves.toEqual({ status: 200, json: { success: true, jobId: 'j1' } })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(1, 3)
  })

  it('turns a non-JSON reply into a failure the page can show', async () => {
    const xhr = new FakeXhr()
    const promise = postFileWithProgress('/x', new Blob(['a']), () => {}, () => xhr)
    xhr.status = 502
    xhr.responseText = '<html>Bad gateway</html>'
    xhr.onload?.()

    const { status, json } = await promise
    expect(status).toBe(502)
    expect(json).toEqual({ success: false, error: 'Unexpected response from the server (HTTP 502)' })
  })

  it('rejects with UploadNetworkError when the connection drops, times out or is aborted', async () => {
    const dropped = new FakeXhr()
    const first = postFileWithProgress('/x', new Blob(['a']), () => {}, () => dropped)
    dropped.onerror?.()
    await expect(first).rejects.toBeInstanceOf(UploadNetworkError)

    const timedOut = new FakeXhr()
    const second = postFileWithProgress('/x', new Blob(['a']), () => {}, () => timedOut)
    timedOut.ontimeout?.()
    await expect(second).rejects.toBeInstanceOf(UploadNetworkError)

    const aborted = new FakeXhr()
    const third = postFileWithProgress('/x', new Blob(['a']), () => {}, () => aborted)
    aborted.abort()
    await expect(third).rejects.toMatchObject({ name: 'UploadNetworkError', aborted: true })
  })
})

describe('transferPercent', () => {
  it('rounds, clamps to 100 and tolerates an unknown total', () => {
    expect(transferPercent(1, 3)).toBe(33)
    expect(transferPercent(5, 3)).toBe(100)
    expect(transferPercent(5, 0)).toBe(0)
  })
})

describe('uploadErrorMessage', () => {
  const GiB = 1024 ** 3
  const lost = 'The connection to the server was lost during the upload'

  it('points large files at the inbox when the connection failed', () => {
    expect(uploadErrorMessage(new UploadNetworkError(lost), 2 * GiB))
      .toBe(`${lost}. Files this large are more reliable dropped into the inbox folder.`)
  })

  it('leaves small files and server messages alone', () => {
    expect(uploadErrorMessage(new UploadNetworkError(lost), 10 * 1024 * 1024)).toBe(lost)
    expect(uploadErrorMessage(new Error('File too large (max 10 GB)'), 20 * GiB)).toBe('File too large (max 10 GB)')
    expect(uploadErrorMessage('weird', 1)).toBe('Upload failed')
  })
})

describe('the Upload page', () => {
  const page = readFileSync(new URL('../app/upload/page.tsx', import.meta.url), 'utf8')

  it('uploads through the progress helper, not fetch (fetch cannot report how much of the body was sent)', () => {
    expect(page).toContain('postFileWithProgress(')
    expect(page).not.toMatch(/fetch\(`\/api\/upload\?/)
  })
})
