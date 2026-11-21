import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))
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
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { dbGet, dbRun } from '@/lib/sqlite'
import { POST } from '@/app/api/lookup/directory/breakdown/route'
import {
  BREAKDOWN_MAX_PARALLEL, BREAKDOWN_QUERY_SECONDS, BreakdownError, breakdownFor, breakdownSql, bucketsFromRows, createLimiter,
} from '@/lib/site-directory-breakdown'

const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }
const LIVE_ROW = { table_uuid: 'uuid-1', part_state: '202611:100:1:9', mutation_state: '', mutations_running: 0, builds_running: 0 }
const FINGERPRINT = createHash('sha1').update('uuid-1|202611:100:1:9|').digest('hex')
const split = [{ login_type: 'email', n: '563' }, { login_type: 'username', n: '397' }, { login_type: 'phone', n: '40' }]
const rowOf = (host: string) => dbGet('SELECT * FROM site_directory WHERE host = ?', [host]) as Record<string, any> | undefined
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/lookup/directory/breakdown', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
const isBreakdown = (sql: string) => sql.includes('login_type')

beforeEach(() => {
  calls.length = 0
  answer = sql => {
    if (sql.includes('system.projection_parts')) return [{ parts: 15, with_projection: 15 }]
    if (sql.includes('system.mutations')) return [LIVE_ROW]
    return split
  }
  vi.mocked(validateRequest).mockResolvedValue(analyst)
  dbRun('DELETE FROM site_directory')
  dbRun(`INSERT INTO site_directory (host, row_count) VALUES ('corp.example', 1000)`)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('breakdownSql / bucketsFromRows', () => {
  test('asks for the rows of the site and every subdomain by the reversed-domain key, grouped by login type, inside the time limit', () => {
    const { sql, params } = breakdownSql('corp.example')
    expect(params).toEqual({ host: 'corp.example' })
    expect(sql).toContain("reverse(domain) = reverse({host:String}) OR startsWith(reverse(domain), reverse(concat('.', {host:String})))")
    expect(sql).toContain('GROUP BY login_type')
    expect(sql).toContain(`max_execution_time = ${BREAKDOWN_QUERY_SECONDS}`)
    expect(sql).toContain("timeout_overflow_mode = 'throw'")
    expect(sql).toContain('http_wait_end_of_query = 1')
    expect(sql).toContain('max_projection_rows_to_use_projection_index = 200000000')
  })

  test('folds the groups into the four parts; a blank or unknown type is "other"; 64-bit numbers arrive as strings', () => {
    expect(bucketsFromRows(split)).toEqual({ email: 563, phone: 40, username: 397, other: 0 })
    expect(bucketsFromRows([{ login_type: '', n: '3' }, { login_type: 'fax', n: 2 }, { login_type: 'email', n: '5' }])).toEqual({ email: 5, phone: 0, username: 0, other: 5 })
    expect(bucketsFromRows([])).toEqual({ email: 0, phone: 0, username: 0, other: 0 })
  })
})

describe('createLimiter', () => {
  test('runs at most max at once and gives a freed slot to the next waiter in order', async () => {
    const limiter = createLimiter(2)
    const started: number[] = []
    const gates: Array<() => void> = []
    let active = 0
    let peak = 0
    const task = (id: number) => limiter(async () => {
      active += 1
      peak = Math.max(peak, active)
      started.push(id)
      await new Promise<void>(resolve => gates.push(resolve))
      active -= 1
    })
    const runs = [task(1), task(2), task(3), task(4)]
    await flush()
    expect(started).toEqual([1, 2])
    gates[0]()
    await flush()
    expect(started).toEqual([1, 2, 3])
    gates[1]()
    await flush()
    expect(started).toEqual([1, 2, 3, 4])
    gates[2]()
    gates[3]()
    await Promise.all(runs)
    expect(peak).toBe(2)
  })

  test('a task that throws still frees its slot', async () => {
    const limiter = createLimiter(1)
    await expect(limiter(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limiter(async () => 5)).resolves.toBe(5)
  })

  test('the app runs two breakdowns at once', () => {
    expect(BREAKDOWN_MAX_PARALLEL).toBe(2)
  })
})

describe('breakdownFor', () => {
  test('returns the four parts of the site', async () => {
    expect(await breakdownFor('corp.example')).toEqual({ email: 563, phone: 40, username: 397, other: 0 })
  })
  test('says it is not available when the reversed-domain key is not on every part, and asks nothing else', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 12 }] : [])
    await expect(breakdownFor('corp.example')).rejects.toMatchObject({ kind: 'unavailable' })
    expect(calls.filter(c => isBreakdown(c.sql))).toHaveLength(0)
  })
  test('a query that ran out of time or memory is "too broad"; any other error is the caller\'s', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 20.1 seconds (TIMEOUT_EXCEEDED)'))
    await expect(breakdownFor('corp.example')).rejects.toMatchObject({ kind: 'too_broad' })
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : new Error('connection refused'))
    await expect(breakdownFor('corp.example')).rejects.toThrow('connection refused')
    await expect(breakdownFor('corp.example')).rejects.not.toBeInstanceOf(BreakdownError)
  })
})

describe('POST /api/lookup/directory/breakdown', () => {
  test('needs a session', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  test('works the split out, stores it with the fingerprint read before, and answers with the site as the list sends it', async () => {
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.site).toMatchObject({ host: 'corp.example', count: 1000, breakdown: { email: 563, phone: 40, username: 397, other: 0 } })
    expect(rowOf('corp.example')).toMatchObject({ bd_email: 563, bd_phone: 40, bd_username: 397, bd_other: 0, bd_fp: FINGERPRINT })
  })

  test('refuses a body that is not JSON, a host as typed instead of as the counts name it, and a site that is not in the directory', async () => {
    const bad = await post('{not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ success: false, error: 'Invalid JSON body' })
    expect((await post({ host: 'https://www.corp.example/login' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    const missing = await post({ host: 'ghost.example' })
    expect(missing.status).toBe(404)
    expect(calls.filter(c => isBreakdown(c.sql))).toHaveLength(0)
  })

  test('a site too broad for the time limit stores nothing and says so (504)', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : sql.includes('system.mutations') ? [LIVE_ROW] : new Error('Timeout exceeded (TIMEOUT_EXCEEDED)'))
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ success: false, error: 'too broad to break down in the time allowed' })
    expect(rowOf('corp.example')!.bd_at).toBeNull()
  })

  test('without the reversed-domain key it is not available (503)', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 12 }] : sql.includes('system.mutations') ? [LIVE_ROW] : [])
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(503)
    expect((await res.json()).success).toBe(false)
  })

  test('another failure is a 500 with a sentence, and is logged', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : sql.includes('system.mutations') ? [LIVE_ROW] : new Error('connection refused'))
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Working out the split failed' })
    expect(console.error).toHaveBeenCalled()
  })
})
