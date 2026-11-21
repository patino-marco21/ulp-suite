import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { dbRun } from '@/lib/sqlite'
import { DELETE, GET } from '@/app/api/lookup/directory/route'

const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }
const get = (query = '') => GET(new NextRequest(`http://localhost/api/lookup/directory${query}`))
const del = (body: unknown) => DELETE(new NextRequest('http://localhost/api/lookup/directory', { method: 'DELETE', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  vi.mocked(validateRequest).mockResolvedValue(analyst)
  dbRun('DELETE FROM site_directory')
  dbRun('DELETE FROM site_marks')
  dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES ('site_directory_seeded', '1')`)
  dbRun(`INSERT INTO site_directory (host, row_count, host_count, subdomain_count, subdomains) VALUES ('corp.example', 30, 10, 20, 2), ('quiet.example', 0, 0, 0, 0)`)
})

describe.each([['GET', () => get()], ['DELETE', () => del({ host: 'corp.example' })]] as const)('%s /api/lookup/directory', (_verb, call) => {
  test('needs a session: 401 without one, and nothing changes', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    vi.mocked(validateRequest).mockResolvedValue(analyst)
    expect((await (await get()).json()).total).toBe(2)
  })
})

describe('GET', () => {
  test('answers a page: the sites, the next offset, the total and the chips', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true, next_offset: null, total: 2, marks: { all: 2, done: 0, skip: 0, todo: 0, none: 2 }, refreshed_at: null,
      sites: [{ host: 'corp.example', count: 30, host_count: 10, subdomain_count: 20, mark: null, breakdown: null }, { host: 'quiet.example', count: 0 }],
    })
  })

  test('reads the sort, the search, the chip and the paging from the query string', async () => {
    const json = await (await get('?sort=count&dir=asc&q=EXAMPLE&limit=1&offset=0')).json()
    expect(json.sites.map((s: { host: string }) => s.host)).toEqual(['quiet.example'])
    expect(json.next_offset).toBe(1)
    const next = await (await get('?sort=count&dir=asc&q=EXAMPLE&limit=1&offset=1')).json()
    expect(next.sites.map((s: { host: string }) => s.host)).toEqual(['corp.example'])
    expect(next.total).toBeNull()
  })

  test('an unknown sort or chip falls back to the default instead of failing', async () => {
    const res = await get('?sort=drop%20table&mark=maybe&offset=abc')
    expect(res.status).toBe(200)
    expect((await res.json()).sites).toHaveLength(2)
  })
})

describe('DELETE', () => {
  test('removes a site', async () => {
    const res = await del({ host: 'corp.example' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, host: 'corp.example' })
    expect((await (await get()).json()).total).toBe(1)
  })
  test('404 for a site that is not there, 400 for a body without a host or that is not JSON', async () => {
    expect((await del({ host: 'ghost.example' })).status).toBe(404)
    expect((await del({})).status).toBe(400)
    expect((await del({ host: 5 })).status).toBe(400)
    const bad = await del('{not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ success: false, error: 'Invalid JSON body' })
  })
})
