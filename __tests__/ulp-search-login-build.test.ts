import { describe, test, expect } from 'vitest'
import { parseULPQuery, buildULPWhere, buildULPWhereRegex, isIndexNeutralSearch, loginWords, type SearchScope } from '@/lib/ulp-search'

const build = (q: string, scope: SearchScope = 'all', opts: { caseInsensitiveTokens?: boolean } = {}) =>
  buildULPWhere(parseULPQuery(q, scope), opts)
const neutral = (q: string, scope: SearchScope = 'all', regex = false) => isIndexNeutralSearch(parseULPQuery(q, scope), regex)

describe('buildULPWhere — Login (whole word)', () => {
  test('a word is one hasToken on the login, lowercased', () => {
    const { clause, params } = build('Maria', 'login')
    expect(clause).toBe('(hasToken(email, {lw0:String}))')
    expect(params).toEqual({ lw0: 'maria' })
  })

  test('it never looks at the url, the password or the host columns', () => {
    const { clause } = build('maria, john.smith, a+b', 'login')
    for (const col of ['url', 'password', 'url_host', 'email_domain', 'domain =', 'LIKE']) expect(clause).not.toContain(col)
  })

  test('a dotted name needs every word, then the phrase', () => {
    const { clause, params } = build('John.Smith', 'login')
    expect(clause).toBe('(hasToken(email, {lw0_0:String}) AND hasToken(email, {lw0_1:String}) AND positionCaseInsensitive(email, {lp0:String}) > 0)')
    expect(params).toEqual({ lw0_0: 'john', lw0_1: 'smith', lp0: 'John.Smith' })
  })

  test('a word with an underscore or hyphen is a phrase too, not one token', () => {
    const { clause, params } = build('john_smith', 'login')
    expect(clause).toContain('hasToken(email, {lw0_0:String}) AND hasToken(email, {lw0_1:String}) AND positionCaseInsensitive(email, {lp0:String}) > 0')
    expect(params).toMatchObject({ lw0_0: 'john', lw0_1: 'smith', lp0: 'john_smith' })
  })

  test('a special value uses the words it has and the phrase', () => {
    const { clause } = build('a+b', 'login')
    expect(clause).toBe('(hasToken(email, {lw0_0:String}) AND hasToken(email, {lw0_1:String}) AND positionCaseInsensitive(email, {lp0:String}) > 0)')
  })

  test('a value without any word is only the phrase check', () => {
    expect(build('+++', 'login').clause).toBe('(positionCaseInsensitive(email, {lp0:String}) > 0)')
  })

  test('at most eight words become a hasToken each', () => {
    const { clause } = build('a.b.c.d.e.f.g.h.i.j', 'login')
    expect((clause.match(/hasToken/g) ?? []).length).toBe(8)
    expect(clause).toContain('positionCaseInsensitive(email, {lp0:String}) > 0')
  })

  test('the projection form lowercases the column for the word checks only', () => {
    expect(build('maria', 'login', { caseInsensitiveTokens: true }).clause).toBe('(hasToken(lower(email), {lw0:String}))')
    const dotted = build('john.smith', 'login', { caseInsensitiveTokens: true }).clause
    expect(dotted).toContain('hasToken(lower(email), {lw0_0:String})')
    expect(dotted).toContain('positionCaseInsensitive(email, {lp0:String}) > 0')
  })

  test('@host is the e-mail domain only, without the site clause', () => {
    const { clause, params } = build('@Example.COM', 'login')
    expect(clause).toBe('(email_domain = {edom0:String})')
    expect(params).toEqual({ edom0: 'example.com' })
  })

  test('a full address is an exact match on the login that ignores case', () => {
    const { clause, params } = build('john@example.com', 'login')
    expect(clause).toBe('(lower(email) = lower({exactemail0:String}))')
    expect(clause).not.toContain('hasToken')
    expect(params.exactemail0).toBe('john@example.com')
  })

  test('the login: prefix does the same in the all-fields default', () => {
    expect(build('login:Maria').clause).toBe('(hasToken(email, {lw0:String}))')
  })
})

