import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({ success: true, apiKey: { id: 'k', role: 'admin' }, rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 } }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
const calls: string[] = []
let liveRow: Record<string, unknown> | undefined
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('system.projection_parts')) return [{ parts: 15, with_projection: 15 }]
    if (sql.includes('system.mutations')) return liveRow ? [liveRow] : []
    return [{ host: 'corp.example', host_count: '10', subdomain_count: '20', subdomains: '2', top_names: ['app.corp.example'], top_counts: ['20'] }]
  }),
}))
vi.mock('@/lib/site-directory', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/site-directory')>()
  return { ...actual, recordSites: vi.fn(actual.recordSites) }
})

import { NextRequest } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { POST as uiCounts } from '@/app/api/lookup/counts/route'
import { POST as v1Counts } from '@/app/api/v1/lookup/counts/route'
import { recordSites } from '@/lib/site-directory'

const post = (handler: (r: NextRequest) => Promise<Response>, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))
const rowOf = (host: string) => dbGet('SELECT * FROM site_directory WHERE host = ?', [host]) as Record<string, any> | undefined
const fingerprintOf = (uuid: string, parts: string, mutations: string) => createHash('sha1').update(`${uuid}|${parts}|${mutations}`).digest('hex')

beforeEach(() => {
  calls.length = 0
  liveRow = { table_uuid: 'uuid-1', part_state: '202611:100:1:9', mutation_state: '', mutations_running: 0, builds_running: 0 }
  dbRun('DELETE FROM site_directory')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe.each([
  ['POST /api/lookup/counts', uiCounts, '/api/lookup/counts'],
  ['POST /api/v1/lookup/counts', v1Counts, '/api/v1/lookup/counts'],
] as const)('%s feeds the directory', (_name, handler, url) => {
  test('the counted site is in the directory with its numbers and the fingerprint read before the counting', async () => {
    const res = await post(handler, url, { domains: ['https://www.Corp.example/login', 'corp.example'] })
    expect(res.status).toBe(200)
    expect(rowOf('corp.example')).toMatchObject({
      times_counted: 1, row_count: 30, host_count: 10, subdomain_count: 20, subdomains: 2,
      counted_fp: fingerprintOf('uuid-1', '202611:100:1:9', ''),
    })
    // the table was read first, then counted
    const order = calls.filter(sql => !sql.includes('system.projection_parts')).map(sql => (sql.includes('system.mutations') ? 'live' : 'count'))
    expect(order).toEqual(['live', 'count'])
  })

  test('a count with an imported window adds the site and writes no numbers', async () => {
    await post(handler, url, { domains: ['corp.example'], imported_after: '2026-10-01' })
    expect(rowOf('corp.example')).toMatchObject({ times_counted: 1, row_count: null, counted_fp: null })
  })

  test('when the table cannot be read the numbers are still stored, without a fingerprint', async () => {
    liveRow = undefined
    await post(handler, url, { domains: ['corp.example'] })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: null })
  })

  test('a failure to record is logged and the count is answered as before', async () => {
    vi.mocked(recordSites).mockImplementationOnce(() => { throw new Error('database is locked') })
    const res = await post(handler, url, { domains: ['corp.example'] })
    expect(res.status).toBe(200)
    expect((await res.json()).results['corp.example']).toMatchObject({ count: 30 })
    expect(console.error).toHaveBeenCalledWith('site directory record error:', expect.any(Error))
  })

  test('a request that is refused records nothing', async () => {
    await post(handler, url, { domains: [] })
    expect(rowOf('corp.example')).toBeUndefined()
  })
})
