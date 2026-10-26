import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
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
let rowsFor: (sql: string, params: Record<string, unknown>) => unknown[] = () => []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return rowsFor(sql, params)
  }),
}))

import { NextRequest } from 'next/server'
import { POST as uiBatch } from '@/app/api/lookup/batch/route'
import { POST as v1Batch } from '@/app/api/v1/lookup/batch/route'
import { RESULTS_CAP, domainResults, emailResults, planDomainBatch, planEmailBatch, stringList } from '@/lib/batch-lookup'

const post = (handler: (request: NextRequest) => Promise<Response>, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))

const cred = (email: string, domain: string, imported_at = '2026-03-01 00:00:00') => ({
  email, url: `https://${domain}/`, password: 'pw', domain, source_file: 'f', breach_name: 'B', imported_at,
})

beforeEach(() => {
  calls.length = 0
  rowsFor = () => []
})

describe('stringList', () => {
  test('keeps the non-blank strings of an array; anything else is nothing', () => {
    expect(stringList([' a ', '', '   ', 3, null, 'b'])).toEqual([' a ', 'b'])
    expect(stringList('a')).toEqual([])
    expect(stringList(undefined)).toEqual([])
  })
})

describe('planEmailBatch', () => {
  test('an ASCII address gets the exact comparison and the index hint; repeats in other spellings are one probe', () => {
    const plan = planEmailBatch(['Jane@Example.tld', '  jane@example.tld  ', '<JANE@example.tld>', 'bob@example.tld'])
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0].where).toBe(
      'lower(email) IN (lower({email0:String}), lower({email1:String})) AND indexHint(hasAllTokens(email, {tok0:Array(String)}) OR hasAllTokens(email, {tok1:Array(String)}))',
    )
    expect(plan.groups[0].params).toEqual({
      email0: 'jane@example.tld', email1: 'bob@example.tld',
      tok0: ['example', 'jane', 'tld'], tok1: ['example', 'bob', 'tld'],
    })
    expect(plan.entries.map(e => e.key)).toEqual(['jane@example.tld', 'jane@example.tld', 'jane@example.tld', 'bob@example.tld'])
  })

  test('a non-ASCII address or one without a word goes into its own group with no hint', () => {
    const plan = planEmailBatch(['jane@example.tld', 'müller@example.tld', '---'])
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups[0].where).toContain('indexHint(')
    expect(plan.groups[1].where).toBe('lower(email) IN (lower({email0:String}), lower({email1:String}))')
    expect(plan.groups[1].params).toEqual({ email0: 'müller@example.tld', email1: '---' })
  })

  test('the case is folded for ASCII letters only, as lower(email) does', () => {
    expect(planEmailBatch(['ÉMILE@X.TLD']).entries[0].key).toBe('Émile@x.tld')
  })

  test('an entry with nothing to look up (empty after cleaning, or too long) is not queried', () => {
    // Quote marks only, a zero-width space (String.trim() keeps it), and an address longer than any real one.
    expect(planEmailBatch(['""', '​ ', `${'a'.repeat(600)}@x.tld`]).groups).toEqual([])
  })
})

describe('emailResults', () => {
  test('rows are matched back by the ASCII-folded login, every stored casing under the address that was asked', () => {
    const plan = planEmailBatch(['jane@example.tld', 'nobody@example.tld'])
    const results = emailResults(plan.entries, [cred('Jane@Example.tld', 'a.tld'), cred('JANE@EXAMPLE.TLD', 'b.tld'), cred('bob@example.tld', 'c.tld')])
    expect(results['jane@example.tld']).toMatchObject({ found: true, count: 2 })
    expect(results['nobody@example.tld']).toEqual({ found: false, count: 0, results: [] })
  })

  test('a non-ASCII upper-case letter is NOT folded: the stored form and the asked form must agree, like lower(email) = lower(value)', () => {
    const plan = planEmailBatch(['Émile@x.tld', 'émile@x.tld'])
    const results = emailResults(plan.entries, [cred('Émile@x.tld', 'a.tld')])
    expect(results['Émile@x.tld'].found).toBe(true)
    expect(results['émile@x.tld'].found).toBe(false)
  })

  test('searched_as appears only when the login differs from what was typed (padding aside)', () => {
    const plan = planEmailBatch(['  Jane@Example.tld ', 'mailto:bob@example.tld', '<carol@example.tld>'])
    const results = emailResults(plan.entries, [])
    expect(results['  Jane@Example.tld ']).not.toHaveProperty('searched_as')
    expect(results['mailto:bob@example.tld'].searched_as).toBe('bob@example.tld')
    expect(results['<carol@example.tld>'].searched_as).toBe('carol@example.tld')
  })
})

