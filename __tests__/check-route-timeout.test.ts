import { vi, describe, test, expect, beforeEach } from 'vitest'

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let impl: () => Promise<unknown[]>
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return impl()
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/check/route'

let n = 0
/** Each call comes from its own IP and asks about its own address, so the in-memory limiters never interfere. */
function check(email = `person${++n}@example.com`) {
  return GET(
    new NextRequest(`http://localhost/api/check?email=${encodeURIComponent(email)}`, {
      headers: { 'x-forwarded-for': `203.0.113.${n % 250}` },
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  impl = async () => []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/check — a lookup that runs out of time is an error, never "not found"', () => {
  test('the query throws on timeout instead of returning whatever had been read by the deadline', async () => {
    await check()
    const { sql } = calls[0]
    expect(sql).toContain("timeout_overflow_mode = 'throw'")
    expect(sql).not.toContain("timeout_overflow_mode = 'break'")
    expect(sql).toContain('http_wait_end_of_query = 1')
    expect(sql).toContain('WHERE email = {email:String}')
  })

  test('a ClickHouse timeout becomes 503 with a retry hint, and says nothing about whether the address was found', async () => {
    impl = async () => {
      throw new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 30000.1 ms, maximum: 30000 ms. (TIMEOUT_EXCEEDED)')
    }
    const res = await check()
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    const json = await res.json()
    expect(json).toMatchObject({ success: false, timed_out: true })
    expect(json).not.toHaveProperty('found')
    expect(json).not.toHaveProperty('breaches')
  })

  test('any other failure is a generic 500 that does not echo the error', async () => {
    impl = async () => {
      throw new Error('connect ECONNREFUSED secret-host:8123')
    }
    const res = await check()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret-host')
  })

  test('an address with no rows is still reported as not found', async () => {
    const json = await (await check()).json()
    expect(json).toMatchObject({ success: true, found: false, breach_count: 0 })
  })

  test('rows are grouped by breach and never include a password', async () => {
    impl = async () => [
      { breach_name: 'Alpha', domain: 'a.example', imported_at: '2026-01-02 00:00:00' },
      { breach_name: 'Alpha', domain: 'b.example', imported_at: '2026-01-01 00:00:00' },
      { breach_name: '', domain: 'c.example', imported_at: '2026-01-03 00:00:00' },
    ]
    const json = await (await check()).json()
    expect(json.found).toBe(true)
    expect(json.breach_count).toBe(2)
    expect(JSON.stringify(json)).not.toMatch(/password/i)
  })
})
