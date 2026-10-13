import { describe, test, expect } from 'vitest'
import { parseULPQuery } from '@/lib/ulp-search'

describe('parseULPQuery — scope', () => {
  test('a plain term is in the default scope, which defaults to all', () => {
    expect(parseULPQuery('maria')[0].scope).toBe('all')
    expect(parseULPQuery('maria', 'login')[0].scope).toBe('login')
    expect(parseULPQuery('maria', 'login_contains')[0].scope).toBe('login_contains')
  })

  test('login: sets the scope to login, whatever the default is, and is removed from the value', () => {
    for (const d of ['all', 'login', 'login_contains'] as const) {
      expect(parseULPQuery('login:maria', d)[0]).toMatchObject({ type: 'token', value: 'maria', scope: 'login', negate: false })
    }
  })

  test('the prefix is case-insensitive and may be followed by spaces', () => {
    expect(parseULPQuery('LOGIN:Maria')[0]).toMatchObject({ value: 'Maria', scope: 'login' })
    expect(parseULPQuery('Login:  maria')[0]).toMatchObject({ value: 'maria', scope: 'login' })
  })

  test('-login:name negates; the - comes before the prefix', () => {
    expect(parseULPQuery('-login:test')[0]).toMatchObject({ negate: true, value: 'test', scope: 'login' })
  })

  test('the value after the prefix is classified like any other', () => {
    expect(parseULPQuery('login:john.smith')[0]).toMatchObject({ type: 'domain', value: 'john.smith', scope: 'login' })
    expect(parseULPQuery('login:john@example.com')[0]).toMatchObject({ type: 'email_full', scope: 'login', emailDomain: 'example.com' })
    expect(parseULPQuery('login:@example.com')[0]).toMatchObject({ type: 'email_dom', scope: 'login', emailDomain: 'example.com' })
    expect(parseULPQuery('login:a+b')[0]).toMatchObject({ type: 'like', value: 'a+b', scope: 'login' })
  })

  test('a term that is empty after the prefix is dropped', () => {
    expect(parseULPQuery('login:')).toEqual([])
    expect(parseULPQuery('login:   , maria')).toHaveLength(1)
  })

  test('terms with and without the prefix mix in one query', () => {
    const tokens = parseULPQuery('maria, login:lopez, -login:test', 'login_contains')
    expect(tokens.map(t => [t.value, t.scope, t.negate])).toEqual([
      ['maria', 'login_contains', false],
      ['lopez', 'login', false],
      ['test', 'login', true],
    ])
  })

  test('the word login without a colon is an ordinary term', () => {
    expect(parseULPQuery('login')[0]).toMatchObject({ type: 'token', value: 'login', scope: 'all' })
  })

  test('the classification of an ordinary term is unchanged', () => {
    expect(parseULPQuery('ledger.com')[0]).toMatchObject({ type: 'domain', scope: 'all' })
    expect(parseULPQuery('passw0rd!')[0]).toMatchObject({ type: 'like', scope: 'all' })
    expect(parseULPQuery('John@Gmail.COM')[0]).toMatchObject({ type: 'email_full', emailDomain: 'gmail.com', scope: 'all' })
  })
})
