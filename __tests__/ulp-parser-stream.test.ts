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

// ─────────────────────────────────────────────────────────────────────────────
// Garbage rejection through the STREAM parser (the production import path).
// parseULPStream has its own positional + block-flush emitters (distinct from
// parseULPContent); these lock in that the junk gates fire there too.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPStream — garbage rejection (production path)', () => {
  async function collectBreakdown(stream: ReadableStream<Uint8Array>, batchSize = 10) {
    const credentials: { url: string; email: string; password: string }[] = []
    const breakdown: Record<string, number> = { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
    for await (const batch of parseULPStream(stream, FILE, batchSize)) {
      credentials.push(...batch.credentials)
      for (const k of Object.keys(breakdown)) breakdown[k] += (batch.breakdown as Record<string, number>)[k] ?? 0
    }
    return { credentials, breakdown }
  }

  test('inline placeholder login rejected as garbage, valid kept', async () => {
    const { credentials, breakdown } = await collectBreakdown(streamFromChunks([
      'https://site.com:realuser:realpass1\n',
      'https://site.com:Password:realpass1\n',
    ]))
    expect(credentials).toHaveLength(1)
    expect(credentials[0]).toMatchObject({ email: 'realuser' })
    expect(breakdown.garbage).toBe(1)
  })

  test('inline sentinel password [NOT_SAVED] rejected', async () => {
    const { credentials, breakdown } = await collectBreakdown(streamFromChunks([
      'https://site.com:realuser:[NOT_SAVED]\n',
    ]))
    expect(credentials).toHaveLength(0)
    expect(breakdown.garbage).toBe(1)
  })

  test('positional placeholder login rejected via the STREAM positional emitter', async () => {
    const { credentials, breakdown } = await collectBreakdown(streamFromChunks([
      'https://example.com/login\npassword\nfoo:barbaz\n',
    ]))
    expect(credentials).toHaveLength(0)
    expect(breakdown.garbage).toBe(1)
  })

  test('positional sentinel password rejected via the STREAM positional emitter', async () => {
    const { credentials, breakdown } = await collectBreakdown(streamFromChunks([
      'https://example.com/login\nrealuser\n[NOT_SAVED]\n',
    ]))
    expect(credentials).toHaveLength(0)
    expect(breakdown.garbage).toBe(1)
  })

  test('block-format sentinel password rejected via the STREAM block flush', async () => {
    const { credentials, breakdown } = await collectBreakdown(streamFromChunks([
      'Host: https://site.com\nLogin: realuser\nPassword: *none*\n====\n',
    ]))
    expect(credentials).toHaveLength(0)
    expect(breakdown.garbage).toBe(1)
  })

  test('double-encoded mojibake rejected through the stream', async () => {
    // The replacement char must be injected as its RAW bytes (EF BF BD), not via
    // TextEncoder (which would UTF-8-re-encode the codepoints). The stream
    // latin1-decodes EF BF BD → U+00EF U+00BF U+00BD ("ï¿½"), which the garbage
    // filter catches — faithfully reproducing what a real mis-encoded file does.
    const enc = new TextEncoder()
    const bytes = new Uint8Array([
      ...enc.encode('https://site.com:realuser:pa'),
      0xEF, 0xBF, 0xBD,
      ...enc.encode('ss\n'),
    ])
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) { controller.close(); return }
        controller.enqueue(bytes); sent = true; controller.close()
      },
    })
    const { credentials, breakdown } = await collectBreakdown(stream)
    expect(credentials).toHaveLength(0)
    expect(breakdown.garbage).toBe(1)
  })

  test('port/path-leak recovered through the stream', async () => {
    const { credentials } = await collectBreakdown(streamFromChunks([
      'localhost:10000/:admin:12345\n',
    ]))
    expect(credentials).toHaveLength(1)
    expect(credentials[0]).toMatchObject({ url: 'localhost:10000/', email: 'admin', password: '12345' })
  })

  test('URL-path-with-@ not stored as a login through the stream', async () => {
    const { credentials } = await collectBreakdown(streamFromChunks([
      'discord.com/channels/@me/123:GATO\n',
    ]))
    expect(credentials).toHaveLength(0)
  })
})
