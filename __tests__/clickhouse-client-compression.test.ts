import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam is what the app hands the ClickHouse client library. The library is the boundary, so it is the one thing faked here.
const h = vi.hoisted(() => ({
  createClient: vi.fn((_options: { compression?: { request?: boolean; response?: boolean } }) => ({ fake: true })),
}))
vi.mock('@clickhouse/client', () => ({ createClient: h.createClient }))

const globals = globalThis as unknown as { clickhouse?: unknown }

async function compressionOptions() {
  const { getClient } = await import('@/lib/clickhouse')
  getClient()
  return h.createClient.mock.calls[0][0].compression
}

beforeEach(() => {
  vi.resetModules()
  h.createClient.mockClear()
  globals.clickhouse = undefined // the module keeps one client per process
  vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test:8123')
  vi.stubEnv('CLICKHOUSE_USER', 'default')
  vi.stubEnv('CLICKHOUSE_PASSWORD', '')
  vi.stubEnv('CLICKHOUSE_DATABASE', 'ulp')
})

afterEach(() => {
  vi.unstubAllEnvs()
  globals.clickhouse = undefined
})

describe('ClickHouse client: INSERT body compression', () => {
  it('leaves INSERT bodies uncompressed by default (loopback: gzip only costs CPU) and still takes compressed responses', async () => {
    vi.stubEnv('CLICKHOUSE_COMPRESS_REQUESTS', undefined)
    expect(await compressionOptions()).toEqual({ request: false, response: true })
  })

  it.each(['1', 'true', 'TRUE', ' on ', 'yes'])('CLICKHOUSE_COMPRESS_REQUESTS=%j turns it back on', async raw => {
    vi.stubEnv('CLICKHOUSE_COMPRESS_REQUESTS', raw)
    expect(await compressionOptions()).toEqual({ request: true, response: true })
  })

  it.each(['', '0', 'false', 'off', 'no', 'gzip'])('CLICKHOUSE_COMPRESS_REQUESTS=%j leaves it off', async raw => {
    vi.stubEnv('CLICKHOUSE_COMPRESS_REQUESTS', raw)
    expect(await compressionOptions()).toEqual({ request: false, response: true })
  })
})
