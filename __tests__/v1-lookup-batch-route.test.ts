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
let rowsFor: (sql: string) => unknown[] = () => []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return rowsFor(sql)
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/lookup/batch/route'

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/v1/lookup/batch', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

/** Everything below the first `FROM (` is the inner query: the part that scans the table. */
const inner = (sql: string) => sql.slice(sql.indexOf('FROM ('))

beforeEach(() => {
  calls.length = 0
  rowsFor = () => []
})

describe('POST /api/v1/lookup/batch — filters on raw columns, normalizes only the surviving rows', () => {
  // Measured 2026-09-30 on 1.39B rows: with NORM_COLS in the same SELECT as the WHERE, `email IN (...)`
  // resolved to the normalized-email alias, so even an address with ONE row scanned ~200M rows and hit the
  // 30 s cap (every email lookup failed). Split form: ~1 s for ordinary addresses.
  test('the email lookup filters, sorts and LIMIT BYs on the stored email column', async () => {
    await post({ emails: ['Jane@Example.com', 'bob@example.org'] })
    expect(calls).toHaveLength(1)
    const { sql, params } = calls[0]
    expect(inner(sql)).toContain('WHERE email IN ({email0:String}, {email1:String})')
    expect(inner(sql)).toContain('ORDER BY email ASC, imported_at DESC')
    expect(inner(sql)).toContain('LIMIT {cap:UInt32} BY email')
    expect(params).toMatchObject({ email0: 'jane@example.com', email1: 'bob@example.org', cap: 50 })
  })

  test('the domain lookup filters, sorts and LIMIT BYs on the stored domain column', async () => {
    await post({ domains: ['Trezor.io'] })
    expect(calls).toHaveLength(1)
    const { sql, params } = calls[0]
    expect(inner(sql)).toContain('WHERE domain IN ({domain0:String})')
    expect(inner(sql)).toContain('ORDER BY domain ASC, imported_at DESC')
    expect(inner(sql)).toContain('LIMIT {cap:UInt32} BY domain')
    expect(params).toMatchObject({ domain0: 'trezor.io', cap: 50 })
  })

  test.each([
    ['emails', ['a@b.co']],
    ['domains', ['b.co']],
  ])('%s: NORM_COLS (which aliases url/email/password/domain) is only in the outer select', async (kind, values) => {
    await post({ [kind]: values })
    const { sql } = calls[0]
    const outer = sql.slice(0, sql.indexOf('FROM ('))
    for (const col of ['url', 'email', 'password', 'domain']) expect(outer).toMatch(new RegExp(`\\bAS ${col}\\b`))
    // A helper alias named like a stored column would shadow it in the inner WHERE and defeat the pruning.
    expect(inner(sql)).not.toMatch(/\bAS (url|email|password|domain)\b/i)
    expect(inner(sql)).toContain('FROM ulp.credentials')
  })

  test.each([
    ['emails', ['a@b.co'], 'email'],
    ['domains', ['b.co'], 'domain'],
  ])('%s: the final order is re-stated on the outer select (a LIMIT BY result order is not relied on)', async (kind, values, col) => {
    await post({ [kind]: values })
    const { sql } = calls[0]
    expect(sql.slice(sql.indexOf(') AS t'))).toContain(`ORDER BY t.${col} ASC, t.imported_at DESC`)
  })

  test('the 30 s cap throws (no partial rows) and waits for the whole result, so a timeout never yields garbled JSON', async () => {
    await post({ emails: ['a@b.co'] })
    expect(calls[0].sql).toContain("max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1")
  })

  test.each([
    ['emails', ['a@b.co']],
    ['domains', ['b.co']],
  ])('%s: prefers stored columns over NORM_COLS aliases in the outer select', async (kind, values) => {
    await post({ [kind]: values })
    expect(calls[0].sql).toContain('prefer_column_name_to_alias = 1')
  })

  test('emails and domains are two queries, one each', async () => {
    await post({ emails: ['a@b.co'], domains: ['b.co'] })
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain('WHERE email IN')
    expect(calls[1].sql).toContain('WHERE domain IN')
  })
})

describe('POST /api/v1/lookup/batch — response shape is unchanged', () => {
  test('rows are matched back to each requested key, case-insensitively, and misses are reported as not found', async () => {
    rowsFor = sql =>
      sql.includes('WHERE email IN')
        ? [
            { email: 'jane@example.com', url: 'https://x.example', password: 'p1', domain: 'x.example', source_file: 'a', breach_name: 'A', imported_at: '2026-01-02 00:00:00' },
            { email: 'jane@example.com', url: 'https://y.example', password: 'p2', domain: 'y.example', source_file: 'a', breach_name: 'A', imported_at: '2026-01-01 00:00:00' },
          ]
        : [{ email: 'e@trezor.io', url: 'https://trezor.io', password: 'p', domain: 'trezor.io', source_file: 'b', breach_name: 'B', imported_at: '2026-01-01 00:00:00' }]
    const res = await post({ emails: ['Jane@Example.com', 'nobody@example.com'], domains: ['TREZOR.io', 'absent.example'] })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, queried: 4, found: 2 })
    expect(json.results['Jane@Example.com']).toMatchObject({ found: true, count: 2 })
    expect(json.results['nobody@example.com']).toEqual({ found: false, count: 0, results: [] })
    expect(json.results['TREZOR.io']).toMatchObject({ found: true, count: 1 })
    expect(json.results['absent.example']).toEqual({ found: false, count: 0, results: [] })
  })

  test('rejects an empty request with 400 and an oversized one with 422, without querying', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ emails: [] })).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`)
    expect((await post({ emails: many })).status).toBe(422)
    expect(calls).toHaveLength(0)
  })

  test('a ClickHouse failure is a generic 500 that does not echo the error', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    vi.mocked(executeQuery).mockRejectedValueOnce(new Error('Code: 159. TIMEOUT_EXCEEDED secret-host:9000'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ emails: ['a@b.co'] })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret-host')
  })
})
