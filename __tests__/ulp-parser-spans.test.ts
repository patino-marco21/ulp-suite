/**
 * Span tracking in parseULPStream (docs/superpowers/plans/2026-11-15-reduced-archive.md, task 1). With `trackSpans` every batch says where in the file each credential
 * record sits (`spans`, flat start/end pairs aligned with `credentials`) and which rejected units are worth keeping (`kept`). The reduced archive writer copies exactly
 * those bytes. Tracking must not change what is parsed: a differential test compares tracked and untracked runs on random mixed input, fed in random chunk sizes.
 */
import { describe, expect, test } from 'vitest'
import { parseULPStream, type ULPCredential } from '@/lib/ulp-parser'

const FILE = 'spans-test.txt'
const HASH = 'AbCdEfGhIjKlMnOpQrSt'

function streamOf(text: string, chunk = Infinity): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(text, 'latin1')
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return }
      const end = Math.min(bytes.length, at + chunk)
      controller.enqueue(new Uint8Array(bytes.subarray(at, end)))
      at = end
    },
  })
}

interface Run { credentials: ULPCredential[]; spans: number[]; kept: number[]; androidRepeats: number[]; overlongLines: number; breakdown: Record<string, number>; rejected: number; batches: number }

async function run(text: string, opts: { track: boolean; chunk?: number; batchSize?: number; hard?: (email: string, url: string) => boolean }): Promise<Run> {
  const out: Run = { credentials: [], spans: [], kept: [], androidRepeats: [], overlongLines: 0, breakdown: {}, rejected: 0, batches: 0 }
  for await (const b of parseULPStream(streamOf(text, opts.chunk), FILE, opts.batchSize ?? 100_000, opts.hard, { dedupInFile: false, trackSpans: opts.track })) {
    out.batches++
    out.credentials.push(...b.credentials)
    out.rejected += b.rejected
    for (const [k, v] of Object.entries(b.breakdown)) out.breakdown[k] = (out.breakdown[k] ?? 0) + v
    if (opts.track) {
      expect(b.spans).toBeDefined()
      expect(b.spans!.length).toBe(2 * b.credentials.length)
      out.spans.push(...b.spans!)
      out.kept.push(...(b.kept ?? []))
      out.androidRepeats.push(...(b.androidRepeats ?? []))
      out.overlongLines += b.overlongLines ?? 0
    } else {
      expect(b.spans).toBeUndefined()
      expect(b.kept).toBeUndefined()
      expect(b.androidRepeats).toBeUndefined()
      expect(b.overlongLines).toBeUndefined()
    }
  }
  return out
}

const slice = (text: string, s: number, e: number) => Buffer.from(text, 'latin1').subarray(s, e).toString('latin1')
const pairs = (flat: number[]) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]] as [number, number])

