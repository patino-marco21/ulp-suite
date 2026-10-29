import { describe, expect, test } from 'vitest'
import { effectiveLoginType, loginTypeByDefault } from '@/lib/login-type-default'

const bare = { q: '', domain: '' }

describe('loginTypeByDefault — Email for a search, every type for a browse', () => {
  test('a search text starts on Email', () => {
    expect(loginTypeByDefault({ ...bare, q: 'term' })).toBe('email')
  })

  test('so does a domain', () => {
    expect(loginTypeByDefault({ ...bare, domain: 'example.test' })).toBe('email')
  })

  test('so does a text with a special character, a path or a space', () => {
    for (const q of ['a:b', 'host.test/login', 'two words', '/a/b.php']) expect(loginTypeByDefault({ ...bare, q })).toBe('email')
  })

  test('nothing typed is every type: the browse and the "View what this added" views show everything, and keep their free total', () => {
    expect(loginTypeByDefault(bare)).toBe('')
  })

  test('spaces alone are nothing typed', () => {
    expect(loginTypeByDefault({ q: '   ', domain: ' ' })).toBe('')
  })
})

describe('effectiveLoginType — a click is a choice that holds', () => {
  test('no choice made: the default of the search', () => {
    expect(effectiveLoginType(null, { ...bare, q: 'term' })).toBe('email')
    expect(effectiveLoginType(null, bare)).toBe('')
  })

  test('Username or Phone picked: that, whatever is typed', () => {
    expect(effectiveLoginType('username', { ...bare, q: 'term' })).toBe('username')
    expect(effectiveLoginType('phone', { ...bare, domain: 'example.test' })).toBe('phone')
  })

  test('"All types" picked ("") stays all types even though a search is typed: it is a choice, not an absence of one', () => {
    expect(effectiveLoginType('', { ...bare, q: 'term' })).toBe('')
  })

  test('Email picked on a bare browse is Email', () => {
    expect(effectiveLoginType('email', bare)).toBe('email')
  })
})
