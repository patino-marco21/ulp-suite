/**
 * Streaming tests for lib/ulp-parser.ts's parseULPStream.
 *
 * Covers:
 *  - basic multi-chunk streaming correctness (previously untested)
 *  - the MAX_LINE_LENGTH cap added after a 1.9GB production file crashed with
 *    "RangeError: Invalid string length": a long run with no '\n' must be
 *    rejected in bounded time/memory without losing credentials before or
 *    after it. (Reproducing the literal ~512MB-1GB crash isn't practical in
 *    a unit test — this exercises the same force-flush path at a smaller
 *    scale.)
 */

import { describe, test, expect } from 'vitest'
import { parseULPStream } from '@/lib/ulp-parser'

const FILE = 'stream-test.txt'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>, batchSize = 10) {
  const credentials: { url: string; email: string; password: string }[] = []
  let rejected = 0
  for await (const batch of parseULPStream(stream, FILE, batchSize)) {
    credentials.push(...batch.credentials)
    rejected += batch.rejected
  }
  return { credentials, rejected }
}

describe('parseULPStream', () => {
  test('parses credentials split across multiple chunks', async () => {
    const stream = streamFromChunks([
      'https://good1.com:user1@good1.com:pass1\nhttps://go',
      'od2.com:user2@good2.com:pass2\n',
    ])
    const { credentials } = await collect(stream)

    expect(credentials).toHaveLength(2)
    expect(credentials[0]).toMatchObject({ url: 'https://good1.com', email: 'user1@good1.com', password: 'pass1' })
    expect(credentials[1]).toMatchObject({ url: 'https://good2.com', email: 'user2@good2.com', password: 'pass2' })
  })

  test('an oversized no-newline span is rejected without losing surrounding credentials', async () => {
    // 1.2 MB of non-text data with zero '\n' — exceeds MAX_LINE_LENGTH (1 MB)
    // and must be force-flushed instead of growing `buffer` unboundedly.
    const noNewlineSpan = Array.from({ length: 12 }, () => 'X'.repeat(100_000))

    const stream = streamFromChunks([
      'https://good1.com:user1@good1.com:pass1\n',
      ...noNewlineSpan,
      '\nhttps://good2.com:user2@good2.com:pass2\n',
    ])

    const { credentials, rejected } = await collect(stream)

    expect(credentials).toHaveLength(2)
    expect(credentials[0]).toMatchObject({ url: 'https://good1.com' })
    expect(credentials[1]).toMatchObject({ url: 'https://good2.com' })
    // The oversized span was force-flushed and rejected, not silently dropped
    // and not merged into a neighboring credential.
    expect(rejected).toBeGreaterThan(0)
  })
})
