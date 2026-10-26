import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

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
let answer: (sql: string, params: Record<string, unknown>) => unknown[] | Error = () => []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    const out = answer(sql, params)
    if (out instanceof Error) throw out
    return out
  }),
}))

import { NextRequest } from 'next/server'
import { validateRequest } from '@/lib/auth'
import { addRateLimitHeaders, logApiRequest, withApiKeyAuth } from '@/lib/api-key-auth'
import { POST as uiCounts } from '@/app/api/lookup/counts/route'
import { POST as v1Counts } from '@/app/api/v1/lookup/counts/route'
import { SITE_COUNTS_MAX_PER_REQUEST } from '@/lib/site-counts-input'

const isReadiness = (sql: string) => sql.includes('system.projection_parts')
const countingCalls = () => calls.filter(c => !isReadiness(c.sql))

const subRow = (host: string, host_count: number, sub: Array<[string, number]> = []) => ({
  host,
  host_count: String(host_count),
  subdomain_count: String(sub.reduce((n, [, c]) => n + c, 0)),
  subdomains: String(sub.length),
  top_names: sub.map(([d]) => d),
  top_counts: sub.map(([, c]) => String(c)),
})

const post = (handler: (request: NextRequest) => Promise<Response>, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

const ROUTES = [
  ['POST /api/lookup/counts', uiCounts, '/api/lookup/counts'],
  ['POST /api/v1/lookup/counts', v1Counts, '/api/v1/lookup/counts'],
] as const

beforeEach(() => {
  calls.length = 0
  answer = sql => (isReadiness(sql) ? [{ parts: 15, with_projection: 15 }] : [])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe.each(ROUTES)('%s', (_name, handler, url) => {
  test('counts each pasted site and answers keyed by what was pasted, with the site and its subdomains told apart', async () => {
    answer = sql => (isReadiness(sql)
      ? [{ parts: 15, with_projection: 15 }]
      : [subRow('corp.example.tld', 30, [['login.corp.example.tld', 100], ['app.corp.example.tld', 15]])])
    const res = await post(handler, url, { domains: ['https://www.Corp.example.tld/login', 'quiet.example.tld'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      queried: 2,
      found: 1,
      subdomains_counted: true,
      results: {
        'https://www.Corp.example.tld/login': {
          host: 'corp.example.tld', found: true, count: 145, host_count: 30, subdomain_count: 115, subdomains: 2,
          top_subdomains: [{ domain: 'login.corp.example.tld', count: 100 }, { domain: 'app.corp.example.tld', count: 15 }],
          searched_as: 'corp.example.tld',
        },
        'quiet.example.tld': {
          host: 'quiet.example.tld', found: false, count: 0, host_count: 0, subdomain_count: 0, subdomains: 0, top_subdomains: [],
        },
      },
    })
  })

  test('an imported window reaches the query and is echoed back', async () => {
    const res = await post(handler, url, { domains: ['corp.example.tld'], imported_after: '2026-10-01', imported_before: '2026-10-20' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(countingCalls()[0].sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    // a bare date includes its whole UTC day, so the exclusive lower bound is the second before midnight
    expect(countingCalls()[0].params).toMatchObject({ impAfter: Date.UTC(2026, 9, 1) / 1000 - 1 })
    expect(json).toMatchObject({ imported_after: expect.any(String), imported_before: expect.any(String) })
  })

  test('no window means no window fields in the answer', async () => {
    const json = await (await post(handler, url, { domains: ['corp.example.tld'] })).json()
    expect(json).not.toHaveProperty('imported_after')
    expect(json).not.toHaveProperty('imported_before')
  })

  test('says so when only the hosts could be counted', async () => {
    answer = sql => (isReadiness(sql) ? [{ parts: 15, with_projection: 12 }] : [{ d: 'corp.example.tld', n: '9' }])
    const json = await (await post(handler, url, { domains: ['corp.example.tld'] })).json()
    expect(json.subdomains_counted).toBe(false)
    expect(json.results['corp.example.tld']).toMatchObject({ count: 9, subdomain_count: null, subdomains: null })
  })

  test('text that is not a site is answered with the reason and does not stop the others', async () => {
    const json = await (await post(handler, url, { domains: ['localhost', 'corp.example.tld'] })).json()
    expect(json.results.localhost).toMatchObject({ found: false, count: null, error: 'not a site address' })
    expect(json.results['corp.example.tld']).toMatchObject({ count: 0 })
    expect(json.found).toBe(0)
  })

  test('a site too broad for the time allowed is its own error in a 200, with the others counted', async () => {
    answer = (sql, params) => {
      if (isReadiness(sql)) return [{ parts: 15, with_projection: 15 }]
      if (Object.keys(params).filter(k => k.startsWith('site')).length > 1) return new Error('Code: 159. TIMEOUT_EXCEEDED')
      return params.site0 === 'huge.example.tld' ? new Error('Code: 159. TIMEOUT_EXCEEDED') : [subRow(String(params.site0), 3)]
    }
    const res = await post(handler, url, { domains: ['huge.example.tld', 'small.example.tld'] })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.results['huge.example.tld']).toMatchObject({ found: false, count: null, error: 'too broad to count in the time allowed' })
    expect(json.results['small.example.tld']).toMatchObject({ found: true, count: 3 })
  })

  test('rejects a request with no site with 400, a list over the limit with 422, a body that is not JSON with 400 — without querying', async () => {
    expect((await post(handler, url, {})).status).toBe(400)
    expect((await post(handler, url, { domains: [] })).status).toBe(400)
    expect((await post(handler, url, { domains: ['', '   ', 3] })).status).toBe(400)
    expect((await post(handler, url, 'not json')).status).toBe(400)
    const many = Array.from({ length: SITE_COUNTS_MAX_PER_REQUEST + 1 }, (_, i) => `s${i}.example.tld`)
    expect((await post(handler, url, { domains: many })).status).toBe(422)
    expect(calls).toHaveLength(0)
  })

  test('the largest allowed list is accepted', async () => {
    const full = Array.from({ length: SITE_COUNTS_MAX_PER_REQUEST }, (_, i) => `s${i}.example.tld`)
    const res = await post(handler, url, { domains: full })
    expect(res.status).toBe(200)
    expect((await res.json()).queried).toBe(SITE_COUNTS_MAX_PER_REQUEST)
  })

  test('a malformed window is a 400 and nothing is queried', async () => {
    const res = await post(handler, url, { domains: ['corp.example.tld'], imported_after: 'last tuesday' })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('a ClickHouse failure is a generic 500 that does not echo the error', async () => {
    answer = sql => (isReadiness(sql) ? [{ parts: 15, with_projection: 15 }] : new Error('connect ECONNREFUSED secret-host:9000'))
    const res = await post(handler, url, { domains: ['corp.example.tld'] })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret-host')
  })
})

describe('POST /api/lookup/counts (the page)', () => {
  test('needs a signed-in user', async () => {
    vi.mocked(validateRequest).mockResolvedValueOnce(null)
    const res = await post(uiCounts, '/api/lookup/counts', { domains: ['corp.example.tld'] })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })
})

describe('POST /api/v1/lookup/counts (the API)', () => {
  test('needs an API key and passes its refusal through', async () => {
    vi.mocked(withApiKeyAuth).mockResolvedValueOnce({ success: false, error: 'Invalid API key', status: 403 } as never)
    const res = await post(v1Counts, '/api/v1/lookup/counts', { domains: ['corp.example.tld'] })
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test('is logged as v1/lookup/counts and carries the rate-limit headers', async () => {
    await post(v1Counts, '/api/v1/lookup/counts', { domains: ['corp.example.tld'] })
    expect(vi.mocked(logApiRequest)).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'v1/lookup/counts')
    expect(vi.mocked(addRateLimitHeaders)).toHaveBeenCalled()
  })

  test('answers exactly what the page route answers for the same list', async () => {
    answer = sql => (isReadiness(sql) ? [{ parts: 15, with_projection: 15 }] : [subRow('corp.example.tld', 5, [['a.corp.example.tld', 2]])])
    const body = { domains: ['corp.example.tld', 'https://other.example.tld'] }
    const ui = await (await post(uiCounts, '/api/lookup/counts', body)).json()
    const v1 = await (await post(v1Counts, '/api/v1/lookup/counts', body)).json()
    expect(v1).toEqual(ui)
  })
})