describe('planDomainBatch / domainResults', () => {
  test('an entry is looked up as its host and, when different, as typed; the values are distinct', () => {
    const plan = planDomainBatch(['example.tld', 'https://www.example.tld/x', 'example.tld:8443'])
    expect(plan.values).toEqual(['example.tld', 'www.example.tld', 'example.tld:8443'])
  })

  test('an entry that stands for several stored values gets them together, newest first, capped at the per-query cap', () => {
    const plan = planDomainBatch(['https://www.example.tld/'])
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => cred(`a${i}@x.tld`, 'example.tld', `2026-01-${String(i % 28 + 1).padStart(2, '0')} 00:00:00`)),
      ...Array.from({ length: 40 }, (_, i) => cred(`b${i}@x.tld`, 'www.example.tld', `2026-02-${String(i % 28 + 1).padStart(2, '0')} 00:00:00`)),
    ]
    const hit = domainResults(plan.entries, rows)['https://www.example.tld/']
    expect(hit.count).toBe(RESULTS_CAP)
    const times = (hit.results as Array<{ imported_at: string }>).map(r => r.imported_at)
    expect(times).toEqual([...times].sort().reverse())
    expect(hit.searched_as).toBe('example.tld')
  })

  test('a bare lower-case host is shaped exactly as before: no searched_as', () => {
    const plan = planDomainBatch(['example.tld'])
    const hit = domainResults(plan.entries, [cred('a@x.tld', 'example.tld')])['example.tld']
    expect(hit).toEqual({ found: true, count: 1, results: [cred('a@x.tld', 'example.tld')] })
  })
})

describe.each([
  ['POST /api/lookup/batch', uiBatch, '/api/lookup/batch'],
  ['POST /api/v1/lookup/batch', v1Batch, '/api/v1/lookup/batch'],
] as const)('%s — what is pasted is cleaned to what is stored', (_name, handler, url) => {
  test('a URL in the domain list is looked up as its host; the answer is keyed by what was sent and says what was searched', async () => {
    rowsFor = () => [cred('a@x.tld', 'example.tld')]
    const sent = 'https://www.Example.tld/login?next=/a/b'
    const json = await (await post(handler, url, { domains: [sent] })).json()
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('WHERE domain IN ({domain0:String}, {domain1:String})')
    expect(calls[0].params).toMatchObject({ domain0: 'example.tld', domain1: 'www.example.tld', cap: 50 })
    expect(json).toMatchObject({ success: true, queried: 1, found: 1 })
    expect(json.results[sent]).toMatchObject({ found: true, count: 1, searched_as: 'example.tld' })
  })

  test('padded and decorated addresses are looked up as the address in them', async () => {
    rowsFor = () => [cred('Jane@Example.tld', 'a.tld'), cred('bob@example.tld', 'b.tld')]
    const sent = ['  Jane@Example.tld  ', '<bob@example.tld>', 'mailto:carol@example.tld']
    const json = await (await post(handler, url, { emails: sent })).json()
    expect(calls[0].params).toMatchObject({ email0: 'jane@example.tld', email1: 'bob@example.tld', email2: 'carol@example.tld' })
    expect(json.results[sent[0]]).toMatchObject({ found: true, count: 1 })
    expect(json.results[sent[1]]).toMatchObject({ found: true, count: 1, searched_as: 'bob@example.tld' })
    expect(json.results[sent[2]]).toMatchObject({ found: false, searched_as: 'carol@example.tld' })
  })

  test('the text-index words are only a hint: hasAllTokens never appears outside indexHint(...)', async () => {
    await post(handler, url, { emails: ['jane.doe@example.tld', 'bob@example.tld'] })
    const { sql, params } = calls[0]
    expect(sql).toContain('indexHint(hasAllTokens(email, {tok0:Array(String)}) OR hasAllTokens(email, {tok1:Array(String)}))')
    // Evaluated on a row, hasAllTokens is case-sensitive and loses the mixed-case rows of an address (measured: 52 of 54). Inside indexHint it is
    // only used to narrow granules, and the rows are decided by lower(email) IN (...).
    const withoutHint = sql.replace(/indexHint\(.*\)\s*$/m, '')
    expect(withoutHint).not.toContain('hasAllTokens')
    expect(withoutHint).not.toContain('hasToken')
    expect(params).toMatchObject({ tok0: ['example', 'jane', 'doe', 'tld'], tok1: ['example', 'bob', 'tld'] })
  })

  test('a non-ASCII address is a second query without the hint; the answers are merged', async () => {
    rowsFor = (sql) => sql.includes('indexHint')
      ? [cred('jane@example.tld', 'a.tld')]
      : [cred('müller@example.tld', 'b.tld')]
    const json = await (await post(handler, url, { emails: ['jane@example.tld', 'müller@example.tld'] })).json()
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain('indexHint(')
    expect(calls[1].sql).not.toContain('indexHint')
    expect(calls[1].sql).toContain('lower(email) IN (lower({email0:String}))')
    expect(json.found).toBe(2)
  })

  test('entries that clean to nothing run no query and are reported not found', async () => {
    const res = await post(handler, url, { emails: ['""'], domains: ['https://'] })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, queried: 2, found: 0 })
    expect(json.results['""']).toEqual({ found: false, count: 0, results: [] })
    expect(json.results['https://']).toEqual({ found: false, count: 0, results: [] })
  })

  test('a list of both kinds is two queries, one each', async () => {
    await post(handler, url, { emails: ['jane@example.tld'], domains: ['https://example.tld/x'] })
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain('lower(email) IN')
    expect(calls[1].sql).toContain('WHERE domain IN')
  })
})
