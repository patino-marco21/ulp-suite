import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  dictionaryTermFromQuery, resolveDictionaryCandidates, resetDictionaryPlanCache, buildDictionaryRowsSql, buildDictionaryTotalsSql,
  DICTIONARY_SQL_MAX_CHARS, type DictionaryCandidates, type DictionaryTerm,
} from '@/lib/search-dictionary-plan'
import { buildULPWhere, parseULPQuery } from '@/lib/ulp-search'
import type { DictionaryStatus } from '@/lib/search-dictionary'

const freshStatus = (fp = 'fp-1'): DictionaryStatus => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
const notFresh = (state: DictionaryStatus['state']): DictionaryStatus => ({ ...freshStatus(), state, fingerprint: null })
const TERM: DictionaryTerm = { exact: 'ledger.com', suffix: '%.ledger.com', like: '%ledger.com%' }

function lookupRun(data: { exact?: string[]; suffix?: string[]; host?: string[]; email?: string[] }) {
  return vi.fn(async (sql: string, _params: Record<string, unknown> = {}) => {
    if (sql.includes('WHERE domain = {exact:String}')) return (data.exact ?? []).map(domain => ({ domain }))
    if (sql.includes('WHERE domain LIKE {suffix:String}')) return (data.suffix ?? []).map(domain => ({ domain }))
    if (sql.includes('WHERE url_host LIKE {like:String}')) return (data.host ?? []).map(domain => ({ domain }))
    if (sql.includes('FROM ulp.search_emaildomain_dict')) return (data.email ?? []).map(email_domain => ({ email_domain }))
    return []
  })
}
const ready = async () => true

beforeEach(() => { resetDictionaryPlanCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('dictionaryTermFromQuery', () => {
  test('one positive domain-shaped term gives the very LIKE patterns the legacy predicate uses', () => {
    expect(dictionaryTermFromQuery('ledger.com', false)).toEqual(TERM)
    expect(dictionaryTermFromQuery('Trezor.IO', false)).toEqual({ exact: 'trezor.io', suffix: '%.trezor.io', like: '%trezor.io%' })
    expect(dictionaryTermFromQuery('my_site.example.com', false)).toEqual({
      exact: 'my_site.example.com', suffix: '%.my\\_site.example.com', like: '%my\\_site.example.com%',
    })
    expect(dictionaryTermFromQuery('192.168.1.1', false)).not.toBeNull()
  })

  test('the patterns are the ones buildULPWhere puts in its parameters, so the two cannot drift apart', () => {
    for (const q of ['ledger.com', 'a-b.c_d.example.org']) {
      const { params } = buildULPWhere(parseULPQuery(q))
      expect(dictionaryTermFromQuery(q, false)).toEqual({ exact: params.dom0, suffix: params.domsuf0, like: params.domlk0 })
    }
  })

  test.each(['ledger', '@ledger.com', 'john@ledger.com', 'ledger.com,trezor.io', '-ledger.com', 'a b.com', '', 'ledger.com/path', 'ledger..com'])(
    'not eligible: %j',
    q => { expect(dictionaryTermFromQuery(q, false)).toBeNull() },
  )

  test('regex mode is never eligible', () => {
    expect(dictionaryTermFromQuery('ledger.com', true)).toBeNull()
  })
})

describe('resolveDictionaryCandidates', () => {
  test('runs the four lookups with the term\'s patterns and a cap one above the limit; sorts and de-duplicates', async () => {
    const run = lookupRun({ exact: ['ledger.com'], suffix: ['app.ledger.com'], host: ['ledger.com', 'coinledger.com'], email: ['ledger.com'] })
    const c = await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(4)
    const params = run.mock.calls.map(call => call[1])
    expect(params).toEqual(expect.arrayContaining([
      { exact: 'ledger.com', cap: 3001 }, { suffix: '%.ledger.com', cap: 3001 }, { like: '%ledger.com%', cap: 3001 }, { like: '%ledger.com%', cap: 301 },
    ]))
    expect(c).toEqual({
      domains: ['app.ledger.com', 'coinledger.com', 'ledger.com'],
      emailDomains: ['ledger.com'],
      empty: false,
      domainsLiteral: "['app.ledger.com','coinledger.com','ledger.com']",
      emailRevLiteral: "['moc.regdel']",
    })
  })

  test('every lookup has a time limit and bypasses the ClickHouse result cache; none can be mistaken for a data or totals query', async () => {
    const run = lookupRun({ exact: ['ledger.com'] })
    await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })
    for (const [sql] of run.mock.calls) {
      expect(sql).toContain('max_execution_time = 8')
      expect(sql).toContain('use_query_cache = 0')
      expect(sql).not.toMatch(/\) AS t\s/)
      expect(sql).not.toMatch(/AS raw_total/)
    }
  })

  test('the email domains are reversed as UTF-8 BYTES, like ClickHouse reverse(); a reversed JavaScript string would miss non-ASCII ones', async () => {
    const run = lookupRun({ email: ['é.com', 'ledger.com'] })
    const c = await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })
    // sorted as JavaScript sorts ('l' is U+006C, 'é' U+00E9), THEN reversed bytewise
    expect(c!.emailRevLiteral).toBe("['moc.regdel','moc.\\xa9\\xc3']")
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'] as const)('a dictionary that is %s means today\'s query, and no lookup runs', async state => {
    const run = lookupRun({ exact: ['ledger.com'] })
    expect(await resolveDictionaryCandidates(TERM, { run, status: async () => notFresh(state), projectionReady: ready })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('switched off by the environment: null, and not even the status is read', async () => {
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    const status = vi.fn(async () => freshStatus())
    expect(await resolveDictionaryCandidates(TERM, { run: lookupRun({}), status, projectionReady: ready })).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })

  test('a repeat of the term reuses the answer; another fingerprint or another term looks again', async () => {
    const run = lookupRun({ exact: ['ledger.com'] })
    const deps = (fp: string) => ({ run, status: async () => freshStatus(fp), projectionReady: ready })
    await resolveDictionaryCandidates(TERM, deps('fp-1'))
    await resolveDictionaryCandidates(TERM, deps('fp-1'))
    expect(run).toHaveBeenCalledTimes(4)
    await resolveDictionaryCandidates(TERM, deps('fp-2'))
    expect(run).toHaveBeenCalledTimes(8)
    await resolveDictionaryCandidates({ exact: 'trezor.io', suffix: '%.trezor.io', like: '%trezor.io%' }, deps('fp-2'))
    expect(run).toHaveBeenCalledTimes(12)
  })

  test('the rows request and the totals request the page sends together share ONE lookup (the in-flight promise)', async () => {
    const run = lookupRun({ exact: ['ledger.com'], email: ['ledger.com'] })
    const deps = { run, status: async () => freshStatus(), projectionReady: ready }
    const [a, b] = await Promise.all([resolveDictionaryCandidates(TERM, deps), resolveDictionaryCandidates(TERM, deps)])
    expect(run).toHaveBeenCalledTimes(4)
    expect(a).toBe(b)
  })

  test('the answer is kept for ten minutes, then looked up again', async () => {
    const run = lookupRun({ exact: ['ledger.com'] })
    let t = 0
    const deps = { run, now: () => t, status: async () => freshStatus(), projectionReady: ready }
    await resolveDictionaryCandidates(TERM, deps)
    t = 599_000
    await resolveDictionaryCandidates(TERM, deps)
    expect(run).toHaveBeenCalledTimes(4)
    t = 601_000
    await resolveDictionaryCandidates(TERM, deps)
    expect(run).toHaveBeenCalledTimes(8)
  })

  test('keeps at most 200 terms', async () => {
    const run = lookupRun({ exact: ['x.com'] })
    const deps = { run, status: async () => freshStatus(), projectionReady: ready }
    for (let i = 0; i < 201; i++) await resolveDictionaryCandidates({ exact: `t${i}.com`, suffix: `%.t${i}.com`, like: `%t${i}.com%` }, deps)
    run.mockClear()
    await resolveDictionaryCandidates({ exact: 't0.com', suffix: '%.t0.com', like: '%t0.com%' }, deps) // the oldest was evicted
    expect(run).toHaveBeenCalledTimes(4)
    run.mockClear()
    await resolveDictionaryCandidates({ exact: 't200.com', suffix: '%.t200.com', like: '%t200.com%' }, deps) // the newest is still there
    expect(run).not.toHaveBeenCalled()
  })

  describe('caps: above any of them the answer is "use today\'s query", and that verdict is remembered too', () => {
    test('more candidate domains than SEARCH_DICT_MAX_DOMAINS (counted over the union of the three lookups)', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_DOMAINS', '2')
      const run = lookupRun({ exact: ['a.com'], suffix: ['b.com'], host: ['c.com'] })
      const deps = { run, status: async () => freshStatus(), projectionReady: ready }
      expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
      expect(run.mock.calls.find(c => String(c[0]).includes('{exact:String}'))![1]).toMatchObject({ cap: 3 })
      expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
      expect(run).toHaveBeenCalledTimes(4)
    })

    test('more email domains than SEARCH_DICT_MAX_EMAIL_DOMAINS', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_EMAIL_DOMAINS', '1')
      const run = lookupRun({ exact: ['ledger.com'], email: ['a.ledger.com', 'b.ledger.com'] })
      expect(await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })).toBeNull()
    })

    test('a list of D that would not fit the SQL (90,000 bytes) even though the count is under the cap', async () => {
      const long = Array.from({ length: 2000 }, (_, i) => `d${i}.${'x'.repeat(50)}.test`)
      const run = lookupRun({ host: long })
      expect(await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })).toBeNull()
    })

    test('a list of E above 20,000 bytes', async () => {
      const long = Array.from({ length: 290 }, (_, i) => `${'y'.repeat(70)}${i}.ledger.com`) // under the 300 count cap, about 26 KB of literal
      const run = lookupRun({ exact: ['ledger.com'], email: long })
      expect(await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })).toBeNull()
    })
  })

  test('a lookup that fails or times out means today\'s query, with one warning, and is not retried for a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValue(new Error('Code: 159. Timeout exceeded: TIMEOUT_EXCEEDED'))
    let t = 0
    const deps = { run, now: () => t, status: async () => freshStatus(), projectionReady: ready }
    expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('candidate lookup failed')
    const calls = run.mock.calls.length
    t = 59_000
    expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
    expect(run.mock.calls.length).toBe(calls)
    t = 61_000
    await resolveDictionaryCandidates(TERM, deps)
    expect(run.mock.calls.length).toBeGreaterThan(calls)
  })

  test('nothing in either lookup: an empty answer (no row can match), without consulting the projection', async () => {
    const projectionReady = vi.fn(async () => true)
    const c = await resolveDictionaryCandidates(TERM, { run: lookupRun({}), status: async () => freshStatus(), projectionReady })
    expect(c).toMatchObject({ empty: true, domains: [], emailDomains: [], domainsLiteral: '[]', emailRevLiteral: '[]' })
    expect(projectionReady).not.toHaveBeenCalled()
  })

  test('email domains need proj_email_domain_rev on every part; without it, today\'s query. Without email domains the projection does not matter.', async () => {
    const notReady = vi.fn(async () => false)
    expect(await resolveDictionaryCandidates(TERM, { run: lookupRun({ exact: ['ledger.com'], email: ['ledger.com'] }), status: async () => freshStatus(), projectionReady: notReady })).toBeNull()
    expect(notReady).toHaveBeenCalledTimes(1)
    resetDictionaryPlanCache()
    const notReady2 = vi.fn(async () => false)
    const c = await resolveDictionaryCandidates(TERM, { run: lookupRun({ exact: ['ledger.com'] }), status: async () => freshStatus(), projectionReady: notReady2 })
    expect(c).not.toBeNull()
    expect(notReady2).not.toHaveBeenCalled()
  })
})

