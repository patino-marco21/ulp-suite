import { vi, describe, test, expect } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
  NORM_EMAIL_EXPR: 'email',
}))

import {
  domainMatches, emailDomainMatches, credentialMatchesDomain, matchModeToMatchType,
  domainSuffixChain, buildMonitorDomainIndex, matchCredentialsAgainstIndex,
  matchConditionSQL, buildDomainSetWhereClause, credentialFingerprint,
} from '@/lib/domain-match'

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

describe('emailDomainMatches — corrupted-row regression table', () => {
  // Locks in the exact behavior lib/monitor-rescan-cron.ts's SQL email-domain
  // extraction must agree with (matchConditionSQL's emailDomainExpr, verified
  // against a live ClickHouse instance against this same table). This function
  // is the authoritative oracle — see lib/ulp-normalize.ts's docstring on
  // Cases A-D for why raw email columns can lack '@' entirely.
  const monitored = 'google.com'

  test('an email with no "@" does not match, even when it equals the monitored domain', () => {
    expect(emailDomainMatches('google.com', monitored)).toBe(false)
  })

  test('an email with no "@" does not match, even when it looks like a subdomain', () => {
    expect(emailDomainMatches('accounts.google.com', monitored)).toBe(false)
  })

  test('uses the domain after the LAST "@" when the email contains more than one', () => {
    expect(emailDomainMatches('a@b@google.com', monitored)).toBe(true)
  })

  test('matches a subdomain of the monitored domain', () => {
    expect(emailDomainMatches('u@app.google.com', monitored)).toBe(true)
  })

  test('does not match an unrelated domain', () => {
    expect(emailDomainMatches('user@notgoogle.com', monitored)).toBe(false)
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

describe('domainSuffixChain', () => {
  test('returns every dot-boundary suffix, longest first', () => {
    expect(domainSuffixChain('stake.lido.fi')).toEqual(['stake.lido.fi', 'lido.fi', 'fi'])
  })

  test('returns a single-element chain for a bare label', () => {
    expect(domainSuffixChain('localhost')).toEqual(['localhost'])
  })

  test('returns an empty chain for an empty string', () => {
    expect(domainSuffixChain('')).toEqual([])
  })
})

describe('buildMonitorDomainIndex + matchCredentialsAgainstIndex', () => {
  const monitors = [
    { id: 1, domains: ['aave.com'], match_mode: 'both' as const },
    { id: 2, domains: ['lido.fi'], match_mode: 'url' as const },
    { id: 3, domains: ['example.com'], match_mode: 'credential' as const },
  ]
  const index = buildMonitorDomainIndex(monitors)

  test('matches a subdomain via URL domain (mode both)', () => {
    const cred = { url: 'https://app.aave.com/login', email: 'user@other.org', password: 'x', domain: 'app.aave.com' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches.map(m => m.monitorId)).toEqual([1])
  })

  test('does not match a mode "url" monitor via email domain', () => {
    const cred = { url: 'https://other.org', email: 'user@stake.lido.fi', password: 'x', domain: 'other.org' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches).toEqual([])
  })

  test('matches a mode "credential" monitor via email subdomain, not URL', () => {
    const cred = { url: 'https://other.org', email: 'user@mail.example.com', password: 'x', domain: 'other.org' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches.map(m => m.monitorId)).toEqual([3])
  })

  test('a credential matching two monitors produces two entries, each once', () => {
    const cred = { url: 'https://app.aave.com', email: 'user@mail.example.com', password: 'x', domain: 'app.aave.com' }
    const matches = matchCredentialsAgainstIndex([cred], index)
    expect(matches.map(m => m.monitorId).sort()).toEqual([1, 3])
  })

  test('returns no matches when the index is empty', () => {
    const cred = { url: 'https://aave.com', email: 'user@aave.com', password: 'x', domain: 'aave.com' }
    expect(matchCredentialsAgainstIndex([cred], new Map())).toEqual([])
  })
})

describe('matchConditionSQL', () => {
  test('mode "url" is just the domain condition', () => {
    expect(matchConditionSQL('url')).toBe(
      '((domain) = {domain:String} OR endsWith((domain), {domainSuffix:String}))'
    )
  })

  test('mode "credential" guards against missing "@" and uses the last "@"', () => {
    const sql = matchConditionSQL('credential')
    expect(sql).toContain("position(lower(email), '@') > 0 AND")
    expect(sql).toContain("arrayElement(splitByChar('@', lower(email)), -1)")
  })

  test('mode "both" ORs the url and credential conditions', () => {
    const sql = matchConditionSQL('both')
    expect(sql.startsWith('(((domain)')).toBe(true)
    expect(sql).toContain(' OR (position(lower(email)')
  })
})

describe('buildDomainSetWhereClause', () => {
  test('builds one OR-joined clause with indexed params per domain', () => {
    const { clause, params } = buildDomainSetWhereClause(['aave.com', 'lido.fi'], 'url')
    expect(clause).toBe(
      '(((domain) = {domain0:String} OR endsWith((domain), {domainSuffix0:String})) OR ' +
      '((domain) = {domain1:String} OR endsWith((domain), {domainSuffix1:String})))'
    )
    expect(params).toEqual({
      domain0: 'aave.com', domainSuffix0: '.aave.com',
      domain1: 'lido.fi',  domainSuffix1: '.lido.fi',
    })
  })

  test('lowercases and trims each domain', () => {
    const { params } = buildDomainSetWhereClause([' AAVE.com '], 'url')
    expect(params.domain0).toBe('aave.com')
    expect(params.domainSuffix0).toBe('.aave.com')
  })

  test('returns a never-true clause for an empty domain list', () => {
    const { clause, params } = buildDomainSetWhereClause([], 'both')
    expect(clause).toBe('0')
    expect(params).toEqual({})
  })
})

describe('credentialFingerprint', () => {
  test('is deterministic for the same inputs', () => {
    expect(credentialFingerprint('user@aave.com', 'hunter2', 'aave.com'))
      .toBe(credentialFingerprint('user@aave.com', 'hunter2', 'aave.com'))
  })

  test('is a 16-char hex string', () => {
    expect(credentialFingerprint('user@aave.com', 'hunter2', 'aave.com')).toMatch(/^[0-9a-f]{16}$/)
  })

  test('differs when any one field differs', () => {
    const base = credentialFingerprint('user@aave.com', 'hunter2', 'aave.com')
    expect(credentialFingerprint('other@aave.com', 'hunter2', 'aave.com')).not.toBe(base)
    expect(credentialFingerprint('user@aave.com', 'other', 'aave.com')).not.toBe(base)
    expect(credentialFingerprint('user@aave.com', 'hunter2', 'other.com')).not.toBe(base)
  })
})
