import { describe, test, expect } from 'vitest'
import { parseULPQuery, buildULPWhere, emailCasings } from '@/lib/ulp-search'

describe('emailCasings', () => {
  test('a dotted address gets all six casings, the lowercased value first', () => {
    expect(emailCasings('John.Smith@Gmail.com')).toEqual([
      'john.smith@gmail.com',
      'JOHN.SMITH@GMAIL.COM',
      'John.smith@gmail.com',
      'John.Smith@gmail.com',
      'JOHN.SMITH@gmail.com',
      'john.smith@Gmail.com',
    ])
  })

  test('repeats are removed (a single-word local part makes Title Case equal First letter)', () => {
    expect(emailCasings('maria@gmail.com')).toEqual([
      'maria@gmail.com', 'MARIA@GMAIL.COM', 'Maria@gmail.com', 'MARIA@gmail.com', 'maria@Gmail.com',
    ])
  })

  test('a value whose casings are all the same gives one', () => {
    expect(emailCasings('1@2.3')).toEqual(['1@2.3'])
  })

  test('a value without an @, or with nothing before it, is just lowercased', () => {
    expect(emailCasings('Maria')).toEqual(['maria'])
    expect(emailCasings('@Example.com')).toEqual(['@example.com'])
  })

  test('never more than six values, always the lowercased one first', () => {
    for (const a of ['a.b.c@d.e.f', 'X@Y.Z', 'name+tag@sub.example.com']) {
      const c = emailCasings(a)
      expect(c.length).toBeLessThanOrEqual(6)
      expect(c[0]).toBe(a.toLowerCase())
      expect(new Set(c).size).toBe(c.length)
    }
  })
})

describe('buildULPWhere — an address probes the common casings', () => {
  test('the clause is email IN (...) with one parameter per casing', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('John.Smith@example.com'))
    expect(clause).toBe('(email IN ({exactemail0:String}, {exactemail0c1:String}, {exactemail0c2:String}, {exactemail0c3:String}, {exactemail0c4:String}, {exactemail0c5:String}))')
    expect(Object.keys(params)).toHaveLength(6)
    expect(params.exactemail0).toBe('john.smith@example.com')
    expect(Object.values(params)).toContain('JOHN.SMITH@EXAMPLE.COM')
    expect(Object.values(params)).toContain('John.Smith@example.com')
  })

  test('a single casing keeps the plain equality', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('1@2.3'))
    expect(clause).toBe('(email = {exactemail0:String})')
    expect(params).toEqual({ exactemail0: '1@2.3' })
  })

  test('it applies in the Login (whole word) scope and under negation, and never uses LIKE or hasToken', () => {
    const login = buildULPWhere(parseULPQuery('john@example.com', 'login')).clause
    expect(login).toContain('email IN (')
    const negated = buildULPWhere(parseULPQuery('-john@example.com')).clause
    expect(negated.startsWith('NOT (email IN (')).toBe(true)
    for (const c of [login, negated]) {
      expect(c).not.toContain('LIKE')
      expect(c).not.toContain('hasToken')
    }
  })

  test('parameter names of different terms do not collide', () => {
    const { params } = buildULPWhere(parseULPQuery('a@example.com, b@example.com'))
    const keys = Object.keys(params)
    expect(new Set(keys).size).toBe(keys.length)
    expect(params.exactemail0).toBe('a@example.com')
    expect(params.exactemail1).toBe('b@example.com')
  })
})