// ── the SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const cands = (over: Partial<DictionaryCandidates> = {}): DictionaryCandidates => ({
  domains: ['ledger.com', 'app.ledger.com'], emailDomains: ['ledger.com'], empty: false,
  domainsLiteral: "['ledger.com','app.ledger.com']", emailRevLiteral: "['moc.regdel']", ...over,
})
const WHERE = '1=1 AND ((domain = {dom0:String} OR url_host LIKE {domlk0:String})) AND is_noise = 0'
const CURSOR = ' AND (domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})'
const DOMAIN_ORDER = 'domain ASC,  email ASC, imported_at ASC, url ASC, password ASC'
const EMAIL_ORDER = 'email ASC, domain ASC, imported_at ASC, url ASC, password ASC'
const rowsInput = (over: Record<string, unknown> = {}) => ({
  where: WHERE, cursorClause: CURSOR, orderBy: DOMAIN_ORDER, dedupe: true, dedupeInWindow: false,
  rawCols: 'url, email, password, domain, imported_at', selectList: 'NORMALIZED, url AS _c_url',
  sortMaxMemoryBytes: 4_294_967_296, normColsSetting: 'prefer_column_name_to_alias = 1', candidates: cands(), ...over,
})
const OFFSET = "(_part, _part_offset) IN (SELECT _part, _part_offset FROM ulp.credentials WHERE reverse(email_domain) IN ['moc.regdel'] SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')"
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

