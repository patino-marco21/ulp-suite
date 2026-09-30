import { describe, test, expect } from 'vitest'
import {
  buildCandidateColumnWhereClause,
  buildEmailDomainRevCandidateWhereClause,
} from '@/lib/domain-match'

describe('buildEmailDomainRevCandidateWhereClause', () => {
  test('rewrites equality and suffix into reversed-key forms a prefix range can prune', () => {
    const { clause } = buildEmailDomainRevCandidateWhereClause(['aave.com'])
    expect(clause).toBe(
      '((reverse(email_domain) = reverse({email_domainEq0:String}) OR startsWith(reverse(email_domain), reverse({email_domainSuffix0:String}))))',
    )
  })

  test('never uses the un-prunable endsWith(email_domain, ...) form', () => {
    const { clause } = buildEmailDomainRevCandidateWhereClause(['trezor.io', 'ledger.com'])
    expect(clause).not.toContain('endsWith')
    expect(clause).not.toContain('email_domain = ') // the original form's bare equality
  })

  test('uses exactly the same parameter names and values as the original email_domain builder', () => {
    const domains = [' AAVE.com ', 'trezor.io']
    expect(buildEmailDomainRevCandidateWhereClause(domains).params)
      .toEqual(buildCandidateColumnWhereClause('email_domain', domains).params)
  })

  test('the suffix param is dot-prefixed, so a domain merely ending with the same letters cannot false-match', () => {
    const { params } = buildEmailDomainRevCandidateWhereClause(['trezor.io'])
    expect(params.email_domainEq0).toBe('trezor.io')
    expect(params.email_domainSuffix0).toBe('.trezor.io')
  })

  test('ORs every domain in the set', () => {
    const { clause, params } = buildEmailDomainRevCandidateWhereClause(['a.com', 'b.com'])
    expect(clause).toContain(' OR ')
    expect(Object.keys(params).sort()).toEqual([
      'email_domainEq0', 'email_domainEq1', 'email_domainSuffix0', 'email_domainSuffix1',
    ])
  })

  test('returns a never-true clause for an empty domain list', () => {
    expect(buildEmailDomainRevCandidateWhereClause([]).clause).toBe('0')
  })

  test('leaves the original builder untouched (it stays the fallback plan)', () => {
    expect(buildCandidateColumnWhereClause('email_domain', ['aave.com']).clause)
      .toBe('((email_domain = {email_domainEq0:String} OR endsWith(email_domain, {email_domainSuffix0:String})))')
  })
})
