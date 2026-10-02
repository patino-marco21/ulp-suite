/**
 * Browser-side upload helper for the Upload page.
 *
 * fetch() cannot report how many bytes of a request body have been sent; XMLHttpRequest can. The server now answers an
 * upload only once it holds the whole file (lib/upload-spool.ts), so the page needs this to show the transfer before the
 * import progress (SSE) starts. No Node imports: this runs in the browser.
 */

export interface PostFileResult {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
}

export class UploadNetworkError extends Error {
  readonly aborted: boolean

  constructor(message: string, aborted = false) {
    super(message)
    this.name = 'UploadNetworkError'
    this.aborted = aborted
  }
}

/** The subset of XMLHttpRequest this helper uses, so tests can fake it. */
export interface XhrLike {
  open(method: string, url: string): void
  send(body: Blob): void
  abort(): void
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
  status: number
  responseText: string
}

const LOST = 'The connection to the server was lost during the upload'

export function postFileWithProgress(
  url: string,
  file: Blob,
  onProgress: (loaded: number, total: number) => void,
  createXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): Promise<PostFileResult> {
  return new Promise<PostFileResult>((resolve, reject) => {
    const xhr = createXhr()
    xhr.open('POST', url)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      let json: unknown
      try {
        json = JSON.parse(xhr.responseText)
      } catch {
        json = { success: false, error: `Unexpected response from the server (HTTP ${xhr.status})` }
      }
      resolve({ status: xhr.status, json })
    }
    xhr.onerror = () => reject(new UploadNetworkError(LOST))
    xhr.ontimeout = () => reject(new UploadNetworkError(LOST))
    xhr.onabort = () => reject(new UploadNetworkError('The upload was cancelled', true))
    xhr.send(file)
  })
}

/** Files at least this large are better dropped in the inbox folder when the connection fails. */
export const LARGE_UPLOAD_HINT_BYTES = 1024 ** 3

export function transferPercent(loaded: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
}

/** The message the page shows for a failed upload; a dropped connection on a large file points at the inbox. */
export function uploadErrorMessage(err: unknown, fileSize: number): string {
  const base = err instanceof Error ? err.message : 'Upload failed'
  if (err instanceof UploadNetworkError && fileSize >= LARGE_UPLOAD_HINT_BYTES) {
    return `${base}. Files this large are more reliable dropped into the inbox folder.`
  }
  return base
}
