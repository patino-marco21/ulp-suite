import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const fresh = {
  state: 'fresh', fingerprint: 'fp-1', builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
}
let windowsReadiness: Array<Record<string, unknown>> = [{ defined: 0, parts: 1, with_projection: 0 }] // newest-first windows NOT ready: the plain path answers

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/FROM ulp\.search_host_dict/.test(sql)) return [{ domain: 'ledger.com' }]
    if (/FROM ulp\.search_emaildomain_dict/.test(sql)) return [{ email_domain: 'ledger.com' }]
    if (/system\.projections/.test(sql)) return windowsReadiness
    if (/AS raw_total/.test(sql)) return [{ total: '11', raw_total: '12' }]
    return []
  }),
}))
vi.mock('@/lib/search-dictionary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/search-dictionary')>('@/lib/search-dictionary')
  return { ...actual, getSearchDictionaryStatus: vi.fn(async () => fresh) }
})
vi.mock('@/lib/credentials-projections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/credentials-projections')>('@/lib/credentials-projections')
  return { ...actual, isEmailDomainRevProjectionReady: vi.fn(async () => true) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { resetDictionaryPlanCache } from '@/lib/search-dictionary-plan'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const allSql = () => calls.map(c => c.sql).join('\n')
const allParams = () => Object.assign({}, ...calls.map(c => c.params))
const isLookup = (c: Call) => /FROM ulp\.search_(host|emaildomain)_dict/.test(c.sql)

beforeEach(() => {
  calls.length = 0
  windowsReadiness = [{ defined: 0, parts: 1, with_projection: 0 }]
  resetDictionaryPlanCache()
  resetNewestFirstReadyCache()
})

describe('GET /api/credentials — scope', () => {
  test('Login (whole word) looks at the login only, for the rows and for the totals', async () => {
    await get('q=Maria&scope=login&skip_totals=1&dedupe=0')
    await get('q=Maria&scope=login&totals_only=1&dedupe=0')
    const sql = allSql()
    expect(sql).toContain('hasToken(email, {lw0:String})')
    expect(sql).not.toContain('hasToken(url')
    expect(sql).not.toContain('hasToken(password')
    expect(allParams().lw0).toBe('maria')
  })

  test('Login (contains) is a case-insensitive substring check on the login', async () => {
    await get('q=Maria&scope=login_contains&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('positionCaseInsensitive(email, {lc0:String}) > 0')
    expect(allParams().lc0).toBe('Maria')
  })

  test('the login: prefix works without any scope parameter', async () => {
    await get('q=login:Maria&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('hasToken(email, {lw0:String})')
    expect(allSql()).not.toContain('hasToken(url')
  })

  test('without a scope (or with scope=all) the search is the one it always was', async () => {
    await get('q=maria&skip_totals=1&dedupe=0')
    await get('q=maria&scope=all&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('hasToken(url, {tok0:String})')
    expect(allSql()).not.toContain('positionCaseInsensitive')
  })

  test('regex mode in a login scope matches the login column only', async () => {
    await get(`q=${encodeURIComponent('^adm')}&regex=1&scope=login&skip_totals=1&dedupe=0`)
    expect(allSql()).toContain('match(email, {rp0:String})')
    // the SELECT list's own display normalisation contains a literal match(url, ...), so test for the bound search predicate
    expect(allSql()).not.toContain('match(url, {rp0:String})')
  })

  test('a full address is an exact match that ignores case', async () => {
    await get('q=John.Smith@example.com&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('lower(email) = lower({exactemail0:String})')
    expect(allParams().exactemail0).toBe('John.Smith@example.com')
  })

  test('an unknown scope is a 400 and runs nothing', async () => {
    const res = await get('q=maria&scope=password')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'scope must be all, login or login_contains' })
    expect(calls).toHaveLength(0)
  })
})

describe('GET /api/credentials — the domain dictionary shortcut stays out of the login scopes', () => {
  test('a domain search with the default scope uses the dictionary (control)', async () => {
    await get('q=ledger.com&skip_totals=1&exclude_noise=1&dedupe=1')
    expect(calls.filter(isLookup).length).toBeGreaterThan(0)
  })

  test.each([
    'q=ledger.com&scope=login&skip_totals=1&exclude_noise=1&dedupe=1',
    'q=ledger.com&scope=login_contains&skip_totals=1&exclude_noise=1&dedupe=1',
    'q=login:ledger.com&skip_totals=1&exclude_noise=1&dedupe=1',
  ])('%s does not', async qs => {
    await get(qs)
    expect(calls.filter(isLookup)).toHaveLength(0)
  })
})
