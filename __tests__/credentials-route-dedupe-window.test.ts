import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'

/** The data query is the one that wraps the filtered rows in `FROM ( ... ) AS t`. */
async function dataQuery(qs: string) {
  calls.length = 0
  await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
  const data = calls.find(c => c.sql.includes('FROM (') && /\) AS t\s/.test(c.sql))
  expect(data).toBeDefined()
  return data!
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('credentials route — Unique with a non-domain sort de-duplicates inside a bounded top-N window', () => {
  // Measured 2026-09-30 on 1.39B rows: `ORDER BY imported_at DESC ... LIMIT 1 BY content_key_hash LIMIT 200` read
  // 1.22B rows / 9.8 GiB and hit the 300 s cap; the window form finishes in ~41 s / 1.4 GiB.
  test.each(['imported_desc', 'imported_asc', 'email_asc', 'email_desc', 'pw_len_desc', 'pw_len_asc'])(
    '%s + dedupe takes the top 3n rows first, then LIMIT 1 BY inside that window',
    async sort => {
      const { sql, params } = await dataQuery(`sort=${sort}&dedupe=1&exclude_noise=1&limit=200`)
      expect(sql).toContain('LIMIT {windowLimit:UInt32}')
      expect(params.windowLimit).toBe(600)
      expect(params.limit).toBe(200)
      // The window is the inner query (a streaming top-N); the LIMIT BY only sees those rows.
      const windowAt = sql.indexOf('LIMIT {windowLimit:UInt32}')
      const limitByAt = sql.indexOf('LIMIT 1 BY content_key_hash')
      expect(limitByAt).toBeGreaterThan(windowAt)
      // The LIMIT BY query re-sorts the window, so "first row per key" means the first in the active sort order.
      expect(sql.slice(windowAt, limitByAt)).toMatch(/ORDER BY /)
    },
  )

  test('the window query does not select more than it needs and keeps the raw-column filter', async () => {
    const { sql } = await dataQuery('sort=imported_desc&dedupe=1&exclude_noise=1&limit=200')
    expect(sql).toContain('is_noise = 0')
    expect(sql).toContain('content_key_hash')
    // NORM_COLS (which aliases url/email/password/domain) belongs to the OUTER select only; every query
    // below the first `FROM (` reads raw columns, or the aliases would shadow them inside the WHERE.
    expect(sql.slice(sql.indexOf('FROM ('))).not.toMatch(/\bAS (url|email|password|domain)\b/i)
  })

  test.each(['imported_desc', 'domain_asc'])('%s: both query forms prefer stored columns over NORM_COLS aliases', async sort => {
    const { sql } = await dataQuery(`sort=${sort}&dedupe=1&exclude_noise=1&limit=200`)
    expect(sql).toContain('prefer_column_name_to_alias = 1')
  })

  test('the window scales with the page size', async () => {
    const { params } = await dataQuery('sort=email_asc&dedupe=1&limit=50')
    expect(params.windowLimit).toBe(150)
  })

  test.each(['domain_asc', 'domain_desc'])('%s + dedupe keeps the plain single-level form (it reads in primary-key order)', async sort => {
    const { sql, params } = await dataQuery(`sort=${sort}&dedupe=1&exclude_noise=1&limit=200`)
    expect(sql).toContain('LIMIT 1 BY content_key_hash')
    expect(sql).not.toContain('windowLimit')
    expect(params.windowLimit).toBeUndefined()
  })

  test('without dedupe there is no LIMIT BY and no window, whatever the sort', async () => {
    const { sql, params } = await dataQuery('sort=imported_desc&limit=200')
    expect(sql).not.toContain('LIMIT 1 BY')
    expect(sql).not.toContain('windowLimit')
    expect(params.windowLimit).toBeUndefined()
  })
})
