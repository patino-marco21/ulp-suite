import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type StreamCall = { query: string; query_params: Record<string, unknown>; abort_signal?: AbortSignal }
const streamCalls: StreamCall[] = []
let tableRows: Array<Record<string, unknown>> = []
let failQuery: Error | null = null

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async () => []),
  getClient: () => ({
    query: async (opts: StreamCall) => {
      streamCalls.push({ query: opts.query, query_params: opts.query_params ?? {}, abort_signal: opts.abort_signal })
      if (failQuery) throw failQuery
      return { stream: () => (async function* () { yield tableRows.map(r => ({ json: () => r })) })() }
    },
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/export/route'

const request = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/export', { method: 'POST', body: JSON.stringify(body) })
const post = (body: Record<string, unknown>) => POST(request(body))
const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`, source_file: 'f.txt',
  breach_name: '', country_tier: '', login_type: 'email', password_length: 4, password_mask: 'alphanumeric', url_scheme: 'https',
  is_corporate_email: 0, email_domain: 'mail.test', url_host: `s${n}.example`, password_entropy_band: 'weak', imported_at: '2026-10-13 01:00:00',
})

beforeEach(() => {
  streamCalls.length = 0
  tableRows = [row(1), row(2)]
  failQuery = null
})

describe('POST /api/export — the streamed formats', () => {
  test('csv: the header and the rows, the cap header, and no row count or truncation flag', async () => {
    const res = await post({ format: 'csv' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('X-Export-Cap')).toBe('1000000')
    expect(res.headers.get('X-Export-Rows')).toBeNull()
    expect(res.headers.get('X-Export-Truncated')).toBeNull()
    const lines = (await res.text()).split('\n')
    expect(lines).toHaveLength(4) // header + 2 rows + the empty piece after the last newline
    expect(lines[0].startsWith('url,email,password')).toBe(true)
  })

  test('ndjson, ulp and userpass have their own content types and file extensions', async () => {
    const nd = await post({ format: 'ndjson' })
    expect(nd.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8')
    expect(nd.headers.get('Content-Disposition')).toContain('.ndjson"')
    expect((await nd.text()).split('\n').filter(Boolean).map(l => JSON.parse(l).email)).toEqual(['u1@mail.test', 'u2@mail.test'])
    for (const format of ['ulp', 'userpass']) {
      const res = await post({ format })
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('Content-Disposition')).toContain('.txt"')
      await res.text()
    }
  })

  test('an unknown format has always been a ulp file', async () => {
    const res = await post({ format: 'whatever' })
    expect(await res.text()).toBe('https://s1.example/login:u1@mail.test:pw1\nhttps://s2.example/login:u2@mail.test:pw2\n')
  })

  test('the query asks for the streaming cap, runs with the longer limit and the external sort, and gets the abort signal', async () => {
    const req = request({ format: 'csv' })
    await POST(req)
    const call = streamCalls[0]
    expect(call.query).toContain('LIMIT 1000000')
    expect(call.query).toContain('max_execution_time = 600')
    expect(call.query).toContain('max_bytes_before_external_sort')
    expect(call.abort_signal).toBeInstanceOf(AbortSignal)
  })

  test('the search scope reaches the streamed SQL', async () => {
    await post({ format: 'csv', query: 'Maria', scope: 'login' })
    expect(streamCalls[0].query).toContain('hasToken(email, {lw0:String})')
    expect(streamCalls[0].query_params.lw0).toBe('maria')
  })

  test('a query that fails is a clean 500, not a broken file', async () => {
    failQuery = new Error('MEMORY_LIMIT_EXCEEDED')
    const res = await post({ format: 'csv' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Export failed' })
  })
})

describe('POST /api/export — json keeps the in-memory path', () => {
  test('it does not stream: no cap header, its own row count and truncation headers, and no ClickHouse stream call', async () => {
    const res = await post({ format: 'json' })
    expect(res.headers.get('X-Export-Cap')).toBeNull()
    expect(res.headers.get('X-Export-Rows')).toBe('0')
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(streamCalls).toHaveLength(0)
  })
})
