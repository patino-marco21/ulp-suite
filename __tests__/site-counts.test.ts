import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

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

import {
  SITE_COUNTS_BUDGET_MS,
  SITE_COUNTS_CHUNK,
  SITE_COUNTS_TOP,
  countSites,
  hostCountsSql,
  hostRowsToCounts,
  siteCountsResults,
  subdomainCountsSql,
  subdomainRowsToCounts,
  type HostCounts,
} from '@/lib/site-counts'
import { planSites } from '@/lib/site-counts-input'

const NO_RANGE = { lower: null, upper: null }
const READY = [{ parts: 15, with_projection: 15 }]
const isReadiness = (sql: string) => sql.includes('system.projection_parts')
const countingCalls = () => calls.filter(c => !isReadiness(c.sql))

/** A row of the subdomain query as ClickHouse returns it (64-bit integers come back as strings). */
const subRow = (host: string, host_count: number, sub: Array<[string, number]> = []) => ({
  host,
  host_count: String(host_count),
  subdomain_count: String(sub.reduce((n, [, c]) => n + c, 0)),
  subdomains: String(sub.length),
  top_names: sub.map(([d]) => d),
  top_counts: sub.map(([, c]) => String(c)),
})

beforeEach(() => {
  calls.length = 0
  answer = sql => (isReadiness(sql) ? READY : [])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('subdomainCountsSql — a site is its host and every subdomain, counted through the reversed-domain key', () => {
  test('each host is an equality and a label-boundary prefix on the reversed key, and the same list decides which host a row counts for', () => {
    const { sql, params } = subdomainCountsSql(['a.example.tld', 'b.example.tld'], NO_RANGE)
    expect(params).toEqual({ site0: 'a.example.tld', site1: 'b.example.tld', top: SITE_COUNTS_TOP })
    for (const i of [0, 1]) {
      expect(sql).toContain(`reverse(domain) = reverse({site${i}:String}) OR startsWith(reverse(domain), reverse(concat('.', {site${i}:String})))`)
    }
    expect(sql).toContain('FROM ulp.credentials')
    expect(sql).toContain('WHERE suffix IN ({site0:String}, {site1:String})')
    expect(sql).toContain('GROUP BY d')
    expect(sql).toContain('ARRAY JOIN')
  })

  test('a row of the host itself or its www. spelling is the host; anything else under it is a subdomain', () => {
    const { sql } = subdomainCountsSql(['a.example.tld'], NO_RANGE)
    expect(sql).toContain(`d = suffix OR d = concat('www.', suffix)`)
    expect(sql).toContain(`NOT (d = suffix OR d = concat('www.', suffix))`)
  })

  test('the subdomains listed under a site are the ones with the most rows first, ties by name', () => {
    expect(subdomainCountsSql(['a.example.tld'], NO_RANGE).sql).toContain('arraySort(x -> (-toInt64(x.1), x.2), groupArrayIf((n, d)')
  })

  test('the settings keep the scan on the projection and cap the time', () => {
    const { sql } = subdomainCountsSql(['a.example.tld'], NO_RANGE)
    expect(sql).toContain('max_execution_time = 20')
    expect(sql).toContain(`timeout_overflow_mode = 'throw'`)
    expect(sql).toContain('http_wait_end_of_query = 1')
    // without this a window turns the same scan into a full read of every month it touches (measured: 15 s timeout against 0.6 s)
    expect(sql).toContain('max_projection_rows_to_use_projection_index = 200000000')
  })

  test('the pruning condition is never wrapped in indexHint: the projection index does not see through it and the query reads the whole table', () => {
    expect(subdomainCountsSql(['a.example.tld'], NO_RANGE).sql).not.toContain('indexHint')
  })

  test('an imported window is added to the rows that are counted, with its own parameters', () => {
    const { sql, params } = subdomainCountsSql(['a.example.tld'], { lower: 1_700_000_000, upper: 1_800_000_000 })
    expect(sql).toContain('AND imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})')
    expect(params).toMatchObject({ impAfter: 1_700_000_000, impBefore: 1_800_000_000 })
    expect(sql.indexOf('imported_at >')).toBeLessThan(sql.indexOf('GROUP BY d'))
  })
})

describe('hostCountsSql — the fallback that counts only the hosts themselves, through the primary key', () => {
  test('the host and its www. spelling are an IN list on domain, the first column of the key', () => {
    const { sql, params } = hostCountsSql(['a.example.tld', 'b.example.tld'], NO_RANGE)
    expect(params).toEqual({ site0: 'a.example.tld', www0: 'www.a.example.tld', site1: 'b.example.tld', www1: 'www.b.example.tld' })
    expect(sql).toContain('WHERE domain IN ({site0:String}, {www0:String}, {site1:String}, {www1:String})')
    expect(sql).toContain('GROUP BY d')
    expect(sql).not.toContain('reverse(')
  })

  test('an imported window applies here too', () => {
    const { sql, params } = hostCountsSql(['a.example.tld'], { lower: 1_700_000_000, upper: null })
    expect(sql).toContain('AND imported_at > toDateTime({impAfter:Int64})')
    expect(params.impAfter).toBe(1_700_000_000)
  })
})

describe('row shaping', () => {
  test('subdomain rows: numbers come back as numbers, the top list pairs name and count', () => {
    const counts = subdomainRowsToCounts([subRow('a.example.tld', 30, [['login.a.example.tld', 100], ['app.a.example.tld', 15]])])
    expect(counts.get('a.example.tld')).toEqual({
      host_count: 30, subdomain_count: 115, subdomains: 2,
      top_subdomains: [{ domain: 'login.a.example.tld', count: 100 }, { domain: 'app.a.example.tld', count: 15 }],
    })
  })

  test('host rows: the host and its www. spelling add up; a host with no row is 0, and its subdomains are not counted (null)', () => {
    const counts = hostRowsToCounts(['a.example.tld', 'b.example.tld'], [
      { d: 'a.example.tld', n: '7' }, { d: 'www.a.example.tld', n: '2' },
    ])
    expect(counts.get('a.example.tld')).toEqual({ host_count: 9, subdomain_count: null, subdomains: null, top_subdomains: [] })
    expect(counts.get('b.example.tld')).toEqual({ host_count: 0, subdomain_count: null, subdomains: null, top_subdomains: [] })
  })
})

describe('siteCountsResults', () => {
  const counted = new Map<string, HostCounts>([
    ['a.example.tld', { host_count: 30, subdomain_count: 120, subdomains: 3, top_subdomains: [{ domain: 'x.a.example.tld', count: 100 }] }],
  ])

  test('the count of a site is its host plus its subdomains; a host nobody wrote a row for is a zero, not missing', () => {
    const plan = planSites(['a.example.tld', 'quiet.example.tld'])
    const results = siteCountsResults(plan.entries, counted, new Map(), true)
    expect(results['a.example.tld']).toEqual({
      host: 'a.example.tld', found: true, count: 150, host_count: 30, subdomain_count: 120, subdomains: 3,
      top_subdomains: [{ domain: 'x.a.example.tld', count: 100 }],
    })
    expect(results['quiet.example.tld']).toEqual({
      host: 'quiet.example.tld', found: false, count: 0, host_count: 0, subdomain_count: 0, subdomains: 0, top_subdomains: [],
    })
  })

  test('searched_as says what was counted when it is not what was typed, and is absent when it is only the spelling', () => {
    const plan = planSites(['https://www.A.example.tld/login', '  A.EXAMPLE.TLD ', 'a.example.tld/path'])
    const results = siteCountsResults(plan.entries, counted, new Map(), true)
    expect(results['https://www.A.example.tld/login'].searched_as).toBe('a.example.tld')
    expect(results['  A.EXAMPLE.TLD '].searched_as).toBeUndefined()
    expect(results['a.example.tld/path'].searched_as).toBe('a.example.tld')
  })

  test('the answer keeps the order of the list', () => {
    const plan = planSites(['z.example.tld', 'a.example.tld', 'm.example.tld'])
    expect(Object.keys(siteCountsResults(plan.entries, counted, new Map(), true))).toEqual(['z.example.tld', 'a.example.tld', 'm.example.tld'])
  })

  test('text that is not a site has no numbers and says so', () => {
    const results = siteCountsResults(planSites(['localhost']).entries, counted, new Map(), true)
    expect(results.localhost).toEqual({
      host: '', found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], error: 'not a site address',
    })
  })

  test('a site that could not be counted has no numbers and the reason, never a zero', () => {
    const results = siteCountsResults(planSites(['big.example.tld']).entries, new Map(), new Map([['big.example.tld', 'too broad to count in the time allowed']]), true)
    expect(results['big.example.tld']).toEqual({
      host: 'big.example.tld', found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [],
      error: 'too broad to count in the time allowed',
    })
  })

  test('with only hosts counted, the count is the host count and the subdomain numbers are null', () => {
    const hostOnly = new Map<string, HostCounts>([['a.example.tld', { host_count: 9, subdomain_count: null, subdomains: null, top_subdomains: [] }]])
    const results = siteCountsResults(planSites(['a.example.tld']).entries, hostOnly, new Map(), false)
    expect(results['a.example.tld']).toMatchObject({ found: true, count: 9, host_count: 9, subdomain_count: null, subdomains: null })
  })
})

describe('countSites', () => {
  test('one readiness check, then one query for a short list; the answer carries each site with its count', async () => {
    answer = sql => (isReadiness(sql) ? READY : [subRow('a.example.tld', 30, [['login.a.example.tld', 100]])])
    const out = await countSites(['https://www.a.example.tld/x', 'b.example.tld'], NO_RANGE)
    expect(calls.map(c => isReadiness(c.sql))).toEqual([true, false])
    expect(countingCalls()[0].params).toMatchObject({ site0: 'a.example.tld', site1: 'b.example.tld' })
    expect(out.subdomains_counted).toBe(true)
    expect(out.results['https://www.a.example.tld/x']).toMatchObject({ host: 'a.example.tld', count: 130, searched_as: 'a.example.tld' })
    expect(out.results['b.example.tld']).toMatchObject({ found: false, count: 0 })
  })

  test('spellings of one host are counted once', async () => {
    await countSites(['a.example.tld', 'https://a.example.tld/', 'WWW.A.EXAMPLE.TLD'], NO_RANGE)
    expect(countingCalls()).toHaveLength(1)
    expect(countingCalls()[0].params).toMatchObject({ site0: 'a.example.tld' })
    expect(countingCalls()[0].params).not.toHaveProperty('site1')
  })

  test('a long list is counted in chunks of 20, so the work for each query stays small (25 sites took 0.75 s, 100 took 5 s in one query)', async () => {
    const entries = Array.from({ length: 45 }, (_, i) => `s${i}.example.tld`)
    await countSites(entries, NO_RANGE)
    expect(SITE_COUNTS_CHUNK).toBe(20)
    expect(countingCalls().map(c => Object.keys(c.params).filter(k => k.startsWith('site')).length)).toEqual([20, 20, 5])
  })

  test('nothing usable in the list means no query at all', async () => {
    const out = await countSites(['localhost', ''], NO_RANGE)
    expect(calls).toHaveLength(0)
    expect(out.results.localhost.error).toBe('not a site address')
  })

  test('the imported window reaches the counting query', async () => {
    await countSites(['a.example.tld'], { lower: 1_700_000_000, upper: null })
    expect(countingCalls()[0].params.impAfter).toBe(1_700_000_000)
  })

  test('without the reversed-domain key on every part only the hosts are counted, and the answer says so', async () => {
    answer = sql => (isReadiness(sql) ? [{ parts: 15, with_projection: 14 }] : [{ d: 'a.example.tld', n: '9' }])
    const out = await countSites(['a.example.tld'], NO_RANGE)
    expect(countingCalls()[0].sql).toContain('WHERE domain IN (')
    expect(countingCalls()[0].sql).not.toContain('reverse(')
    expect(out.subdomains_counted).toBe(false)
    expect(out.results['a.example.tld']).toMatchObject({ count: 9, host_count: 9, subdomain_count: null, subdomains: null })
  })

  test('a readiness check that fails is "not ready", not an error: the hosts are still counted', async () => {
    answer = sql => (isReadiness(sql) ? new Error('connection reset') : [])
    const out = await countSites(['a.example.tld'], NO_RANGE)
    expect(out.subdomains_counted).toBe(false)
    expect(out.results['a.example.tld']).toMatchObject({ found: false, count: 0 })
  })

  test('a chunk that times out is counted site by site, and only the site that is too broad is left without a number', async () => {
    answer = (sql, params) => {
      if (isReadiness(sql)) return READY
      if (Object.keys(params).filter(k => k.startsWith('site')).length > 1) return new Error('Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)')
      if (params.site0 === 'huge.example.tld') return new Error('Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)')
      return [subRow(String(params.site0), 4)]
    }
    const out = await countSites(['a.example.tld', 'huge.example.tld', 'b.example.tld'], NO_RANGE)
    expect(countingCalls()).toHaveLength(1 + 3)
    expect(out.results['a.example.tld']).toMatchObject({ count: 4, host_count: 4 })
    expect(out.results['b.example.tld']).toMatchObject({ count: 4 })
    expect(out.results['huge.example.tld']).toMatchObject({ found: false, count: null, error: 'too broad to count in the time allowed' })
  })

  test('an error that is not about time or memory is an error of the request, not a quiet gap in the list', async () => {
    answer = sql => (isReadiness(sql) ? READY : new Error('connect ECONNREFUSED 127.0.0.1:8123'))
    await expect(countSites(['a.example.tld'], NO_RANGE)).rejects.toThrow('ECONNREFUSED')
  })

  test('a chunk that runs out of memory is counted site by site like one that is too slow', async () => {
    answer = (sql, params) => {
      if (isReadiness(sql)) return READY
      if (Object.keys(params).filter(k => k.startsWith('site')).length > 1) return new Error('Code: 241. DB::Exception: Memory limit (for query) exceeded (MEMORY_LIMIT_EXCEEDED)')
      return [subRow(String(params.site0), 2)]
    }
    const out = await countSites(['a.example.tld', 'b.example.tld'], NO_RANGE)
    expect(out.results['a.example.tld']).toMatchObject({ count: 2 })
    expect(out.results['b.example.tld']).toMatchObject({ count: 2 })
  })

  test('when the time for one request is used up, the sites not yet counted say so instead of waiting on', async () => {
    let clock = 0
    answer = sql => {
      if (!isReadiness(sql)) clock += SITE_COUNTS_BUDGET_MS / 2 + 1
      return isReadiness(sql) ? READY : []
    }
    const entries = Array.from({ length: SITE_COUNTS_CHUNK * 3 }, (_, i) => `s${i}.example.tld`)
    const out = await countSites(entries, NO_RANGE, { now: () => clock })
    expect(countingCalls()).toHaveLength(2)
    expect(out.results['s0.example.tld']).toMatchObject({ found: false, count: 0 })
    expect(out.results[entries[SITE_COUNTS_CHUNK * 2]]).toMatchObject({ found: false, count: null })
    expect(out.results[entries[SITE_COUNTS_CHUNK * 2]].error).toMatch(/time limit/)
  })
})
