import { vi, describe, test, expect, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({
  withApiKeyAuth: vi.fn(),
  addRateLimitHeaders: vi.fn((response: unknown) => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api-key-auth', () => auth)

const ch = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: Record<string, unknown> }>, inFlight: 0, maxInFlight: 0, rowsFor: (_tag: string, _p: Record<string, unknown>): unknown[] | Error => [] }))
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    ch.calls.push({ sql, params })
    ch.inFlight++
    ch.maxInFlight = Math.max(ch.maxInFlight, ch.inFlight)
    await new Promise(r => setTimeout(r, 5))
    ch.inFlight--
    const out = ch.rowsFor(/assoc:(\w+)/.exec(sql)?.[1] ?? '', params)
    if (out instanceof Error) throw out
    return out
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/lookup/associate/route'

const PW = 'Sup3rSecretPw'
const OK = { success: true, apiKey: { keyId: 'k1', role: 'admin' }, rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 } }
const call = (body: unknown) => POST(new NextRequest('http://localhost/api/v1/lookup/associate', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  ch.calls.length = 0
  ch.inFlight = 0
  ch.maxInFlight = 0
  ch.rowsFor = () => []
  auth.withApiKeyAuth.mockReset().mockResolvedValue(OK)
  auth.logApiRequest.mockClear()
  auth.addRateLimitHeaders.mockClear()
})

describe('POST /api/v1/lookup/associate', () => {
  test('a missing or wrong key is refused with the status the key check gave, and nothing is queried', async () => {
    auth.withApiKeyAuth.mockResolvedValue({ success: false, error: 'Invalid or missing API key', status: 401 })
    const res = await call({ login: 'alice_w' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or missing API key' })
    expect(ch.calls).toHaveLength(0)
  })

  test('the request is logged against the key (the endpoint name only, never the body)', async () => {
    await call({ login: 'alice_w' })
    expect(auth.logApiRequest).toHaveBeenCalledWith(OK.apiKey, expect.anything(), 'v1/lookup/associate')
  })

  test.each([
    ['a body that is not JSON', '{nope'],
    ['an empty items list', { items: [] }],
    ['more logins than the limit', { items: Array.from({ length: 11 }, (_, i) => ({ login: `u${i}` })) }],
    ['an item without a login', { items: [{ login: 'ok' }, { password: 'x' }] }],
    ['a site that is a URL', { login: 'a', site: 'https://example.test/x' }],
  ])('rejects %s with 400 and queries nothing', async (_name, body) => {
    const res = await call(body)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(typeof json.error).toBe('string')
    expect(ch.calls).toHaveLength(0)
  })

  test('names the item that is wrong', async () => {
    const res = await call({ items: [{ login: 'ok' }, { login: '' }] })
    expect((await res.json()).error).toMatch(/item 2/)
  })

  test('a single login may be sent without the items wrapper', async () => {
    const res = await call({ login: 'alice_w', site: 'example-site.test' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, count: 1 })
    expect(json.results[0]).toMatchObject({ login: 'alice_w', want: 'email', anchored: false, too_common: false, candidates: [], errors: [] })
  })

  test('answers in snake_case with the candidates, their confidence and their evidence', async () => {
    ch.rowsFor = (tag, p) => {
      if (tag === 'own') return [{ domain: 'example-site.test', password: PW }]
      if (tag === 's1' && p.d === 'example-site.test') return [{ e: 'alice@mail.test', login_type: 'email' }]
      return []
    }
    const res = await call({ items: [{ login: 'alice_w', site: 'example-site.test' }] })
    const json = await res.json()
    expect(json.results[0]).toMatchObject({
      login: 'alice_w',
      anchored: true,
      login_sites: ['example-site.test'],
      candidates_total: 1,
      candidates: [{ login: 'alice@mail.test', confidence: 'high' }],
    })
    expect(json.results[0].candidates[0].evidence).toContain('same password as the username on example-site.test')
  })

  test('no password is ever in the response, even one the caller supplied', async () => {
    ch.rowsFor = (tag) => (tag === 's2' ? new Error(`Code: 159. DB::Exception: Timeout exceeded ${PW}`) : tag === 'own' ? [{ domain: 'example-site.test', password: PW }] : [])
    const res = await call({ login: 'alice_w', password: PW, site: 'example-site.test' })
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(PW)
  })

  test('a step that fails is reported inside the result, not as a failed request', async () => {
    ch.rowsFor = (tag) => (tag === 'handle' ? new Error('Code: 159. Timeout exceeded') : [])
    const res = await call({ login: 'alice_w' })
    expect(res.status).toBe(200)
    expect((await res.json()).results[0].errors).toEqual(['handle: timed out'])
  })

  test('when ClickHouse cannot be reached at all the request fails with 503', async () => {
    ch.rowsFor = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8123'), { code: 'ECONNREFUSED' })
    const res = await call({ items: [{ login: 'a1' }, { login: 'b2' }] })
    expect(res.status).toBe(503)
    expect((await res.json()).success).toBe(false)
  })

  test('logins are probed three at a time, never more', async () => {
    ch.rowsFor = () => []
    await call({ items: Array.from({ length: 9 }, (_, i) => ({ login: `user${i}` })) })
    expect(ch.maxInFlight).toBeGreaterThan(1)
    expect(ch.maxInFlight).toBeLessThanOrEqual(3)
  })

  test('the results come back in the order the logins were sent', async () => {
    const res = await call({ items: [{ login: 'first1' }, { login: 'second2' }, { login: 'third3' }] })
    expect((await res.json()).results.map((r: { login: string }) => r.login)).toEqual(['first1', 'second2', 'third3'])
  })

  test('the rate limit headers are added to a successful answer', async () => {
    await call({ login: 'alice_w' })
    expect(auth.addRateLimitHeaders).toHaveBeenCalled()
  })
})
