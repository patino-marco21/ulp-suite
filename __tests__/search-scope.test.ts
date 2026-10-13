import { describe, test, expect } from 'vitest'
import {
  parseSearchScope, SEARCH_SCOPES, SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE,
} from '@/lib/search-scope'

describe('parseSearchScope', () => {
  test.each([
    [undefined, 'all'], [null, 'all'], ['', 'all'],
    ['all', 'all'], ['login', 'login'], ['login_contains', 'login_contains'],
  ])('%s -> %s', (raw, want) => {
    expect(parseSearchScope(raw)).toBe(want)
  })

  test.each(['LOGIN', 'Login', 'login ', ' login', 'password', 'url', '1', ' ', 'all,login', 'login_contain'])(
    '%j is refused', raw => {
      expect(parseSearchScope(raw)).toBeNull()
    },
  )

  test('a value that is not a string is refused', () => {
    expect(parseSearchScope(1)).toBeNull()
    expect(parseSearchScope({})).toBeNull()
    expect(parseSearchScope(true)).toBeNull()
    expect(parseSearchScope(['login'])).toBeNull()
  })
})

describe('the select', () => {
  test('one option per scope, in the order of SEARCH_SCOPES, All fields first', () => {
    expect(SEARCH_SCOPE_OPTIONS.map(o => o.value)).toEqual([...SEARCH_SCOPES])
    expect(SEARCH_SCOPE_OPTIONS[0]).toEqual({ value: 'all', label: 'All fields' })
  })

  test('the labels are the ones the owner chose', () => {
    expect(SEARCH_SCOPE_OPTIONS.map(o => o.label)).toEqual(['All fields', 'Login (whole word)', 'Login (contains)'])
  })

  test('every scope has a placeholder and the title explains the prefix', () => {
    for (const s of SEARCH_SCOPES) expect(SEARCH_SCOPE_PLACEHOLDERS[s].length).toBeGreaterThan(5)
    expect(SEARCH_SCOPE_PLACEHOLDERS.all).toBe('Search URL / email / password…')
    expect(SEARCH_SCOPE_TITLE).toContain('login:')
  })
})
