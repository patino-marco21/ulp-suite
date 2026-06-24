import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
}))
vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({ insert: h.insert, query: h.query }),
}))

// Controllable parser: yields the prebuilt batches and records each pull index.
const parser = vi.hoisted(() => ({ pulls: [] as number[], batches: [] as any[] }))
vi.mock('@/lib/ulp-parser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
  return {
    ...actual,
    parseULPStream: async function* () {
      for (let i = 0; i < parser.batches.length; i++) {
        parser.pulls.push(i)
        yield parser.batches[i]
      }
    },
  }
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
const emptyBreakdown = () => ({ blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 })
const oneCred = (pw: string) => ({
  credentials: [{ url: '', email: `u@${pw}.com`, password: pw, domain: `${pw}.com`, source_file: 'b.txt' }],
  rejected: 0,
  breakdown: emptyBreakdown(),
})
const webStream = () => Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>

beforeEach(() => {
  parser.pulls = []
  parser.batches = []
  h.insert.mockReset()
})

describe('streamCredentialsToTable pipelining', () => {
  it('parses the next batch while the current insert is in flight (pipeline on)', async () => {
    parser.batches = [oneCred('a'), oneCred('b')]
    let gateOpen = false
    const waiters: Array<() => void> = []
    h.insert.mockImplementation(() =>
      gateOpen ? Promise.resolve() : new Promise<void>(res => waiters.push(res)))

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    const done = streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true })

    await tick()
    expect(h.insert).toHaveBeenCalledTimes(1)   // inserting batch a
    expect(parser.pulls).toContain(1)           // batch b parsed DURING insert a

    gateOpen = true
    waiters.forEach(r => r())
    await done
  })

  it('does not prefetch the next batch when pipeline is off', async () => {
    parser.batches = [oneCred('a'), oneCred('b')]
    let gateOpen = false
    const waiters: Array<() => void> = []
    h.insert.mockImplementation(() =>
      gateOpen ? Promise.resolve() : new Promise<void>(res => waiters.push(res)))

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    const done = streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: false })

    await tick()
    expect(h.insert).toHaveBeenCalledTimes(1)
    expect(parser.pulls).not.toContain(1)       // batch b NOT parsed until insert a resolves

    gateOpen = true
    waiters.forEach(r => r())
    await done
    expect(parser.pulls).toContain(1)
  })

  it('inserts batches in order and sums the imported count', async () => {
    parser.batches = [oneCred('a'), oneCred('b'), oneCred('c')]
    const seen: string[] = []
    h.insert.mockImplementation(async (opts: any) => {
      const chunks: Buffer[] = []
      for await (const ch of opts.values as Readable)
        chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(String(ch)))
      seen.push(Buffer.concat(chunks).toString('utf8'))
    })

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    const res = await streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true })

    expect(res.imported).toBe(3)
    expect(seen).toHaveLength(3)
    expect(seen[0]).toContain('"a"')
    expect(seen[1]).toContain('"b"')
    expect(seen[2]).toContain('"c"')
  })

  it('aborts the file and stops the parser when an insert fails', async () => {
    parser.batches = [oneCred('a'), oneCred('b'), oneCred('c')]
    h.insert.mockRejectedValue(Object.assign(new Error('refused'), { code: '62' })) // non-transient

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    await expect(
      streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true })
    ).rejects.toThrow('refused')

    expect(parser.pulls).not.toContain(2)       // batch c never parsed — parser stopped
  })

  it('accumulates parse/insert timings when a timings accumulator is provided', async () => {
    parser.batches = [oneCred('a')]
    h.insert.mockResolvedValue(undefined)
    const timings = { parseMs: 0, insertMs: 0 }

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    await streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true, timings })

    expect(timings.parseMs).toBeGreaterThanOrEqual(0)
    expect(timings.insertMs).toBeGreaterThanOrEqual(0)
    expect(timings.parseMs + timings.insertMs).toBeGreaterThan(0)
  })
})
