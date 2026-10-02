import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaxBytesExceededError } from '@/lib/size-capped-stream'
import {
  SpoolIncompleteError,
  SpoolInsufficientStorageError,
  describeSpoolError,
  discardSpool,
  spoolDir,
  spoolMinFreeBytes,
  spoolRequestBody,
  startSpoolJanitor,
  sweepSpool,
} from '@/lib/upload-spool'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-spool-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const bytes = (s: string) => new TextEncoder().encode(s)
const bodyOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const s of chunks) controller.enqueue(bytes(s))
      controller.close()
    },
  })
/** A body that delivers one chunk and then never ends, like a client that went away. */
const hangingBody = (first: string) =>
  new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes(first)) } })
/** Plenty of free space and no reserve, so only the behaviour under test matters. */
const roomy = { statfs: async () => ({ bavail: 1_000_000, bsize: 1_000_000 }), minFreeBytes: 0 }
const names = () => fs.readdirSync(dir)

describe('spoolRequestBody', () => {
  it('writes the whole body to a .upload file and reports its size', async () => {
    const result = await spoolRequestBody(bodyOf('abc', 'def'), { maxBytes: 100, dir, ...roomy })

    expect(result.bytes).toBe(6)
    expect(result.path.endsWith('.upload')).toBe(true)
    expect(path.dirname(result.path)).toBe(dir)
    expect(fs.readFileSync(result.path, 'utf8')).toBe('abcdef')
    expect(names()).toEqual([path.basename(result.path)]) // no .part left behind
  })

  it('accepts a body whose length matches the declared Content-Length', async () => {
    const result = await spoolRequestBody(bodyOf('abcdef'), { maxBytes: 100, dir, expectedBytes: 6, ...roomy })
    expect(result.bytes).toBe(6)
  })

  it('rejects a short body with SpoolIncompleteError and leaves nothing behind', async () => {
    await expect(
      spoolRequestBody(bodyOf('abc'), { maxBytes: 100, dir, expectedBytes: 100, ...roomy })
    ).rejects.toBeInstanceOf(SpoolIncompleteError)
    expect(names()).toEqual([])
  })

  it('enforces the size cap with MaxBytesExceededError and leaves nothing behind', async () => {
    await expect(
      spoolRequestBody(bodyOf('abcdef'), { maxBytes: 4, dir, ...roomy })
    ).rejects.toBeInstanceOf(MaxBytesExceededError)
    expect(names()).toEqual([])
  })

  it('cleans up and rejects with the abort reason when the client disconnects mid-body', async () => {
    const controller = new AbortController()
    const pending = spoolRequestBody(hangingBody('abc'), { maxBytes: 100, dir, signal: controller.signal, ...roomy })
    const rejection = expect(pending).rejects.toHaveProperty('name', 'AbortError')

    await new Promise(resolve => setTimeout(resolve, 20)) // let the first chunk reach the file
    controller.abort()

    await rejection
    expect(names()).toEqual([])
  })

  it('refuses an upload that would leave less than the free-space floor, before writing anything', async () => {
    await expect(
      spoolRequestBody(bodyOf('abc'), {
        maxBytes: 100,
        dir,
        expectedBytes: 5,
        statfs: async () => ({ bavail: 10, bsize: 1 }),
        minFreeBytes: 100,
      })
    ).rejects.toBeInstanceOf(SpoolInsufficientStorageError)
    expect(names()).toEqual([])
  })

  it('cuts a body of undeclared length when it reaches the free-space floor', async () => {
    await expect(
      spoolRequestBody(bodyOf('x'.repeat(60), 'y'.repeat(60)), {
        maxBytes: 1_000,
        dir,
        statfs: async () => ({ bavail: 1_000, bsize: 1 }),
        minFreeBytes: 900, // 100 bytes of budget
      })
    ).rejects.toBeInstanceOf(SpoolInsufficientStorageError)
    expect(names()).toEqual([])
  })
})

describe('discardSpool', () => {
  it('removes the file and is idempotent', async () => {
    const { path: file } = await spoolRequestBody(bodyOf('abc'), { maxBytes: 100, dir, ...roomy })

    await discardSpool(file)
    expect(fs.existsSync(file)).toBe(false)
    await expect(discardSpool(file)).resolves.toBeUndefined()
  })
})

