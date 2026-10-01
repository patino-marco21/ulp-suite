import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let dataRows: Array<Record<string, unknown>> = []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return /count\(\) AS total/.test(sql) ? [{ total: '7' }] : dataRows
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/search/route'
import { SORT_MAP, encodeCursor } from '@/lib/cursor-pagination'

async function search(qs: string) {
  calls.length = 0
  const res = await GET(new NextRequest(`http://localhost/api/search?${qs}`))
  return {
    res,
    count: calls.find(c => /count\(\) AS total/.test(c.sql)),
    data: calls.find(c => /\) AS t\s/.test(c.sql)),
  }
}

const inner = (sql: string) => sql.slice(sql.indexOf('FROM ('))

beforeEach(() => {
  dataRows = []
})

describe('GET /api/search — filter and sort on raw columns, normalize only the LIMIT-sized result', () => {
  test('the data query is an outer NORM_COLS select over an inner raw-column select that holds WHERE, ORDER BY and LIMIT', async () => {
    const { data } = await search('q=ledger.com&limit=25')
    expect(data).toBeDefined()
    const sql = data!.sql
    const outer = sql.slice(0, sql.indexOf('FROM ('))
    for (const col of ['url', 'email', 'password', 'domain']) expect(outer).toMatch(new RegExp(`\\bAS ${col}\\b`))
    // Below the first `FROM (` only raw columns: a NORM_COLS alias there would shadow the stored column in the WHERE.
    expect(inner(sql)).not.toMatch(/\bAS (url|email|password|domain)\b/i)
    expect(inner(sql)).toContain('FROM ulp.credentials')
    expect(inner(sql)).toContain('WHERE ')
    expect(inner(sql)).toContain('LIMIT {limit:UInt32}')
    expect(data!.params.limit).toBe(25)
  })

  test.each(Object.entries(SORT_MAP))('sort=%s orders the INNER query by the whitelisted expression', async (key, expr) => {
    const { data } = await search(`q=ledger.com&sort=${key}`)
    const sql = data!.sql
    const orderAt = sql.indexOf(`ORDER BY ${expr}`)
    expect(orderAt).toBeGreaterThan(sql.indexOf('FROM ('))
    expect(orderAt).toBeLessThan(sql.indexOf('LIMIT {limit:UInt32}'))
  })

  test('a keyset cursor is applied to the raw columns inside the inner query', async () => {
    const token = encodeCursor('imported_desc', { imported_at: '2026-01-02 03:04:05', domain: 'a.example', email: 'a@a.example', url: 'https://a.example', password: 'pw' })
    const { data } = await search(`q=ledger.com&sort=imported_desc&cursor=${encodeURIComponent(token)}`)
    expect(inner(data!.sql)).toContain('imported_at < {c_ia:DateTime}')
    expect(data!.params).toMatchObject({ c_d: 'a.example', c_e: 'a@a.example' })
  })

  test('the count query stays a plain count over the same filter (no cursor), capped with break mode', async () => {
    const token = encodeCursor('imported_desc', { imported_at: '2026-01-02 03:04:05', domain: 'a', email: 'b', url: 'c', password: 'd' })
    const { count, data } = await search(`q=ledger.com&cursor=${encodeURIComponent(token)}`)
    expect(count!.sql).not.toContain('FROM (')
    expect(count!.sql).not.toContain('c_ia')
    expect(count!.sql).toContain("timeout_overflow_mode = 'break'")
    expect(data!.sql).toContain("timeout_overflow_mode = 'throw'")
  })

  test('response shape: rows, total, and a cursor only when a full page came back', async () => {
    dataRows = [
      { url: 'https://a.example', email: 'a@a.example', password: 'pw', domain: 'a.example', imported_at: '2026-01-02 00:00:00' },
      { url: 'https://b.example', email: 'b@b.example', password: 'pw', domain: 'b.example', imported_at: '2026-01-01 00:00:00' },
    ]
    const full = await (await search('q=ledger.com&limit=2')).res.json()
    expect(full).toMatchObject({ success: true, total: 7, sort: 'imported_desc' })
    expect(full.results).toHaveLength(2)
    expect(typeof full.next_cursor).toBe('string')
    const partial = await (await search('q=ledger.com&limit=5')).res.json()
    expect(partial.next_cursor).toBeNull()
  })

  test('with no filter it answers immediately without touching ClickHouse', async () => {
    const { res, count, data } = await search('')
    expect((await res.json()).total).toBe(0)
    expect(count).toBeUndefined()
    expect(data).toBeUndefined()
  })
})
