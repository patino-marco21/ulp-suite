import { readFileSync } from 'fs'
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Handler = (sql: string) => Promise<unknown[]>
let handler: Handler
const sqls: string[] = []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string) => {
    sqls.push(sql)
    return handler(sql)
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/related/route'
import { RELATED_BY_EMAIL_SQL, RELATED_BY_DOMAIN_SQL, RELATED_BY_PASSWORD_SQL } from '@/lib/related-queries'

const TIMEOUT = new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 30000.2 ms, maximum: 30000 ms. (TIMEOUT_EXCEEDED)')
const row = (email: string) => ({ email, url: 'https://x.example', password: 'pw', domain: 'x.example', imported_at: '2026-01-01 00:00:00' })

const related = (qs: string) => GET(new NextRequest(`http://localhost/api/related?${qs}`))

beforeEach(() => {
  sqls.length = 0
  handler = async () => []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/related — a bucket that cannot be computed is reported, not shown as "none found"', () => {
  test('the queries throw on timeout (a break-mode timeout hands back an empty or partial bucket as if it were complete)', () => {
    for (const sql of [RELATED_BY_EMAIL_SQL, RELATED_BY_DOMAIN_SQL, RELATED_BY_PASSWORD_SQL]) {
      expect(sql).toContain("timeout_overflow_mode = 'throw'")
      expect(sql).not.toContain("timeout_overflow_mode = 'break'")
      expect(sql).toContain('http_wait_end_of_query = 1')
    }
  })

  test('all buckets answer: nothing is marked failed', async () => {
    handler = async sql => [row(sql === RELATED_BY_EMAIL_SQL ? 'a@x.example' : 'b@x.example')]
    const json = await (await related('email=a@x.example&domain=x.example&password=hunter22')).json()
    expect(json).toMatchObject({ success: true, failed: [], timed_out: false })
    expect(json.by_email).toHaveLength(1)
    expect(json.by_domain).toHaveLength(1)
    expect(json.by_password).toHaveLength(1)
  })

  test('one bucket times out: the others still arrive and the slow one is named', async () => {
    handler = async sql => {
      if (sql === RELATED_BY_PASSWORD_SQL) throw TIMEOUT
      return [row('a@x.example')]
    }
    const res = await related('email=a@x.example&domain=x.example&password=hunter22')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, failed: ['by_password'], timed_out: true })
    expect(json.by_email).toHaveLength(1)
    expect(json.by_domain).toHaveLength(1)
    expect(json.by_password).toEqual([])
  })

  test('every requested bucket times out: the request is a 504 that says so', async () => {
    handler = async () => {
      throw TIMEOUT
    }
    const res = await related('email=a@x.example&domain=x.example&password=hunter22')
    expect(res.status).toBe(504)
    expect(await res.json()).toMatchObject({ success: false, timed_out: true, failed: ['by_email', 'by_domain', 'by_password'] })
  })

  test('a bucket that was never asked for is neither queried nor counted as failed', async () => {
    handler = async sql => {
      if (sql === RELATED_BY_EMAIL_SQL) throw TIMEOUT
      return []
    }
    // Only an email is given, so by_email is the single requested bucket (domain and password are
    // never queried); it failed, so the whole request fails.
    const res = await related('email=a@x.example')
    expect(res.status).toBe(504)
    expect(sqls).toEqual([RELATED_BY_EMAIL_SQL])
    // Only a domain is given: by_domain is the single requested bucket and it answered (with no rows).
    const ok = await related('domain=x.example')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ success: true, failed: [] })
  })

  test('a non-timeout failure is a generic 500 that does not echo the error, and is logged', async () => {
    handler = async () => {
      throw new Error('connect ECONNREFUSED secret-host:8123')
    }
    const res = await related('email=a@x.example')
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toMatchObject({ success: false, timed_out: false })
    expect(JSON.stringify(json)).not.toContain('secret-host')
    expect(console.error).toHaveBeenCalled()
  })

  test('requires an email or a domain', async () => {
    expect((await related('password=hunter22')).status).toBe(400)
    expect(sqls).toHaveLength(0)
  })
})

describe('credentials sheet — shows failed buckets instead of "none found"', () => {
  const source = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')

  test('reads `failed` from the response and passes it to each bucket', () => {
    expect(source).toMatch(/failed:\s+Array\.isArray\(data\.failed\)/)
    for (const bucket of ['by_email', 'by_domain', 'by_password']) {
      expect(source).toContain(`failed={relatedFailed.includes('${bucket}')}`)
    }
  })

  test('a failed bucket is not rendered as "none found", and the empty-state message is suppressed when anything failed', () => {
    expect(source).toMatch(/if \(failed\) \{[\s\S]{0,400}couldn&apos;t be loaded/)
    expect(source).toContain('!hasRelated && relatedFailed.length === 0')
  })

  test('a failed request shows a message instead of being silently ignored', () => {
    expect(source).not.toContain('silently ignore')
    expect(source).toContain('setRelatedError(')
    expect(source).toContain('{relatedError} Reopen this credential to retry.')
  })
})