describe('sweepSpool', () => {
  it('removes spool files nobody owns once they are old enough, and keeps owned and young ones', async () => {
    const owned = (await spoolRequestBody(bodyOf('keep'), { maxBytes: 100, dir, ...roomy })).path
    const orphanOld = path.join(dir, 'orphan-old.upload')
    const orphanYoung = path.join(dir, 'orphan-young.part')
    fs.writeFileSync(orphanOld, 'x')
    fs.writeFileSync(orphanYoung, 'x')
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000
    fs.utimesSync(orphanOld, twoHoursAgo, twoHoursAgo)
    fs.utimesSync(owned, twoHoursAgo, twoHoursAgo)

    const removed = await sweepSpool({ dir, maxAgeMs: 3_600_000 })

    expect(removed).toEqual(['orphan-old.upload'])
    expect(fs.existsSync(owned)).toBe(true)
    expect(fs.existsSync(orphanYoung)).toBe(true)
  })

  it('with maxAgeMs 0 removes every file nobody owns (at startup a new process owns none)', async () => {
    fs.writeFileSync(path.join(dir, 'a.upload'), 'x')
    fs.writeFileSync(path.join(dir, 'b.part'), 'x')

    const removed = await sweepSpool({ dir, maxAgeMs: 0 })

    expect(removed.sort()).toEqual(['a.upload', 'b.part'])
    expect(names()).toEqual([])
  })

  it('returns an empty list when the directory does not exist', async () => {
    await expect(sweepSpool({ dir: path.join(dir, 'missing'), maxAgeMs: 0 })).resolves.toEqual([])
  })
})

describe('startSpoolJanitor', () => {
  it('removes leftovers at startup and can be stopped', async () => {
    vi.stubEnv('UPLOAD_SPOOL_DIR', dir)
    const leftover = path.join(dir, 'leftover.upload')
    fs.writeFileSync(leftover, 'x')

    const stop = startSpoolJanitor()
    try {
      await vi.waitFor(() => expect(fs.existsSync(leftover)).toBe(false))
      expect(startSpoolJanitor()).toBe(stop) // a second start is a no-op that returns the same stop
    } finally {
      stop()
    }
  })
})

describe('configuration', () => {
  it('spoolDir defaults to /tmp/ulp-spool and honours UPLOAD_SPOOL_DIR', () => {
    vi.stubEnv('UPLOAD_SPOOL_DIR', '')
    expect(spoolDir()).toBe('/tmp/ulp-spool')
    vi.stubEnv('UPLOAD_SPOOL_DIR', '/data/spool')
    expect(spoolDir()).toBe('/data/spool')
  })

  it('spoolMinFreeBytes defaults to 20 GiB and ignores nonsense', () => {
    vi.stubEnv('UPLOAD_SPOOL_MIN_FREE_BYTES', '')
    expect(spoolMinFreeBytes()).toBe(20 * 1024 ** 3)
    vi.stubEnv('UPLOAD_SPOOL_MIN_FREE_BYTES', 'lots')
    expect(spoolMinFreeBytes()).toBe(20 * 1024 ** 3)
    vi.stubEnv('UPLOAD_SPOOL_MIN_FREE_BYTES', '1048576')
    expect(spoolMinFreeBytes()).toBe(1_048_576)
  })
})

describe('describeSpoolError', () => {
  it('maps the spool failures to an HTTP status and a message, and ignores everything else', () => {
    expect(describeSpoolError(new MaxBytesExceededError(10))).toEqual({ status: 413, message: 'File too large (max 10 Bytes)' })
    expect(describeSpoolError(new SpoolIncompleteError(5, 100))).toEqual({
      status: 400,
      message: 'Upload incomplete: 5 of 100 bytes arrived. Nothing was imported.',
    })
    expect(describeSpoolError(new SpoolInsufficientStorageError(1, 2))).toEqual({
      status: 507,
      message: 'Not enough free disk space to accept this upload.',
    })
    expect(describeSpoolError(new Error('something else'))).toBeNull()
  })
})
