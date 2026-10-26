import { vi, describe, test, expect, beforeEach } from 'vitest'

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
let rowsFor: (sql: string, params: Record<string, unknown>) => unknown[] = () => []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return rowsFor(sql, params)
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/lookup/route'

/** A row as this route selects it: url, email, domain, source_file, imported_at. */
const row = (domain: string, imported_at = '2026-03-01 00:00:00') => ({
  url: `https://${domain}/login`, email: 'a@x.tld', domain, source_file: 'f', imported_at,
})

async function ask(query: Record<string, string>) {
  const res = await GET(new NextRequest(`http://localhost/api/v1/lookup?${new URLSearchParams(query)}`))
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  calls.length = 0
  rowsFor = () => []
})

describe('GET /api/v1/lookup?domain= — what is pasted is cleaned to what is stored', () => {
  test('a bare host is looked up as it is and answered in the shape it always had', async () => {
    rowsFor = () => [row('example.tld')]
    const { status, json } = await ask({ domain: 'example.tld' })
    expect(status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('WHERE domain IN ({domain0:String})\n')
    expect(calls[0].params).toEqual({ domain0: 'example.tld' })
    expect(json).toEqual({ success: true, found: true, domain: 'example.tld', count: 1, results: [row('example.tld')] })
    expect(Object.keys(json)).toEqual(['success', 'found', 'domain', 'count', 'results'])
  })

  test('upper case and padding are not a different host: the echo is lower-cased and trimmed as before, with no searched_as', async () => {
    const { json } = await ask({ domain: '  Example.TLD  ' })
    expect(calls[0].params).toEqual({ domain0: 'example.tld' })
    expect(json).toEqual({ success: true, found: false, domain: 'example.tld', count: 0, results: [] })
  })

  test('a URL is looked up as its host, with the www. form beside it; the answer echoes what was sent and says what was searched', async () => {
    rowsFor = () => [row('example.tld')]
    const sent = 'https://www.Example.tld/login?next=/a/b'
    const { json } = await ask({ domain: sent })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('WHERE domain IN ({domain0:String}, {domain1:String})\n')
    expect(calls[0].params).toEqual({ domain0: 'example.tld', domain1: 'www.example.tld' })
    expect(json).toMatchObject({ success: true, found: true, domain: sent.toLowerCase(), searched_as: 'example.tld', count: 1 })
  })

  test('a www. host is looked up with and without the www. (a few thousand rows keep one): both come back, as the query returns them', async () => {
    const stored = [row('www.example.tld', '2026-03-02 00:00:00'), row('example.tld', '2026-03-01 00:00:00')]
    rowsFor = () => stored
    const { json } = await ask({ domain: 'www.example.tld' })
    expect(calls[0].params).toEqual({ domain0: 'example.tld', domain1: 'www.example.tld' })
    expect(json).toMatchObject({ found: true, count: 2, searched_as: 'example.tld' })
    expect(json.results).toEqual(stored)
  })

  test('host:port is looked up as the host and as typed, so a domain stored with its port is still found', async () => {
    rowsFor = () => [row('example.tld:8443')]
    const { json } = await ask({ domain: 'Example.tld:8443' })
    expect(calls[0].params).toEqual({ domain0: 'example.tld', domain1: 'example.tld:8443' })
    expect(json).toMatchObject({ found: true, count: 1, domain: 'example.tld:8443', searched_as: 'example.tld' })
  })

  test('a value copied out of a list (quotes, a trailing comma) is looked up as the host in it', async () => {
    const { json } = await ask({ domain: '"Example.tld",' })
    expect(calls[0].params).toMatchObject({ domain0: 'example.tld' })
    expect(json).toMatchObject({ domain: '"example.tld",', searched_as: 'example.tld' })
  })

  test('text with no host in it (a bare scheme) runs no query and is reported not found, as in the batch lookups', async () => {
    const { status, json } = await ask({ domain: 'https://' })
    expect(status).toBe(200)
    expect(calls).toHaveLength(0)
    expect(json).toEqual({ success: true, found: false, domain: 'https://', count: 0, results: [] })
  })

  test('up to 100 rows come back in the order the query gave them: the batch lookups\' cap of 50 per entry does not apply here', async () => {
    const stored = Array.from({ length: 100 }, (_, i) => row(i % 2 ? 'www.example.tld' : 'example.tld', `2026-03-01 00:${String(59 - (i % 60)).padStart(2, '0')}:00`))
    rowsFor = () => stored
    const { json } = await ask({ domain: 'www.example.tld' })
    expect(json.count).toBe(100)
    expect(json.results).toEqual(stored)
  })

  test('the query keeps its order, its LIMIT and its settings (the result cache, the 30 s cap); the projection setting is the e-mail lookup\'s only', async () => {
    await ask({ domain: 'https://www.example.tld/' })
    const { sql } = calls[0]
    expect(sql).toContain('ORDER BY imported_at DESC LIMIT 100')
    expect(sql).toContain('max_execution_time = 30')
    expect(sql).toContain('use_query_cache = 1')
    expect(sql).not.toContain('optimize_use_projections')
  })

  test('a blank domain is still a 400 and nothing is asked', async () => {
    const { status, json } = await ask({ domain: '   ' })
    expect(status).toBe(400)
    expect(json.error).toBe('Provide email or domain parameter')
    expect(calls).toHaveLength(0)
  })

  test('the e-mail lookup does not depend on the domain parameter: a domain with no host does not stop it', async () => {
    rowsFor = () => [{ url: 'https://example.tld/', email: 'A@x.tld', domain: 'example.tld', source_file: 'f', imported_at: '2026-03-01 00:00:00' }]
    const { json } = await ask({ email: 'A@X.tld', domain: 'https://' })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('lower(email) = lower({email:String})')
    expect(calls[0].params).toMatchObject({ email: 'a@x.tld' })
    expect(json).toMatchObject({ success: true, found: true, email: 'a@x.tld', count: 1 })
  })
})
