import { describe, test, expect } from 'vitest'
import { wordLeaves, buildULPWhere, parseULPQuery } from '@/lib/ulp-search'

describe('wordLeaves', () => {
  test('the three text-index leaves of a word, on the plain columns', () => {
    expect(wordLeaves('w')).toBe('hasToken(url, {w:String}) OR hasToken(email, {w:String}) OR hasToken(password, {w:String})')
  })

  test('over the lowercased column when asked (a projection has no text index)', () => {
    expect(wordLeaves('w', name => `lower(${name})`))
      .toBe('hasToken(lower(url), {w:String}) OR hasToken(lower(email), {w:String}) OR hasToken(lower(password), {w:String})')
  })

  test('the word search is built from it, and its SQL is exactly what it was', () => {
    const { clause } = buildULPWhere(parseULPQuery('ledger'))
    expect(clause).toBe(`(${wordLeaves('tok0')} OR url_host LIKE {tlk0:String} OR email_domain LIKE {tlk0:String})`)
    expect(clause).toBe(
      '(hasToken(url, {tok0:String}) OR hasToken(email, {tok0:String}) OR hasToken(password, {tok0:String}) '
      + 'OR url_host LIKE {tlk0:String} OR email_domain LIKE {tlk0:String})',
    )
    const projected = buildULPWhere(parseULPQuery('ledger'), { caseInsensitiveTokens: true }).clause
    expect(projected).toContain(wordLeaves('tok0', name => `lower(${name})`))
  })
})
