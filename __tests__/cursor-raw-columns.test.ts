import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let dataRows: Array<Record<string, unknown>> = []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return /count\(\) AS (total|raw_total)|AS total,/.test(sql) ? [{ total: '9', raw_total: '9' }] : dataRows
  }),
}))

import { NextRequest } from 'next/server'
import { GET as browse } from '@/app/api/credentials/route'
import { GET as search } from '@/app/api/search/route'
import { encodeCursor, decodeCursor, stripCursorColumns } from '@/lib/cursor-pagination'

// A legacy "Case D" row as it is STORED: no url, the URL sits in the email column, the credential in password,
// and the domain is blank (so it sorts at the very start of a domain-ordered browse). NORM_COLS shows it repaired.
const stored = { url: '', email: 'site.example/login', password: 'alice:hunter22', domain: '' }
const shown  = { url: 'https://site.example/login', email: 'alice', password: 'hunter22', domain: 'site.example' }
const rawCursorColumns = { _c_url: stored.url, _c_email: stored.email, _c_password: stored.password, _c_domain: stored.domain }

function legacyRow(extra: Record<string, unknown> = {}) {
  return { ...shown, ...rawCursorColumns, imported_at: '2026-07-24 05:14:13', password_length: 7, ...extra }
}

beforeEach(() => {
  calls.length = 0
  dataRows = []
})

describe('encodeCursor — the cursor is made of STORED values, because the rows are ordered and compared by stored columns', () => {
  test('prefers the raw _c_ columns over the normalised display values', () => {
    const decoded = decodeCursor(encodeCursor('domain_asc', legacyRow()))!
    expect(decoded.v).toMatchObject({ domain: '', email: 'site.example/login', url: '', password: 'alice:hunter22' })
  })

  test('falls back to the plain column when a row carries no raw copy (rows read straight from storage)', () => {
    const decoded = decodeCursor(encodeCursor('domain_asc', { domain: 'a.example', email: 'x@a.example', url: 'https://a.example', password: 'pw', imported_at: '2026-01-01 00:00:00' }))!
    expect(decoded.v).toMatchObject({ domain: 'a.example', email: 'x@a.example', url: 'https://a.example', password: 'pw' })
  })

  test('columns that are never normalised (imported_at, password_length) still come from the row', () => {
    const decoded = decodeCursor(encodeCursor('pw_len_desc', legacyRow({ password_length: 12 })))!
    expect(decoded.v.password_length).toBe(12)
  })

  test('stripCursorColumns removes every _c_ key and nothing else', () => {
    const [row] = stripCursorColumns([legacyRow()]) as Array<Record<string, unknown>>
    expect(Object.keys(row).filter(k => k.startsWith('_c_'))).toEqual([])
    expect(row).toMatchObject(shown)
    expect(row.imported_at).toBe('2026-07-24 05:14:13')
  })
})

describe.each([
  ['GET /api/credentials', (qs: string) => browse(new NextRequest(`http://localhost/api/credentials?${qs}`)), 'imported_desc'],
  ['GET /api/search', (qs: string) => search(new NextRequest(`http://localhost/api/search?q=site.example&${qs}`)), 'imported_desc'],
] as const)('%s — paging across legacy rows', (_name, call, _sort) => {
  const dataSql = () => calls.map(c => c.sql).find(s => /\) AS t\s/.test(s))!

  test('the OUTER select also hands back each stored url / email / password / domain under a _c_ alias', async () => {
    await call('limit=2')
    const sql = dataSql()
    const outer = sql.slice(0, sql.indexOf('FROM ('))
    for (const col of ['url', 'email', 'password', 'domain']) expect(outer).toContain(`${col} AS _c_${col}`)
    // ...and the inner query that filters, sorts and limits still reads only raw columns.
    expect(sql.slice(sql.indexOf('FROM ('))).not.toMatch(/\bAS (_c_)?(url|email|password|domain)\b/i)
    expect(sql).toContain('prefer_column_name_to_alias = 1')
  })

  test.each(['domain_asc', 'domain_desc', 'email_asc', 'imported_desc'])(
    'sort=%s: next_cursor is built from the stored values of the last row, not from its repaired display',
    async sort => {
      dataRows = [legacyRow(), legacyRow()]
      const body = await (await call(`limit=2&sort=${sort}`)).json()
      const cursor = decodeCursor(body.next_cursor)!
      expect(cursor.sort).toBe(sort)
      expect(cursor.v.domain).toBe('')
      expect(cursor.v.email).toBe('site.example/login')
      expect(cursor.v.url).toBe('')
      expect(cursor.v.password).toBe('alice:hunter22')
    },
  )

  test('the response rows show the repaired values and carry no _c_ keys', async () => {
    dataRows = [legacyRow(), legacyRow()]
    const body = await (await call('limit=2')).json()
    expect(body.results).toHaveLength(2)
    for (const r of body.results) {
      expect(r).toMatchObject(shown)
      expect(Object.keys(r).filter(k => k.startsWith('_c_'))).toEqual([])
    }
  })

  test('a short page has no next_cursor', async () => {
    dataRows = [legacyRow()]
    const body = await (await call('limit=2')).json()
    expect(body.next_cursor).toBeNull()
  })
})