describe('parseULPStream trackSpans', () => {
  test('an inline credential line is its own span, newline included', async () => {
    const text = 'https://a.example.com:alice@x.test:pw1234\nhttps://b.example.com:bob@y.test:pw5678\n'
    const r = await run(text, { track: true })
    expect(r.credentials.map(c => c.email)).toEqual(['alice@x.test', 'bob@y.test'])
    expect(pairs(r.spans).map(([s, e]) => slice(text, s, e))).toEqual([
      'https://a.example.com:alice@x.test:pw1234\n',
      'https://b.example.com:bob@y.test:pw5678\n',
    ])
    expect(r.kept).toEqual([])
  })

  test('a labelled block spans from its first label to the separator that closed it, and the next record is separate', async () => {
    const text = 'Host: https://blk.example.com\nLogin: carol@z.test\nPassword: hunter22\n\nhttps://c.example.com:dave@w.test:pw9999\n'
    const r = await run(text, { track: true })
    expect(r.credentials.map(c => c.email)).toEqual(['carol@z.test', 'dave@w.test'])
    expect(pairs(r.spans).map(([s, e]) => slice(text, s, e))).toEqual([
      'Host: https://blk.example.com\nLogin: carol@z.test\nPassword: hunter22\n\n',
      'https://c.example.com:dave@w.test:pw9999\n',
    ])
  })

  test('a block that ends at the end of the file spans to the end', async () => {
    const text = 'https://a.example.com:alice@x.test:pw1234\nHost: https://blk.example.com\nLogin: carol@z.test\nPassword: hunter22'
    const r = await run(text, { track: true })
    expect(r.credentials).toHaveLength(2)
    const [, last] = pairs(r.spans)
    expect(slice(text, last[0], last[1])).toBe('Host: https://blk.example.com\nLogin: carol@z.test\nPassword: hunter22')
  })

  test('a url / login / password triple is one span of three lines', async () => {
    const text = 'https://p.example.com\nerin@q.test\nsecretpw1\nhttps://a.example.com:alice@x.test:pw1234\n'
    const r = await run(text, { track: true })
    expect(r.credentials.map(c => c.email)).toEqual(['erin@q.test', 'alice@x.test'])
    expect(pairs(r.spans).map(([s, e]) => slice(text, s, e))).toEqual([
      'https://p.example.com\nerin@q.test\nsecretpw1\n',
      'https://a.example.com:alice@x.test:pw1234\n',
    ])
  })

  test('a banner and a record that never got its login are kept; blanks, repeats and tier-dropped lines are not', async () => {
    const text = [
      'some free text that holds no credential',                  // no_fields: kept
      '',                                                           // blank: dropped
      'https://a.example.com:t3user@x.test:pw1234',                // tier-dropped by the predicate: dropped
      `${HASH}==@com.example.app/:alice@mail.test:Secret1`,        // first android line: a credential
      `${HASH}==@com.example.other/:alice@mail.test:Secret1`,      // repeat of the pair under another app id: dropped
      'https://lonely.example.com',                                // opens a positional record ...
      'Login: someone@z.test',                                      // ... a label ends it: the lonely url is kept
      '',
      'https://ok.example.com:okuser@x.test:pw1234',
    ].join('\n') + '\n'
    const r = await run(text, { track: true, hard: email => email.startsWith('t3') })
    expect(r.credentials.map(c => c.email)).toEqual(['alice@mail.test', 'okuser@x.test'])
    const keptText = pairs(r.kept).map(([s, e]) => slice(text, s, e))
    expect(keptText.join('')).toContain('some free text that holds no credential\n')
    expect(keptText.join('')).toContain('https://lonely.example.com\n')
    expect(keptText.join('')).not.toContain('t3user')
    expect(keptText.join('')).not.toContain('com.example.other')
    expect(r.breakdown.tier_dropped).toBe(1)
    expect(r.breakdown.dedup).toBe(1)
  })

  test('CRLF line ends and a last line without a newline have exact offsets', async () => {
    const text = 'https://a.example.com:alice@x.test:pw1234\r\nhttps://b.example.com:bob@y.test:pw5678'
    const r = await run(text, { track: true })
    expect(pairs(r.spans).map(([s, e]) => slice(text, s, e))).toEqual([
      'https://a.example.com:alice@x.test:pw1234\r\n',
      'https://b.example.com:bob@y.test:pw5678',
    ])
  })

  test('offsets stay exact behind an over-long line that was flushed in pieces', async () => {
    const first = 'https://a.example.com:alice@x.test:pw1234\n'
    const second = 'https://b.example.com:bob@y.test:pw5678\n'
    const chunk1 = first + 'y'.repeat((1 << 20) + 5000)               // no newline: the parser flushes this partial line
    const chunk2 = 'z'.repeat(10) + '\n' + second
    const text = chunk1 + chunk2
    const bytes = Buffer.from(text, 'latin1')
    let i = 0
    const parts = [bytes.subarray(0, chunk1.length), bytes.subarray(chunk1.length)]
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (i < parts.length) c.enqueue(new Uint8Array(parts[i++])); else c.close() } })
    const spans: number[] = []
    for await (const b of parseULPStream(stream, FILE, 100_000, undefined, { dedupInFile: false, trackSpans: true })) spans.push(...b.spans!)
    expect(pairs(spans).map(([s, e]) => slice(text, s, e))).toEqual([first, second])
  })

  test('without trackSpans a batch carries no spans and no kept ranges', async () => {
    const r = await run('https://a.example.com:alice@x.test:pw1234\nnot a credential\n', { track: false })
    expect(r.credentials).toHaveLength(1)
  })

  test('a repeat of an android pair is reported with the line of the pair it repeats, across batches', async () => {
    const first = `${HASH}==@com.example.app/:alice@mail.test:Secret1\n`
    const repeat1 = `${HASH}==@com.example.other/:alice@mail.test:Secret1\n`
    const unrelated = `${HASH}==@com.example.app/:bob@mail.test:Secret2\n`
    const repeat2 = `https://android://${HASH}==@com.example.third/:alice@mail.test:Secret1\n`
    const text = 'free text that holds no credential\n' + first + unrelated + repeat1 + repeat2
    for (const batchSize of [100_000, 1]) {
      const r = await run(text, { track: true, batchSize })
      expect(r.credentials.map(c => c.email)).toEqual(['alice@mail.test', 'bob@mail.test'])
      const quads = Array.from({ length: r.androidRepeats.length / 4 }, (_, i) => r.androidRepeats.slice(4 * i, 4 * i + 4))
      expect(quads.map(([rs, re, fs, fe]) => [slice(text, rs, re), slice(text, fs, fe)])).toEqual([[repeat1, first], [repeat2, first]])
    }
  })

  test('a repeat that is dropped by something else than the android rule is not reported, and nothing is reported without trackSpans', async () => {
    const first = `${HASH}==@com.example.app/:alice@mail.test:Secret1\n`
    const text = first + `${HASH}==@com.example.other/:alice@mail.test:Secret1\n`
    expect((await run(text, { track: true })).androidRepeats.length).toBe(4)
    expect((await run('https://a.example.com:alice@x.test:pw1234\nhttps://a.example.com:alice@x.test:pw1234\n', { track: true })).androidRepeats).toEqual([])
    expect((await run(text, { track: false })).androidRepeats).toEqual([])
  })

  test('a line over the parser\'s length limit is reported however the bytes arrive: cut into pieces by one chunking, read whole by another', async () => {
    const text = 'https://a.example.com:alice@x.test:pw1234\n' + 'y'.repeat((1 << 20) + 5000) + '\nhttps://b.example.com:bob@y.test:pw5678\n'
    expect((await run(text, { track: true })).overlongLines).toBe(1)                     // all in one chunk: the line is read whole
    expect((await run(text, { track: true, chunk: 1 << 16 })).overlongLines).toBe(1)    // small chunks: still one line
    const cut = 'https://a.example.com:alice@x.test:pw1234\n' + 'y'.repeat(3 << 20) + '\n'
    expect((await run(cut, { track: true, chunk: 1 << 16 })).overlongLines).toBeGreaterThan(0)   // a 3 MiB line is cut into pieces where the buffer stands
    expect((await run(text, { track: false })).overlongLines).toBe(0)
  })

  test('a line of exactly the limit, and ordinary lines, are not reported', async () => {
    const atLimit = 'https://a.example.com:alice@x.test:pw1234\n' + 'y'.repeat(1 << 20) + '\n' + 'https://b.example.com:bob@y.test:pw5678\n'
    expect((await run(atLimit, { track: true, chunk: 1 << 16 })).overlongLines).toBe(0)
    expect((await run('https://a.example.com:alice@x.test:pw1234\n' + 'y'.repeat(5000) + '\n', { track: true })).overlongLines).toBe(0)
  })

  test('differential: tracking changes nothing that is parsed, and every span holds its credential', async () => {
    const pool = [
      'https://a.example.com:alice@x.test:pw1234',
      'https://b.example.com:bob@y.test:pw5678',
      'carol@z.test:hunter22',
      'plain banner text',
      '',
      '=====',
      'Host: https://blk.example.com',
      'Login: dave@w.test',
      'Password: pw9999x',
      'Soft: Chrome',
      'https://p.example.com',
      'erin@q.test',
      'secretpw1',
      `${HASH}==@com.example.app/:frank@mail.test:Secret1`,
      `${HASH}==@com.example.other/:frank@mail.test:Secret1`,
      'https://t3.example.com:t3user@x.test:pw1234',
      'http',
      '\t',
    ]
    let seed = 12345
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const hard = (email: string) => email.startsWith('t3')
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(rnd() * 40)
      const lines = Array.from({ length: count }, () => pool[Math.floor(rnd() * pool.length)])
      const eol = rnd() < 0.3 ? '\r\n' : '\n'
      const text = lines.join(eol) + (rnd() < 0.8 ? eol : '')
      const chunk = 1 + Math.floor(rnd() * 60)
      const batchSize = 1 + Math.floor(rnd() * 5)
      const plain = await run(text, { track: false, chunk, batchSize, hard })
      const tracked = await run(text, { track: true, chunk, batchSize, hard })
      expect(tracked.credentials).toEqual(plain.credentials)
      expect(tracked.breakdown).toEqual(plain.breakdown)
      expect(tracked.rejected).toBe(plain.rejected)
      const sp = pairs(tracked.spans)
      sp.forEach(([s, e], i) => {
        expect(e).toBeGreaterThan(s)
        expect(e).toBeLessThanOrEqual(Buffer.byteLength(text, 'latin1'))
        const c = tracked.credentials[i]
        expect(slice(text, s, e)).toContain(c.password)
      })
      for (const [s, e] of pairs(tracked.kept)) expect(e).toBeGreaterThan(s)
      const ar = tracked.androidRepeats
      for (let i = 0; i < ar.length; i += 4) {
        expect(ar[i + 2]).toBeLessThan(ar[i])
        expect(slice(text, ar[i], ar[i + 1])).toContain('frank@mail.test:Secret1')
        expect(slice(text, ar[i + 2], ar[i + 3])).toContain('frank@mail.test:Secret1')
      }
    }
  })
})
