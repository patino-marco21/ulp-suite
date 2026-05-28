import { describe, test, expect, afterEach } from 'vitest'
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
    const tasks = Array.from({ length: 5 }, (_, i) =>
      uploadQueue(async () => {
        maxActive = Math.max(maxActive, uploadQueue.activeCount)
        await new Promise(r => setTimeout(r, 5))
      })
    )
    await Promise.all(tasks)
    expect(maxActive).toBe(1)
  })
})