describe('buildDictionaryRowsSql', () => {
  test('two disjoint branches over the UNCHANGED legacy WHERE and keyset clause, merged by the same ORDER BY', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(sql.split(`WHERE ${WHERE}${CURSOR}`).length - 1).toBe(2) // the legacy WHERE and keyset clause, verbatim, in both branches
    expect(sql).toContain(`${CURSOR} AND domain IN ['ledger.com','app.ledger.com']\nORDER BY`)
    expect(sql).toContain(`${CURSOR} AND domain NOT IN ['ledger.com','app.ledger.com'] AND ${OFFSET}\nORDER BY`)
    expect(count(sql, /UNION ALL/g)).toBe(1)
  })

  // ClickHouse 26.3: with a _part_offset filter, lazy materialization fails ("Not found column _part_offset in block") for every sort not
  // led by `domain`; turning it off for THAT branch fixes it. And `optimize_use_projections = 0` there destroys the pruning (9-16 s instead of
  // 0.3-1 s), so the offset sub-select pins projections ON and names the projection.
  test('pins the two ClickHouse 26.3 facts: lazy materialization off on the offset branch only, projections on inside its sub-select', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /query_plan_optimize_lazy_materialization = 0/g)).toBe(1)
    const [branch1, branch2] = sql.split('UNION ALL')
    expect(branch1).not.toContain('query_plan_optimize_lazy_materialization')
    expect(branch2).toContain('LIMIT {limit:UInt32} SETTINGS query_plan_optimize_lazy_materialization = 0')
    expect(sql).toContain("SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')")
    expect(sql).not.toContain('optimize_use_projections = 0')
  })

  test('a domain-led sort de-duplicates inside each branch, then again in the merge (the first N unique rows of the union lie in the union of the branches\' first N)', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(3)
    expect(count(sql, /LIMIT \{limit:UInt32\}/g)).toBe(3)
    expect(sql).not.toContain('windowLimit')
  })

  test('Unique with a sort not led by domain keeps the legacy window: each branch takes the window, the union is cut to it, then de-duplicated and limited', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ orderBy: EMAIL_ORDER, dedupeInWindow: true }))!
    expect(count(sql, /LIMIT \{windowLimit:UInt32\}/g)).toBe(3) // two branches and the cut of the union
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(1)
    expect(sql).toMatch(/LIMIT 1 BY content_key_hash\s+LIMIT \{limit:UInt32\}/)
    expect(sql.indexOf('LIMIT 1 BY')).toBeGreaterThan(sql.lastIndexOf('LIMIT {windowLimit:UInt32}'))
  })

  test('without Unique nothing is de-duplicated anywhere', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ dedupe: false }))!
    expect(sql).not.toContain('LIMIT 1 BY')
  })

  test('only candidate domains (no email domain): one branch, no UNION, no offset sub-select, no NOT IN', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ candidates: cands({ emailDomains: [], emailRevLiteral: '[]' }) }))!
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toContain('_part_offset')
    expect(sql).not.toContain('NOT IN')
    expect(sql).not.toContain('lazy_materialization')
    expect(sql).toContain("AND domain IN ['ledger.com','app.ledger.com']")
  })

  test('only email domains (no candidate domain): one branch through the projection, no domain predicate at all', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ candidates: cands({ domains: [], domainsLiteral: '[]' }) }))!
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toMatch(/domain (NOT )?IN \[/)
    expect(sql).toContain(OFFSET)
    expect(sql).toContain('lazy_materialization = 0')
  })

  test('the outer select, the sort memory limit and the NORM_COLS setting are the legacy query\'s, and the shape ends like it: `) AS t`', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(sql.startsWith('SELECT NORMALIZED, url AS _c_url\nFROM (')).toBe(true)
    expect(sql).toMatch(/\) AS t\s+SETTINGS max_execution_time = 300,\s+timeout_overflow_mode = 'throw',\s+http_wait_end_of_query = 1,\s+max_bytes_before_external_sort = 4294967296,\s+prefer_column_name_to_alias = 1$/)
  })

  test('the candidate lists are literals; the only placeholders are the route\'s own', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    const names = new Set([...sql.matchAll(/\{(\w+):/g)].map(m => m[1]))
    expect([...names].sort()).toEqual(['c_d', 'c_e', 'c_ia', 'c_pw', 'c_u', 'dom0', 'domlk0', 'limit'].sort())
  })

  test('null when the finished SQL would not fit max_query_size (the caller then runs today\'s query)', () => {
    const huge = `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS / 2)}']`
    expect(buildDictionaryRowsSql(rowsInput({ candidates: cands({ domainsLiteral: huge }) }))).toBeNull()
  })

  test('null when there is nothing to search (the caller answers an empty page without a query)', () => {
    expect(buildDictionaryRowsSql(rowsInput({ candidates: cands({ domains: [], emailDomains: [], empty: true, domainsLiteral: '[]', emailRevLiteral: '[]' }) }))).toBeNull()
  })
})

