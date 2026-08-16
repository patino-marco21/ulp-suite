import { describe, it, expect } from 'vitest'
import { capWebStream, MaxBytesExceededError } from '@/lib/size-capped-stream'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      controller.enqueue(enc.encode(chunks[i++]))
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<{ bytes: number; error?: unknown }> {
  let bytes = 0
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength
    }
    return { bytes }
  } catch (error) {
    return { bytes, error }
  }
}

describe('capWebStream (independent of Content-Length)', () => {
  it('passes through a stream under the limit unchanged', async () => {
    const capped = capWebStream(streamOf(['hello ', 'world']), 100)
    const { bytes, error } = await readAll(capped)
    expect(error).toBeUndefined()
    expect(bytes).toBe('hello world'.length)
  })

  it('allows a stream exactly at the limit (only strictly-over errors)', async () => {
    const capped = capWebStream(streamOf(['12345']), 5)
    const { bytes, error } = await readAll(capped)
    expect(error).toBeUndefined()
    expect(bytes).toBe(5)
  })

  it('errors with MaxBytesExceededError once cumulative bytes exceed the cap, regardless of any Content-Length claim', async () => {
    // Simulates a client that lied about (or omitted) Content-Length: the
    // cap is enforced purely against bytes actually observed.
    const capped = capWebStream(streamOf(['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)]), 15)
    const { bytes, error } = await readAll(capped)
    expect(error).toBeInstanceOf(MaxBytesExceededError)
    expect((error as MaxBytesExceededError).limitBytes).toBe(15)
    // First chunk (10 bytes) passes; the cap trips partway through the
    // second chunk's cumulative total (20 > 15) — nothing from that chunk
    // is delivered, so only the first chunk's bytes made it through.
    expect(bytes).toBe(10)
  })

  it('errors rather than silently truncating and returning success', async () => {
    const capped = capWebStream(streamOf(['x'.repeat(1000)]), 10)
    await expect(readAll(capped).then(r => { if (r.error) throw r.error })).rejects.toThrow(MaxBytesExceededError)
  })
})
