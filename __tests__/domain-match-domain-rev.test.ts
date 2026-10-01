import { describe, test, expect } from 'vitest'
import {
  buildCandidateColumnWhereClause,
  buildDomainRevCandidateWhereClause,
  buildEmailDomainRevCandidateWhereClause,
  buildReversedCandidateWhereClause,
} from '@/lib/domain-match'

describe('buildDomainRevCandidateWhereClause', () => {
  test('rewrites equality and suffix into reversed-key forms a prefix range can prune', () => {
    const { clause } = buildDomainRevCandidateWhereClause(['aave.com'])
    expect(clause).toBe(
      '((reverse(domain) = reverse({domainEq0:String}) OR startsWith(reverse(domain), reverse({domainSuffix0:String}))))',
    )
  })

  test('never uses the un-prunable endsWith(domain, ...) form or the bare domain equality', () => {
    const { clause } = buildDomainRevCandidateWhereClause(['trezor.io', 'ledger.com'])
    expect(clause).not.toContain('endsWith')
    expect(clause).not.toMatch(/(^|[^(])domain = /) // the original form's bare equality
  })

  test('uses exactly the same parameter names and values as the original domain builder', () => {
    const domains = [' AAVE.com ', 'trezor.io']
    expect(buildDomainRevCandidateWhereClause(domains).params)
      .toEqual(buildCandidateColumnWhereClause('domain', domains).params)
  })

  test('the suffix param is dot-prefixed, so a domain merely ending with the same letters cannot false-match', () => {
    const { params } = buildDomainRevCandidateWhereClause(['trezor.io'])
    expect(params.domainEq0).toBe('trezor.io')
    expect(params.domainSuffix0).toBe('.trezor.io')
  })

  test('ORs every domain in the set', () => {
    const { clause, params } = buildDomainRevCandidateWhereClause(['a.com', 'b.com'])
    expect(clause).toContain(' OR ')
    expect(Object.keys(params).sort()).toEqual(['domainEq0', 'domainEq1', 'domainSuffix0', 'domainSuffix1'])
  })

  test('returns a never-true clause for an empty domain list', () => {
    expect(buildDomainRevCandidateWhereClause([]).clause).toBe('0')
  })

  test('leaves the original builder untouched (it stays the fallback plan)', () => {
    expect(buildCandidateColumnWhereClause('domain', ['aave.com']).clause)
      .toBe('((domain = {domainEq0:String} OR endsWith(domain, {domainSuffix0:String})))')
  })

  test('is the generic reversed builder for the domain column, and the email wrapper still targets email_domain', () => {
    expect(buildDomainRevCandidateWhereClause(['a.com'])).toEqual(buildReversedCandidateWhereClause('domain', ['a.com']))
    expect(buildEmailDomainRevCandidateWhereClause(['a.com']).clause).toContain('reverse(email_domain)')
    expect(buildEmailDomainRevCandidateWhereClause(['a.com']).clause).not.toContain('reverse(domain)')
  })
})
