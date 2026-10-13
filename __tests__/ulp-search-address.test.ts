import { describe, expect, test } from 'vitest'
import { buildULPWhere, parseULPQuery, usesAddressIndex } from '@/lib/ulp-search'

describe('buildULPWhere — an address is an exact match that ignores case', () => {
  test('the clause is one lower(email) = lower(param), and the value goes in as typed', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('John.Smith@Example.com'))
    expect(clause).toBe('(lower(email) = lower({exactemail0:String}))')
    expect(params).toEqual({ exactemail0: 'John.Smith@Example.com' })
  })

  test('the same clause in the Login (whole word) scope', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('john@example.com', 'login'))
    expect(clause).toBe('(lower(email) = lower({exactemail0:String}))')
    expect(params.exactemail0).toBe('john@example.com')
  })

  test('negation wraps it, and it never uses LIKE or hasToken', () => {
    const negated = buildULPWhere(parseULPQuery('-john@example.com')).clause
    expect(negated).toBe('NOT (lower(email) = lower({exactemail0:String}))')
    for (const c of [negated, buildULPWhere(parseULPQuery('john@example.com')).clause]) {
      expect(c).not.toContain('LIKE')
      expect(c).not.toContain('hasToken')
    }
  })

  test('Login (contains) keeps its substring match for an address (complete in any case)', () => {
    const { clause } = buildULPWhere(parseULPQuery('john@example.com', 'login_contains'))
    expect(clause).toContain('positionCaseInsensitive(email,')
  })

  test('parameter names of different terms do not collide', () => {
    const { params } = buildULPWhere(parseULPQuery('a@example.com, b@example.com'))
    expect(params).toEqual({ exactemail0: 'a@example.com', exactemail1: 'b@example.com' })
  })
})

describe('usesAddressIndex — which searches need the projection setting', () => {
  test.each([
    ['john@example.com', 'all', true],
    ['john@example.com', 'login', true],
    ['-john@example.com', 'all', true],
    ['maria, john@example.com', 'all', true],
    ['john@example.com', 'login_contains', false],
    ['maria', 'all', false],
    ['ledger.com', 'all', false],
    ['@example.com', 'all', false],
    ['', 'all', false],
  ] as const)('%s in scope %s is %s', (q, scope, expected) => {
    expect(usesAddressIndex(parseULPQuery(q, scope))).toBe(expected)
  })

  test('regex mode never uses the address clause', () => {
    expect(usesAddressIndex(parseULPQuery('john@example.com'), true)).toBe(false)
  })
})