describe('buildULPWhere — Login (contains)', () => {
  test('a word is a case-insensitive substring check on the login, as typed', () => {
    const { clause, params } = build('Maria', 'login_contains')
    expect(clause).toBe('(positionCaseInsensitive(email, {lc0:String}) > 0)')
    expect(params).toEqual({ lc0: 'Maria' })
  })

  test('a dotted name, a special value and an address are all one substring check', () => {
    for (const q of ['john.smith', 'a+b', 'john@example.com']) {
      expect(build(q, 'login_contains').clause).toBe('(positionCaseInsensitive(email, {lc0:String}) > 0)')
    }
  })

  test('@host is still the e-mail domain', () => {
    expect(build('@example.com', 'login_contains').clause).toBe('(email_domain = {edom0:String})')
  })

  test('the projection option changes nothing', () => {
    expect(build('maria', 'login_contains', { caseInsensitiveTokens: true })).toEqual(build('maria', 'login_contains'))
  })
})

describe('buildULPWhere — negation, mixing and the default scope', () => {
  test('a negated login term is wrapped in NOT', () => {
    expect(build('-login:maria').clause).toBe('NOT (hasToken(email, {lw0:String}))')
    expect(build('-maria', 'login_contains').clause).toBe('NOT (positionCaseInsensitive(email, {lc0:String}) > 0)')
  })

  test('terms of different scopes are ANDed with their own parameter names', () => {
    const { clause, params } = build('maria, login:lopez, ledger.com', 'login_contains')
    expect(clause).toBe('(positionCaseInsensitive(email, {lc0:String}) > 0) AND (hasToken(email, {lw1:String})) AND (positionCaseInsensitive(email, {lc2:String}) > 0)')
    expect(params).toEqual({ lc0: 'maria', lw1: 'lopez', lc2: 'ledger.com' })
  })

  test('the all-fields scope is the search it always was', () => {
    const { clause } = build('maria')
    expect(clause).toContain('hasToken(url, {tok0:String})')
    expect(clause).toContain('url_host LIKE')
    expect(build('ledger.com').clause).toContain('domain = {dom0:String}')
  })
})

describe('buildULPWhereRegex — scope', () => {
  test('a login scope matches the login column only', () => {
    expect(buildULPWhereRegex(parseULPQuery('^adm', 'login')).clause).toBe('(match(email, {rp0:String}))')
    expect(buildULPWhereRegex(parseULPQuery('^adm', 'login_contains')).clause).toBe('(match(email, {rp0:String}))')
    expect(buildULPWhereRegex(parseULPQuery('login:^adm')).clause).toBe('(match(email, {rp0:String}))')
  })

  test('the all-fields scope is unchanged', () => {
    expect(buildULPWhereRegex(parseULPQuery('^adm')).clause).toBe('(match(url, {rp0:String}) OR match(email, {rp0:String}) OR match(password, {rp0:String}))')
  })

  test('negation still wraps the term', () => {
    expect(buildULPWhereRegex(parseULPQuery('-^adm', 'login')).clause).toBe('NOT (match(email, {rp0:String}))')
  })
})

describe('isIndexNeutralSearch — scopes', () => {
  test('contains terms are neutral, whatever their type', () => {
    expect(neutral('maria', 'login_contains')).toBe(true)
    expect(neutral('john.smith, a+b', 'login_contains')).toBe(true)
  })

  test('whole-word terms are not, except an address and @host', () => {
    expect(neutral('maria', 'login')).toBe(false)
    expect(neutral('john.smith', 'login')).toBe(false)
    expect(neutral('a+b', 'login')).toBe(false)
    expect(neutral('john@example.com', 'login')).toBe(true)
    expect(neutral('@example.com', 'login')).toBe(true)
  })

  test('a mixed query is neutral only if every term is', () => {
    expect(neutral('maria, login:lopez', 'login_contains')).toBe(false)
    expect(neutral('maria, @example.com', 'login_contains')).toBe(true)
  })

  test('regex mode is never neutral and the all-fields rules are unchanged', () => {
    expect(neutral('maria', 'login_contains', true)).toBe(false)
    expect(neutral('ledger.com')).toBe(true)
    expect(neutral('hunter2')).toBe(false)
  })
})

describe('loginWords', () => {
  test('cuts a value the way the text index cuts a login, lowercased, without repeats', () => {
    expect(loginWords('John.Smith')).toEqual(['john', 'smith'])
    expect(loginWords('john_smith-88')).toEqual(['john', 'smith', '88'])
    expect(loginWords('a.a.b')).toEqual(['a', 'b'])
  })

  test('only ASCII case is folded; other letters stay as typed', () => {
    expect(loginWords('ИВАН.Smith')).toEqual(['ИВАН', 'smith'])
  })

  test('a value without a word has none', () => {
    expect(loginWords('+++')).toEqual([])
  })
})
