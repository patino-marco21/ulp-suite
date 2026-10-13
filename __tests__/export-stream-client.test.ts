import { describe, test, expect } from 'vitest'
import { readCountedStream } from '@/lib/export-stream-client'

const enc = new TextEncoder()
function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]))
      else controller.close()
    },
  })
}
const join = (chunks: Uint8Array[]) => chunks.map(c => new TextDecoder().decode(c)).join('')

describe('readCountedStream', () => {
  test('counts the newline-terminated rows and keeps every byte', async () => {
    const read = await readCountedStream(streamOf(['a\nb\n', 'c\n']), 0)
    expect(read.rows).toBe(3)
    expect(join(read.chunks)).toBe('a\nb\nc\n')
    expect(read.bytes).toBe(6)
  })

  test('the header line of a csv is not a row', async () => {
    expect((await readCountedStream(streamOf(['h1,h2\n', 'x\ny\n']), 1)).rows).toBe(2)
  })

  test('a line split across chunks is counted once', async () => {
    expect((await readCountedStream(streamOf(['ab', 'c\nd', '\n']), 0)).rows).toBe(2)
  })

  test('an empty stream, or a header only, is zero rows and never negative', async () => {
    expect((await readCountedStream(streamOf([]), 0)).rows).toBe(0)
    expect((await readCountedStream(streamOf([]), 1)).rows).toBe(0)
    expect((await readCountedStream(streamOf(['h\n']), 1)).rows).toBe(0)
  })

  test('the progress callback is throttled, never goes down, and ends with the total', async () => {
    let t = 0
    const seen: number[] = []
    const read = await readCountedStream(streamOf(Array.from({ length: 20 }, () => 'x\n')), 0, n => seen.push(n), () => (t += 100), 250)
    expect(read.rows).toBe(20)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.length).toBeLessThan(20)
    expect(seen[seen.length - 1]).toBe(20)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})
