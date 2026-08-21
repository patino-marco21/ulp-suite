import { describe, test, expect } from 'vitest'
import { domainMatches, emailDomainMatches, credentialMatchesDomain, matchModeToMatchType } from '@/lib/domain-match'

describe('domainMatches', () => {
  test('matches the exact domain', () => {
    expect(domainMatches('aave.com', 'aave.com')).toBe(true)
  })

  test('matches a subdomain of the monitored domain', () => {
    expect(domainMatches('app.aave.com', 'aave.com')).toBe(true)
    expect(domainMatches('stake.lido.fi', 'lido.fi')).toBe(true)
  })

  test('matches a multi-level subdomain', () => {
    expect(domainMatches('a.b.aave.com', 'aave.com')).toBe(true)
  })

  test('does not match a different domain that merely ends with the same letters', () => {
    expect(domainMatches('notaave.com', 'aave.com')).toBe(false)
    expect(domainMatches('evilaave.com', 'aave.com')).toBe(false)
  })

  test('does not match the reverse direction (monitoring the subdomain does not match the parent)', () => {
    expect(domainMatches('aave.com', 'app.aave.com')).toBe(false)
  })

  test('is case-insensitive and trims whitespace', () => {
    expect(domainMatches('APP.Aave.COM', ' aave.com ')).toBe(true)
  })

  test('returns false for empty inputs', () => {
    expect(domainMatches('', 'aave.com')).toBe(false)
    expect(domainMatches('aave.com', '')).toBe(false)
  })
})

describe('emailDomainMatches', () => {
  test('matches when the email domain equals the monitored domain', () => {
    expect(emailDomainMatches('user@aave.com', 'aave.com')).toBe(true)
  })

  test('matches when the email domain is a subdomain of the monitored domain', () => {
    expect(emailDomainMatches('user@mail.aave.com', 'aave.com')).toBe(true)
  })

  test('does not match a different email domain', () => {
    expect(emailDomainMatches('user@notaave.com', 'aave.com')).toBe(false)
  })

  test('returns false when there is no @ in the email', () => {
    expect(emailDomainMatches('not-an-email', 'aave.com')).toBe(false)
  })
})

describe('credentialMatchesDomain', () => {
  const cred = { domain: 'other.com', email: 'user@app.aave.com' }

  test('mode "url" only checks the credential domain', () => {
    expect(credentialMatchesDomain(cred, 'aave.com', 'url')).toBe(false)
    expect(credentialMatchesDomain({ ...cred, domain: 'app.aave.com' }, 'aave.com', 'url')).toBe(true)
  })

  test('mode "credential" only checks the email domain', () => {
    expect(credentialMatchesDomain(cred, 'aave.com', 'credential')).toBe(true)
    expect(credentialMatchesDomain({ ...cred, email: 'user@other.com' }, 'aave.com', 'credential')).toBe(false)
  })

  test('mode "both" matches on either', () => {
    expect(credentialMatchesDomain(cred, 'aave.com', 'both')).toBe(true)
    expect(credentialMatchesDomain({ domain: 'other.com', email: 'user@other.com' }, 'aave.com', 'both')).toBe(false)
  })
})

describe('matchModeToMatchType', () => {
  test('maps "credential" to "credential_email"', () => {
    expect(matchModeToMatchType('credential')).toBe('credential_email')
  })

  test('passes "url" and "both" through unchanged', () => {
    expect(matchModeToMatchType('url')).toBe('url')
    expect(matchModeToMatchType('both')).toBe('both')
  })
})
