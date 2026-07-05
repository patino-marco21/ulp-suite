import { describe, test, it, expect, afterEach, vi } from 'vitest'
import { uploadQueue, queueSize } from '@/lib/upload-queue'

/** Flush the microtask queue so pLimit v7 (async executor) can start tasks. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('uploadQueue', () => {
  afterEach(() => {
    // Clear any pending tasks left by a test so the shared singleton
    // does not bleed state into the next test.
    uploadQueue.clearQueue()
  })

  test('runs tasks one at a time — second task waits for first', async () => {
    const order: number[] = []
    let resolveFirst!: () => void

    const task1 = uploadQueue(
      () => new Promise<void>(r => { resolveFirst = r }).then(() => { order.push(1) })
    )
    // queue task2 while task1 is still pending
    const task2 = uploadQueue(async () => { order.push(2) })

    // Yield to the microtask queue so pLimit v7 starts task1
    await tick()

    // Neither has finished yet — task1 is running, task2 is pending
    expect(order).toEqual([])

    resolveFirst()
    await task1
    await task2

    // Must be sequential, not interleaved
    expect(order).toEqual([1, 2])
  })

  test('queueSize counts active + pending work', async () => {
    let resolveFirst!: () => void

    const task1 = uploadQueue(
      () => new Promise<void>(r => { resolveFirst = r })
    )
    // Enqueue a second task so pendingCount > 0
    uploadQueue(async () => {})

    // Yield so pLimit v7 starts task1 (activeCount becomes 1)
    await tick()

    expect(queueSize()).toBeGreaterThanOrEqual(1)

    resolveFirst()
    await task1
  })

  test('concurrency is 1 — activeCount never exceeds 1', async () => {
    let maxActive = 0
    const tasks = Array.from({ length: 5 }, (_) =>
      uploadQueue(async () => {
        maxActive = Math.max(maxActive, uploadQueue.activeCount)
        await new Promise(r => setTimeout(r, 5))
      })
    )
    await Promise.all(tasks)
    expect(maxActive).toBe(1)
  })
})

describe('parseConcurrency', () => {
  it('defaults to 1 for unset, empty, non-numeric, zero, or negative', async () => {
    const { parseConcurrency } = await import('@/lib/upload-queue')
    expect(parseConcurrency(undefined)).toBe(1)
    expect(parseConcurrency('')).toBe(1)
    expect(parseConcurrency('abc')).toBe(1)
    expect(parseConcurrency('0')).toBe(1)
    expect(parseConcurrency('-4')).toBe(1)
  })

  it('parses valid positive integers', async () => {
    const { parseConcurrency } = await import('@/lib/upload-queue')
    expect(parseConcurrency('2')).toBe(2)
    expect(parseConcurrency('3')).toBe(3)
  })
})

describe('uploadQueue concurrency from env', () => {
  const original = process.env.UPLOAD_CONCURRENCY
  afterEach(() => {
    if (original === undefined) delete process.env.UPLOAD_CONCURRENCY
    else process.env.UPLOAD_CONCURRENCY = original
    // The queue is now a globalThis-backed singleton (lib/upload-queue.ts) so
    // it survives vi.resetModules() by design -- that IS the fix under test
    // elsewhere in this file. These two tests specifically simulate a fresh
    // process picking up a new env value, so they must also clear the cached
    // global, not just reset the module registry.
    delete globalThis.__ulpUploadQueue
    vi.resetModules()
  })

  it('honours UPLOAD_CONCURRENCY when building the limiter', async () => {
    process.env.UPLOAD_CONCURRENCY = '3'
    delete globalThis.__ulpUploadQueue
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(3)
  })

  it('defaults the limiter to concurrency 1', async () => {
    delete process.env.UPLOAD_CONCURRENCY
    delete globalThis.__ulpUploadQueue
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(1)
  })
})

describe('globalThis-backed singleton (survives cross-chunk duplication)', () => {
  test('the exported uploadQueue is the same object stored on globalThis', async () => {
    const { uploadQueue: reImportedQueue } = await import('@/lib/upload-queue')
    expect(globalThis.__ulpUploadQueue).toBe(reImportedQueue)
  })

  test('setCurrentJob/getCurrentJob read and write through globalThis', async () => {
    const { setCurrentJob, getCurrentJob } = await import('@/lib/upload-queue')
    setCurrentJob('probe-globalthis-job.txt')
    expect(globalThis.__ulpCurrentJob).toBe('probe-globalthis-job.txt')
    expect(getCurrentJob()).toBe('probe-globalthis-job.txt')
    setCurrentJob(null)
    expect(globalThis.__ulpCurrentJob).toBeNull()
    expect(getCurrentJob()).toBeNull()
  })
})