const totalsInput = (over: Record<string, unknown> = {}) => ({
  whereRaw: '1=1 AND ((domain = {dom0:String} OR url_host LIKE {domlk0:String}))', dedupe: true, hasUserFilter: true, onlyIf: 'is_noise = 0', candidates: cands(), ...over,
})

describe('buildDictionaryTotalsSql', () => {
  test('one aggregate per branch, combined by merging states, so the number equals the legacy single scan', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toContain('SELECT uniqIfMerge(part_total) AS total, sum(part_rows) AS raw_total')
    expect(count(sql, /uniqIfState\(content_key_hash, is_noise = 0\) AS part_total, count\(\) AS part_rows/g)).toBe(2)
    expect(count(sql, /UNION ALL/g)).toBe(1)
    expect(sql).toContain("AND domain IN ['ledger.com','app.ledger.com']")
    expect(sql).toContain(`AND domain NOT IN ['ledger.com','app.ledger.com'] AND ${OFFSET}`)
  })

  test('the branches use the raw WHERE: no cursor, and the noise filter moved inside the aggregate', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).not.toContain('{c_d') // no keyset clause
    const firstWhere = sql.slice(sql.indexOf('WHERE'), sql.indexOf('UNION ALL'))
    expect(firstWhere).not.toContain('is_noise') // the Declutter condition is inside the aggregate (uniqIfState), not in the WHERE
    expect(count(sql, /WHERE 1=1 AND/g)).toBe(2)
  })

  test.each([
    [{ dedupe: true, onlyIf: undefined }, 'uniqMerge(part_total) AS total', 'uniqState(content_key_hash) AS part_total'],
    [{ dedupe: false, onlyIf: 'is_noise = 0' }, 'sum(part_total) AS total', 'countIf(is_noise = 0) AS part_total'],
    [{ dedupe: false, onlyIf: undefined }, 'sum(part_total) AS total', 'count() AS part_total'],
  ])('%j', (over, outer, inner) => {
    const sql = buildDictionaryTotalsSql(totalsInput(over))!
    expect(sql).toContain(outer)
    expect(sql).toContain(inner)
  })

  test('keeps the counts\' own settings (partial counts on a timeout, no result cache) and the offset-branch settings', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toMatch(/SETTINGS optimize_trivial_count_query = 1,\s+max_execution_time = 300,\s+timeout_overflow_mode = 'break',\s+use_query_cache = 0$/)
    expect(sql).not.toContain('LIMIT')
    expect(count(sql, /query_plan_optimize_lazy_materialization = 0/g)).toBe(1)
    expect(sql).not.toContain('optimize_use_projections = 0')
  })

  test('is recognised by the older route tests as a totals query, and never as a data query', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toMatch(/AS raw_total/)
    expect(sql).not.toMatch(/\) AS t\s/)
  })

  test('single-branch forms like the rows query; null when oversize or empty', () => {
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ emailDomains: [], emailRevLiteral: '[]' }) }))).not.toContain('UNION ALL')
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ domainsLiteral: `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS)}']` }) }))).toBeNull()
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ domains: [], emailDomains: [], empty: true }) }))).toBeNull()
  })
})
