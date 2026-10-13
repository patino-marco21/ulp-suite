import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  wordTermFromQuery, wordTextBranch, resolveWordCandidates, resolveDictionaryCandidates, resetDictionaryPlanCache, type WordTerm,
} from '@/lib/search-dictionary-plan'
import { buildULPWhere, parseULPQuery, wordLeaves } from '@/lib/ulp-search'
import type { DictionaryStatus } from '@/lib/search-dictionary'

const freshStatus = (fp = 'fp-1'): DictionaryStatus => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
const notFresh = (state: DictionaryStatus['state']): DictionaryStatus => ({ ...freshStatus(), state, fingerprint: null })
const WORD: WordTerm = { word: 'ledger', like: '%ledger%' }
const ready = async () => true

function lookupRun(data: { host?: string[]; email?: string[] }) {
  return vi.fn(async (sql: string, _params: Record<string, unknown> = {}) => {
    if (sql.includes('WHERE url_host LIKE {like:String}')) return (data.host ?? []).map(domain => ({ domain }))
    if (sql.includes('FROM ulp.search_emaildomain_dict')) return (data.email ?? []).map(email_domain => ({ email_domain }))
    return []
  })
}
const deps = (run: ReturnType<typeof lookupRun>, over: Record<string, unknown> = {}) => ({ run, status: async () => freshStatus(), projectionReady: ready, ...over })

beforeEach(() => { resetDictionaryPlanCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('wordTermFromQuery', () => {
  test('one positive word gives the lowercase word and the very LIKE pattern the legacy predicate uses', () => {
    expect(wordTermFromQuery('ledger', false)).toEqual(WORD)
    expect(wordTermFromQuery('Ledger', false)).toEqual(WORD)
    expect(wordTermFromQuery('abc123', false)).toEqual({ word: 'abc123', like: '%abc123%' })
    expect(wordTermFromQuery('  ledger ', false)).toEqual(WORD)
  })

  test('the values are the ones buildULPWhere puts in its parameters, so the two cannot drift apart', () => {
    for (const q of ['ledger', 'Maria', 'x9']) {
      const { params } = buildULPWhere(parseULPQuery(q))
      expect(wordTermFromQuery(q, false)).toEqual({ word: params.tok0, like: params.tlk0 })
    }
  })

  test.each([
    ['a domain', 'ledger.com'],
    ['an address', 'john@example.test'],
    ['an @domain', '@example.test'],
    ['two terms', 'ledger,trezor'],
    ['a negated term', '-ledger'],
    ['a login: prefix', 'login:ledger'],
    ['a word with a hyphen', 'my-ledger'],
    ['a word with an underscore', 'my_ledger'],
    ['a text with a special character', '/ledger/login.php'],
    ['a text with a space', 'my ledger'],
    ['nothing', ''],
  ])('not eligible: %s', (_name, q) => {
    expect(wordTermFromQuery(q, false)).toBeNull()
  })

  test('regex mode and the login scopes are never eligible', () => {
    expect(wordTermFromQuery('ledger', true)).toBeNull()
    expect(wordTermFromQuery('ledger', false, 'login')).toBeNull()
    expect(wordTermFromQuery('ledger', false, 'login_contains')).toBeNull()
    expect(wordTermFromQuery('ledger', false, 'all')).toEqual(WORD)
  })
})

describe('wordTextBranch', () => {
  const LEAVES = wordLeaves('tok0')
  const QCLAUSE = buildULPWhere(parseULPQuery('ledger')).clause
  const WHERE = `1=1 AND (${QCLAUSE}) AND is_noise = 0`

  test('the same WHERE with the search replaced by the three text-index leaves alone, and the exclusion the other branches carry', () => {
    expect(wordTextBranch(WHERE, QCLAUSE)).toEqual({
      where: `1=1 AND (${LEAVES}) AND is_noise = 0`,
      exclude: ` AND NOT (${LEAVES})`,
    })
    expect(wordTextBranch(WHERE, QCLAUSE)!.where).not.toContain('url_host LIKE')
  })

  test('everything else in the WHERE is left exactly as it was, even text that looks like a replacement pattern', () => {
    const base = `1=1 AND (${QCLAUSE}) AND source_file = '$&$1$$' AND password_length >= 8`
    expect(wordTextBranch(base, QCLAUSE)!.where).toBe(`1=1 AND (${LEAVES}) AND source_file = '$&$1$$' AND password_length >= 8`)
  })

  test('null when the search clause is not in the WHERE exactly once: branch T would repeat the others (a row counted twice)', () => {
    expect(wordTextBranch('1=1 AND is_noise = 0', QCLAUSE)).toBeNull()
    expect(wordTextBranch(`(${QCLAUSE}) AND (${QCLAUSE})`, QCLAUSE)).toBeNull()
  })
})

describe('resolveWordCandidates', () => {
  test('two lookups only (hosts and e-mail domains), the word\'s own LIKE pattern, a cap one above each limit; sorted, de-duplicated, the blank domain kept', async () => {
    const run = lookupRun({ host: ['ledger.com', 'coinledger.com', 'ledger.com', ''], email: ['ledger.com', 'a.ledger.com'] })
    const c = await resolveWordCandidates(WORD, deps(run))
    expect(run).toHaveBeenCalledTimes(2)
    const params = run.mock.calls.map(call => call[1])
    expect(params).toEqual(expect.arrayContaining([{ like: '%ledger%', cap: 3001 }, { like: '%ledger%', cap: 301 }]))
    expect(c).toEqual({
      domains: ['', 'coinledger.com', 'ledger.com'],
      emailDomains: ['a.ledger.com', 'ledger.com'],
      empty: false,
      domainsLiteral: "['','coinledger.com','ledger.com']",
      emailRevLiteral: "['moc.regdel.a','moc.regdel']",
    })
  })

  test('every lookup has a time limit and bypasses the ClickHouse result cache', async () => {
    const run = lookupRun({ host: ['ledger.com'] })
    await resolveWordCandidates(WORD, deps(run))
    for (const [sql] of run.mock.calls) {
      expect(sql).toContain('max_execution_time = 8')
      expect(sql).toContain('use_query_cache = 0')
    }
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'] as const)('a dictionary that is %s means today\'s query, and no lookup runs', async state => {
    const run = lookupRun({ host: ['ledger.com'] })
    expect(await resolveWordCandidates(WORD, { run, status: async () => notFresh(state), projectionReady: ready })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('SEARCH_DICTIONARY=0 and SEARCH_TOKEN_PLANS=off: null, and not even the status is read', async () => {
    for (const [name, value] of [['SEARCH_DICTIONARY', '0'], ['SEARCH_TOKEN_PLANS', 'off']]) {
      vi.stubEnv(name, value)
      const status = vi.fn(async () => freshStatus())
      expect(await resolveWordCandidates(WORD, { run: lookupRun({}), status, projectionReady: ready }), name).toBeNull()
      expect(status).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
    }
  })

  test('a repeat reuses the answer; another fingerprint or another word looks again; the domain cache and the word cache are separate', async () => {
    const run = lookupRun({ host: ['ledger.com'] })
    await resolveWordCandidates(WORD, deps(run))
    await resolveWordCandidates(WORD, deps(run))
    expect(run).toHaveBeenCalledTimes(2)
    await resolveWordCandidates(WORD, { run, status: async () => freshStatus('fp-2'), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(4)
    await resolveWordCandidates({ word: 'trezor', like: '%trezor%' }, { run, status: async () => freshStatus('fp-2'), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(6)
    // a domain term whose text equals the word never reuses the word's answer
    await resolveDictionaryCandidates({ exact: 'ledger', suffix: '%.ledger', like: '%ledger%' }, { run, status: async () => freshStatus('fp-2'), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(10)
  })

  test('the rows request and the totals request the page sends together share ONE lookup (the in-flight promise)', async () => {
    const run = lookupRun({ host: ['ledger.com'], email: ['ledger.com'] })
    const [a, b] = await Promise.all([resolveWordCandidates(WORD, deps(run)), resolveWordCandidates(WORD, deps(run))])
    expect(run).toHaveBeenCalledTimes(2)
    expect(a).toBe(b)
  })

  describe('caps: above any of them the answer is "use today\'s query", and that verdict is remembered too', () => {
    test('more candidate domains than SEARCH_DICT_MAX_DOMAINS', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_DOMAINS', '2')
      const run = lookupRun({ host: ['a.com', 'b.com', 'c.com'] })
      expect(await resolveWordCandidates(WORD, deps(run))).toBeNull()
      expect(run.mock.calls.find(c => String(c[0]).includes('search_host_dict'))![1]).toMatchObject({ cap: 3 })
      expect(await resolveWordCandidates(WORD, deps(run))).toBeNull()
      expect(run).toHaveBeenCalledTimes(2)
    })

    test('more e-mail domains than SEARCH_DICT_MAX_EMAIL_DOMAINS', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_EMAIL_DOMAINS', '1')
      expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'], email: ['a.ledger.com', 'b.ledger.com'] })))).toBeNull()
    })

    test('a list of D that would not fit the SQL (90,000 bytes) and a list of E above 20,000 bytes', async () => {
      const longD = Array.from({ length: 2000 }, (_, i) => `d${i}.${'x'.repeat(50)}.test`)
      expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: longD })))).toBeNull()
      resetDictionaryPlanCache()
      const longE = Array.from({ length: 290 }, (_, i) => `${'y'.repeat(70)}${i}.ledger.com`)
      expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'], email: longE })))).toBeNull()
    })
  })

  test('a lookup that fails or times out means today\'s query, with one warning, and is not retried for a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValue(new Error('Code: 159. Timeout exceeded: TIMEOUT_EXCEEDED'))
    let t = 0
    const d = { run, now: () => t, status: async () => freshStatus(), projectionReady: ready }
    expect(await resolveWordCandidates(WORD, d)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const calls = run.mock.calls.length
    t = 59_000
    expect(await resolveWordCandidates(WORD, d)).toBeNull()
    expect(run.mock.calls.length).toBe(calls)
    t = 61_000
    await resolveWordCandidates(WORD, d)
    expect(run.mock.calls.length).toBeGreaterThan(calls)
  })

  test('nothing in either lookup: an answer with empty lists (the text indexes may still match), without consulting the projection', async () => {
    const projectionReady = vi.fn(async () => true)
    const c = await resolveWordCandidates(WORD, { run: lookupRun({}), status: async () => freshStatus(), projectionReady })
    expect(c).toMatchObject({ empty: true, domains: [], emailDomains: [], domainsLiteral: '[]', emailRevLiteral: '[]' })
    expect(projectionReady).not.toHaveBeenCalled()
  })

  test('e-mail domains need proj_email_domain_rev on every part; without it, today\'s query. Without e-mail domains the projection does not matter.', async () => {
    const notReady = vi.fn(async () => false)
    expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'], email: ['ledger.com'] }), { projectionReady: notReady }))).toBeNull()
    expect(notReady).toHaveBeenCalledTimes(1)
    resetDictionaryPlanCache()
    const notReady2 = vi.fn(async () => false)
    expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'] }), { projectionReady: notReady2 }))).not.toBeNull()
    expect(notReady2).not.toHaveBeenCalled()
  })
})
