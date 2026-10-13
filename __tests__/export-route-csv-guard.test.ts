import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

let tableRows: Array<Record<string, string>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string) => {
    if (/system\.projections/.test(sql)) return [{ defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }]
    return tableRows
  }),
  getClient: () => ({ query: async () => ({ stream: () => (async function* () { yield tableRows.map(r => ({ json: () => r })) })() }) }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/export/route'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/export', { method: 'POST', body: JSON.stringify(body) }))

const row = (over: Record<string, string>) => ({
  url: 'https://a.example/login', email: 'u@mail.test', password: 'pw', domain: 'a.example', source_file: 'f.txt', breach_name: '',
  country_tier: '', login_type: 'email', password_length: '2', password_mask: 'alpha', url_scheme: 'https', is_corporate_email: '0',
  email_domain: 'mail.test', url_host: 'a.example', password_entropy_band: 'weak', imported_at: '2026-10-01 00:00:00', ...over,
})

beforeEach(() => {
  resetNewestFirstReadyCache()
})

describe('POST /api/export — CSV formula guard', () => {
  test('a cell that starts with = + - @ gets a leading quote; the other formats keep their bytes', async () => {
    tableRows = [row({ password: '=HYPERLINK("http://x.test","c")', email: '-12345', url: '@cmd' })]
    const csv = await (await post({ format: 'csv' })).text()
    const dataLine = csv.split('\n')[1]
    expect(dataLine).toContain(`"'=HYPERLINK(""http://x.test"",""c"")"`)
    expect(dataLine).toContain(`"'-12345"`)
    expect(dataLine).toContain(`"'@cmd"`)
    const ulp = await (await post({ format: 'ulp' })).text()
    expect(ulp).toBe('@cmd:-12345:=HYPERLINK("http://x.test","c")\n')
  })

  test('csv_guard:false gives the old bytes', async () => {
    tableRows = [row({ password: '=1+1' })]
    const dataLine = (await (await post({ format: 'csv', csv_guard: false })).text()).split('\n')[1]
    expect(dataLine).toContain('"=1+1"')
    expect(dataLine).not.toContain(`"'=1+1"`)
  })

  test('the header row is untouched', async () => {
    tableRows = [row({})]
    const csv = await (await post({ format: 'csv' })).text()
    expect(csv.split('\n')[0].startsWith('url,email,password,domain,source_file,breach_name')).toBe(true)
  })
})
