import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
  gate: vi.fn(),
}))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: h.gate }))

const parser = vi.hoisted(() => ({ batches: [] as any[] }))
vi.mock('@/lib/ulp-parser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
  return {
    ...actual,
    parseULPStream: async function* () {
      for (const b of parser.batches) yield b
    },
  }
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
const emptyBreakdown = () => ({ blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 })
const batchOf = (n: number, tag: string) => ({
  credentials: Array.from({ length: n }, (_, i) => ({
    url: '', email: `u${i}@${tag}.com`, password: `${tag}${i}`, domain: `${tag}.com`, source_file: 'g.txt',
  })),
  rejected: 0,
  breakdown: emptyBreakdown(),
})
const webStream = () => Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>

beforeEach(() => {
  parser.batches = []
  h.insert.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.gate.mockReset()
  h.gate.mockResolvedValue(undefined)
})

describe('streamCredentialsToTable — ingest disk gate', () => {
  it('asks the gate before every batch, with the import signal and its heartbeat', async () => {
    parser.batches = [batchOf(2, 'a'), batchOf(3, 'b')]
    const controller = new AbortController()
    const beat = vi.fn()
    const { streamCredentialsToTable } = await import('@/lib/upload-processor')

    const res = await streamCredentialsToTable(webStream(), 'g.txt', {
      table: 'ulp.bench_x', pipeline: false, signal: controller.signal, onBeat: beat,
    })

    expect(res.imported).toBe(5)
    expect(h.gate).toHaveBeenCalledTimes(2)
    expect(h.gate.mock.calls[0][0]).toBe(controller.signal)
    expect(h.gate.mock.calls[0][1]).toEqual({ onPoll: beat })
  })

  it('inserts nothing while the gate is paused, and carries on when it opens', async () => {
    parser.batches = [batchOf(2, 'a')]
    let open!: () => void
    h.gate.mockImplementationOnce(() => new Promise<void>(resolve => { open = resolve }))
    const { streamCredentialsToTable } = await import('@/lib/upload-processor')

    const done = streamCredentialsToTable(webStream(), 'g.txt', { table: 'ulp.bench_x', pipeline: false })
    await tick()
    await tick()
    expect(h.insert).not.toHaveBeenCalled()

    open()
    const res = await done
    expect(h.insert).toHaveBeenCalledTimes(1)
    expect(res.imported).toBe(2)
  })

  it('stops the file, without inserting, when the wait is aborted', async () => {
    parser.batches = [batchOf(2, 'a'), batchOf(2, 'b')]
    h.gate.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const { streamCredentialsToTable } = await import('@/lib/upload-processor')

    await expect(
      streamCredentialsToTable(webStream(), 'g.txt', { table: 'ulp.bench_x', pipeline: false }),
    ).rejects.toThrow('aborted')
    expect(h.insert).not.toHaveBeenCalled()
  })
})
