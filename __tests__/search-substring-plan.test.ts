import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  substringNeedleFromQuery, wholeTokens, resolveSubstringChoice, substringConjunct, SUBSTRING_PARAM,
} from '@/lib/search-substring-plan'
import { resetSearchPlanGateCache } from '@/lib/search-plan-gate'
import { buildULPWhere, parseULPQuery } from '@/lib/ulp-search'

beforeEach(() => { resetSearchPlanGateCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('substringNeedleFromQuery', () => {
  test('one positive text with a special character, looked up in every column, gives the needle of the legacy LIKE', () => {
    expect(substringNeedleFromQuery('/ledger/login.php', false)).toBe('/ledger/login.php')
    expect(substringNeedleFromQuery('a b', false)).toBe('a b')
    expect(substringNeedleFromQuery('  user:pass  ', false)).toBe('user:pass')
  })

  test('the needle is what buildULPWhere puts between the percent signs of its parameter, so the two cannot drift apart', () => {
    for (const q of ['/ledger/login.php', 'user:pass', 'a b c', 'x?y=z', '100%']) {
      const { params } = buildULPWhere(parseULPQuery(q))
      expect(`%${substringNeedleFromQuery(q, false)}%`).toBe(params.lk0)
    }
  })

  test.each([
    ['a word', 'ledger'],
    ['a domain', 'ledger.com'],
    ['an address', 'john@example.test'],
    ['an @domain', '@example.test'],
    ['two terms', '/ledger/a,/ledger/b'],
    ['a negated term', '-/ledger/login.php'],
    ['a login: prefix', 'login:/ledger/login.php'],
    ['nothing', ''],
  ])('not eligible: %s', (_name, q) => {
    expect(substringNeedleFromQuery(q, false)).toBeNull()
  })

  test('regex mode and the login scopes are never eligible', () => {
    expect(substringNeedleFromQuery('/ledger/login.php', true)).toBeNull()
    expect(substringNeedleFromQuery('/ledger/login.php', false, 'login')).toBeNull()
    expect(substringNeedleFromQuery('/ledger/login.php', false, 'login_contains')).toBeNull()
    expect(substringNeedleFromQuery('/ledger/login.php', false, 'all')).toBe('/ledger/login.php')
  })
})

describe('wholeTokens', () => {
  const t = wholeTokens

  test('the words between two separators', () => {
    expect(t('/ledger/login.php')).toEqual(['ledger', 'login'])
    expect(t('a b c d')).toEqual(['b', 'c'])
    expect(t('x?user=ledger&y')).toEqual(['user', 'ledger'])
  })

  test('a word at either end of the needle is not whole: the haystack may continue it', () => {
    expect(t('login.php')).toEqual([])
    expect(t('abc')).toEqual([])
    expect(t('.abc')).toEqual([])
    expect(t('abc.')).toEqual([])
    expect(t('x/login/')).toEqual(['login'])
  })

  test('a LIKE wildcard or the escape beside a word makes it not whole; one further away does not matter', () => {
    expect(t('a/%login/b')).toEqual([])
    expect(t('a/login%/b')).toEqual([])
    expect(t('/login_/')).toEqual([])
    expect(t('/log_in/')).toEqual([])
    expect(t('/\\login/')).toEqual([])
    expect(t('/login\\/')).toEqual([])
    expect(t('/%/login/')).toEqual(['login'])
    expect(t('/_/login/')).toEqual(['login'])
  })

  test('a non-ASCII neighbour continues the token, so the word is not whole', () => {
    expect(t('/éabc/')).toEqual([])
    expect(t('/abcé/')).toEqual([])
    expect(t('/😀abc/x')).toEqual([])
    expect(t('é.login.é')).toEqual(['login'])
  })

  test('lowercased, de-duplicated, in order of appearance', () => {
    expect(t('/Login/PHP/login/')).toEqual(['login', 'php'])
  })

  test('digits and mixed runs are words; hyphens, colons, spaces and control characters are separators', () => {
    expect(t('/a1b2/c3/')).toEqual(['a1b2', 'c3'])
    expect(t('x-abc-y')).toEqual(['abc'])
    expect(t('x:abc:y')).toEqual(['abc'])
    expect(t('x abc y')).toEqual(['abc'])
    expect(t('x\tabc\ny')).toEqual(['abc'])
  })
})

describe('resolveSubstringChoice', () => {
  const counts = (byWord: Record<string, number | null>) => vi.fn(async (_sql: string, params: Record<string, unknown> = {}) => {
    const v = byWord[String(params.tok)]
    if (v === null) throw new Error('probe failed')
    return [{ hits: String(v ?? 50_001) }]
  })

  test('takes the rarest whole word', async () => {
    const run = counts({ ledger: 120, login: 40_000 })
    expect(await resolveSubstringChoice('/ledger/login.php', { run })).toEqual({ token: 'ledger', hits: 120 })
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('the gate: exactly 50,000 hits passes, one more does not', async () => {
    expect(await resolveSubstringChoice('/ledger/zz', { run: counts({ ledger: 50_000 }) })).toEqual({ token: 'ledger', hits: 50_000 })
    resetSearchPlanGateCache()
    expect(await resolveSubstringChoice('/ledger/zz', { run: counts({ ledger: 50_001 }) })).toBeNull()
  })

  test('no whole word: today\'s query, and no probe at all', async () => {
    const run = counts({})
    expect(await resolveSubstringChoice('a b', { run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('probes at most 8 words, the longest first', async () => {
    const needle = '/' + ['aa', 'bbbbbbbbb', 'ccccccc', 'ddd', 'eeeeeeeeee', 'ffff', 'gggggg', 'hhhhh', 'iiiiiiii', 'jjjjjjjjjj'].join('/') + '/x'
    const run = counts({})
    await resolveSubstringChoice(needle, { run })
    const probed = run.mock.calls.map(c => String(c[1]?.tok))
    expect(probed).toHaveLength(8)
    expect(probed).not.toContain('aa')
    expect(probed).not.toContain('ddd')
    expect(probed[0].length).toBeGreaterThanOrEqual(probed[7].length)
  })

  test('a probe that failed is ignored while another word has a count; all failed means today\'s query', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveSubstringChoice('/ledger/login.php', { run: counts({ ledger: null, login: 700 }) })).toEqual({ token: 'login', hits: 700 })
    resetSearchPlanGateCache()
    expect(await resolveSubstringChoice('/ledger/login.php', { run: counts({ ledger: null, login: null }) })).toBeNull()
  })

  test('the kill switch: null, and nothing is probed', async () => {
    vi.stubEnv('SEARCH_TOKEN_PLANS', 'off')
    const run = counts({ ledger: 1 })
    expect(await resolveSubstringChoice('/ledger/zz', { run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('a word seen before (in another text) is not probed again', async () => {
    const run = counts({ ledger: 5, other: 9 })
    await resolveSubstringChoice('/ledger/zz', { run })
    await resolveSubstringChoice('/other/ledger/zz', { run })
    expect(run.mock.calls.map(c => String(c[1]?.tok)).sort()).toEqual(['ledger', 'other'])
  })
})

describe('substringConjunct', () => {
  test('the word search\'s own three leaves on the plain columns, one parameter, ANDed on', () => {
    const c = substringConjunct('ledger')
    expect(SUBSTRING_PARAM).toBe('sbt')
    expect(c.sql).toBe(' AND (hasToken(url, {sbt:String}) OR hasToken(email, {sbt:String}) OR hasToken(password, {sbt:String}))')
    expect(c.params).toEqual({ sbt: 'ledger' })
  })
})
