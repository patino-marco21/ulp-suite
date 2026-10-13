import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { id: 'test-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let rows: unknown[] = []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return rows
  }),
}))

import { NextRequest } from 'next/server'
import { POST as uiBatch } from '@/app/api/lookup/batch/route'
import { POST as v1Batch } from '@/app/api/v1/lookup/batch/route'

const post = (handler: typeof uiBatch, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))

const stored = (email: string, imported_at: string) => ({
  email, url: 'https://x.example.test/', password: 'pw', domain: 'x.example.test', source_file: 'f', breach_name: 'B', imported_at,
})

beforeEach(() => {
  calls.length = 0
  rows = []
})

describe.each([
  ['POST /api/lookup/batch', uiBatch, '/api/lookup/batch'],
  ['POST /api/v1/lookup/batch', v1Batch, '/api/v1/lookup/batch'],
] as const)('%s — an address matches every stored casing', (_name, handler, url) => {
  test('the query compares lower(email) on both sides, orders and caps per address ignoring case', async () => {
    await post(handler, url, { emails: ['Jane@Example.com', 'bob@example.org'] })
    const { sql, params } = calls[0]
    expect(sql).toContain('lower(email) IN (lower({email0:String}), lower({email1:String}))')
    expect(sql).toContain('ORDER BY lower(email) ASC, imported_at DESC')
    expect(sql).toContain('LIMIT {cap:UInt32} BY lower(email)')
    expect(sql).not.toMatch(/\bemail IN \(/)
    expect(sql).toContain('optimize_use_projections = 0')
    expect(params).toMatchObject({ email0: 'jane@example.com', email1: 'bob@example.org', cap: 50 })
  })

  test('rows stored in different casings are all returned under the address that was asked for', async () => {
    rows = [
      stored('Jane@Example.com', '2026-03-01 00:00:00'),
      stored('jane@example.com', '2026-02-01 00:00:00'),
      stored('JANE@EXAMPLE.COM', '2026-01-01 00:00:00'),
      stored('bob@example.org', '2026-01-01 00:00:00'),
    ]
    const json = await (await post(handler, url, { emails: ['jAnE@example.com', 'nobody@example.com'] })).json()
    expect(json.results['jAnE@example.com'].count).toBe(3)
    expect(json.results['jAnE@example.com'].results.map((r: { email: string }) => r.email)).toEqual([
      'Jane@Example.com', 'jane@example.com', 'JANE@EXAMPLE.COM',
    ])
    expect(json.results['nobody@example.com']).toEqual({ found: false, count: 0, results: [] })
    expect(json.found).toBe(1)
  })
})
