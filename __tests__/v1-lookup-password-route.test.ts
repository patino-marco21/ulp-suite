import { vi, describe, test, expect, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({
  withApiKeyAuth: vi.fn(),
  addRateLimitHeaders: vi.fn((response: unknown) => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api-key-auth', () => auth)

const ch = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: Record<string, unknown> }>, rows: [] as unknown[], fail: null as Error | null }))
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    ch.calls.push({ sql, params })
    if (ch.fail) throw ch.fail
    return ch.rows
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/lookup/password/route'

const PW = 'Sup3rSecretPw'
const OK = { success: true, apiKey: { keyId: 'k1', role: 'admin' }, rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 } }
const call = (body: unknown) => POST(new NextRequest('http://localhost/api/v1/lookup/password', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  ch.calls.length = 0
  ch.rows = []
  ch.fail = null
  auth.withApiKeyAuth.mockReset().mockResolvedValue(OK)
  auth.logApiRequest.mockClear()
})

describe('POST /api/v1/lookup/password', () => {
  test('a missing or wrong key is refused and nothing is queried', async () => {
    auth.withApiKeyAuth.mockResolvedValue({ success: false, error: 'Rate limit exceeded', status: 429 })
    const res = await call({ password: PW })
    expect(res.status).toBe(429)
    expect(ch.calls).toHaveLength(0)
  })

  test.each([
    ['a body that is not JSON', '{nope'],
    ['no password', {}],
    ['an unknown type', { password: PW, type: 'fax' }],
    ['a limit above the maximum', { password: PW, limit: 5000 }],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await call(body)
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(ch.calls).toHaveLength(0)
  })

  test('the password travels as a query parameter and the endpoint is logged without it', async () => {
    await call({ password: PW, type: 'email', domain: 'example-site.test' })
    expect(ch.calls).toHaveLength(1)
    expect(ch.calls[0].params).toMatchObject({ p: PW, t: 'email', d: 'example-site.test' })
    expect(ch.calls[0].sql).not.toContain(PW)
    expect(auth.logApiRequest).toHaveBeenCalledWith(OK.apiKey, expect.anything(), 'v1/lookup/password')
  })

  test('answers in snake_case and never echoes the password', async () => {
    ch.rows = [
      { login: 'alice@mail.test', login_type: 'email', sites: '3', domains: ['a.test', 'b.test', 'c.test'], rows: '4', scanned: '2' },
      { login: 'bob@mail.test', login_type: 'email', sites: '1', domains: ['a.test'], rows: '1', scanned: '2' },
    ]
    const res = await call({ password: PW })
    const json = await res.json()
    expect(json).toEqual({
      success: true,
      count: 2,
      has_more: false,
      partial: false,
      results: [
        { login: 'alice@mail.test', login_type: 'email', sites: 3, domains: ['a.test', 'b.test', 'c.test'], rows: 4 },
        { login: 'bob@mail.test', login_type: 'email', sites: 1, domains: ['a.test'], rows: 1 },
      ],
    })
    expect(JSON.stringify(json)).not.toContain(PW)
  })

  test('says so when there is more than was asked for, or the scan was cut short', async () => {
    ch.rows = Array.from({ length: 3 }, (_, i) => ({ login: `u${i}@m.test`, login_type: 'email', sites: '1', domains: [], rows: '1', scanned: '100000' }))
    const json = await (await call({ password: PW, limit: 2 })).json()
    expect(json).toMatchObject({ count: 2, has_more: true, partial: true })
  })

  test('a timeout is a 408 that says how to narrow the question, without the query text', async () => {
    ch.fail = new Error(`Code: 159. DB::Exception: Timeout exceeded while reading ${PW}`)
    const res = await call({ password: PW })
    expect(res.status).toBe(408)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('domain')
    expect(text).not.toContain(PW)
  })

  test('any other failure is a plain 500 that leaks nothing', async () => {
    ch.fail = new Error(`boom ${PW}`)
    const res = await call({ password: PW })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain(PW)
  })
  describe('imported_after / imported_before', () => {
    test.each([
      ['imported_after', 'yesterday'],
      ['imported_before', '2026-02-30'],
      ['imported_after', 12345],
    ])('%s=%j is a 400 that names the parameter, and nothing is queried', async (field, value) => {
      const res = await call({ password: PW, [field]: value })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain(`${field} must be`)
      expect(ch.calls).toHaveLength(0)
    })

    test('the window reaches the query as parameters (the text carries no value) and is echoed as the effective instants', async () => {
      ch.rows = [{ login: 'alice@mail.test', login_type: 'email', sites: '1', domains: ['a.test'], rows: '1', scanned: '1' }]
      const res = await call({ password: PW, imported_after: '2026-10-05T09:37:00-05:00', imported_before: '2026-10-06' })
      const json = await res.json()
      expect(res.status).toBe(200)
      expect(ch.calls[0].sql).toContain('imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})')
      expect(ch.calls[0].params).toMatchObject({ impAfter: Date.UTC(2026, 9, 5, 14, 37) / 1000, impBefore: Date.UTC(2026, 9, 6) / 1000 + 86_399 })
      expect(json.imported_after).toBe('2026-10-05T14:37:00Z')
      expect(json.imported_before).toBe('2026-10-06T23:59:59Z')
    })

    test('without a window the answer has exactly the keys it always had', async () => {
      const json = await (await call({ password: PW })).json()
      expect(Object.keys(json).sort()).toEqual(['count', 'has_more', 'partial', 'results', 'success'])
      expect(ch.calls[0].sql).not.toContain('imported_at')
    })
  })
})
