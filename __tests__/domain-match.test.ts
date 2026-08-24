import { vi, describe, test, expect } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
  NORM_EMAIL_EXPR: 'email',
}))

import {
  domainMatches, emailDomainMatches, credentialMatchesDomain, matchModeToMatchType,
  domainSuffixChain, buildMonitorDomainIndex, matchCredentialsAgainstIndex,
  matchConditionSQL, buildDomainSetWhereClause, credentialFingerprint,
  buildCandidateColumnWhereClause, buildCandidateValueBranches,
  compareMatches, mergeMatchPages,
  type CandidateBranch, type CandidateColumn, type MatchRow,
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

describe('buildCandidateColumnWhereClause', () => {
  test('tests the bare column, never a normalization expression', () => {
    // The whole point of phase 1 is that ClickHouse reads ONE narrow column;
    // wrapping it would drag url/email/password into the scan.
    const { clause } = buildCandidateColumnWhereClause('domain', ['aave.com'])
    expect(clause).toBe('((domain = {domainEq0:String} OR endsWith(domain, {domainSuffix0:String})))')
  })

  test('keeps the domain-or-subdomain semantics of the shared matcher', () => {
    const { params } = buildCandidateColumnWhereClause('email_domain', [' AAVE.com '])
    expect(params.email_domainEq0).toBe('aave.com')
    expect(params.email_domainSuffix0).toBe('.aave.com')
  })

  test('ORs every domain in the set, with per-domain parameter names', () => {
    const { clause, params } = buildCandidateColumnWhereClause('domain', ['a.com', 'b.com'])
    expect(clause).toContain(' OR ')
    expect(Object.keys(params).sort()).toEqual(['domainEq0', 'domainEq1', 'domainSuffix0', 'domainSuffix1'])
  })

  test('returns a never-true clause for an empty domain list', () => {
    expect(buildCandidateColumnWhereClause('domain', []).clause).toBe('0')
  })
})

describe('buildCandidateValueBranches', () => {
  test('emits one branch per column instead of a single ORed clause', () => {
    // An OR across two columns is prunable by neither the primary key nor
    // either bloom filter — separate branches keep each one prunable.
    const branches = buildCandidateValueBranches([
      { column: 'domain', values: ['aave.com'] },
      { column: 'email_domain', values: ['aave.com'] },
    ])
    expect(branches).toHaveLength(2)
    expect(branches[0].clause).toBe('domain IN {domainValues:Array(String)}')
    expect(branches[0].clause).not.toContain(' OR ')
  })

  test('later branches exclude what earlier ones already returned', () => {
    // Without this a row matching on BOTH columns comes back twice, which the
    // ORed form would never do.
    const branches = buildCandidateValueBranches([
      { column: 'domain', values: ['aave.com'] },
      { column: 'email_domain', values: ['aave.com'] },
    ])
    expect(branches[1].clause).toBe(
      'email_domain IN {email_domainValues:Array(String)} AND NOT domain IN {domainValues:Array(String)}'
    )
    expect(branches[1].params).toEqual({ email_domainValues: ['aave.com'], domainValues: ['aave.com'] })
  })

  test('drops columns with no resolved values rather than emitting an empty IN', () => {
    // ClickHouse cannot infer the element type of an empty array literal.
    const branches = buildCandidateValueBranches([
      { column: 'domain', values: [] },
      { column: 'email_domain', values: ['aave.com'] },
    ])
    expect(branches).toHaveLength(1)
    expect(branches[0].clause).toBe('email_domain IN {email_domainValues:Array(String)}')
  })

  test('returns no branches when phase 1 resolved nothing at all', () => {
    expect(buildCandidateValueBranches([{ column: 'domain', values: [] }])).toEqual([])
    expect(buildCandidateValueBranches([])).toEqual([])
  })

  test('excludes the caller-owned domain bucket from EVERY branch', () => {
    // Not just the later ones: the email_domain branch is the one that reaches
    // those rows without their raw `domain` ever appearing in an IN-list.
    const branches = buildCandidateValueBranches([
      { column: 'domain', values: ['aave.com'] },
      { column: 'email_domain', values: ['aave.com'] },
    ], ['', 'http', 'https'])
    for (const branch of branches) {
      expect(branch.clause).toContain('AND domain NOT IN {excludedDomains:Array(String)}')
      expect(branch.params.excludedDomains).toEqual(['', 'http', 'https'])
    }
  })

  test('emits no exclusion at all when the caller owns no bucket', () => {
    // An empty `NOT IN ()` would be pure noise in the plan.
    const [branch] = buildCandidateValueBranches([{ column: 'domain', values: ['aave.com'] }])
    expect(branch.clause).toBe('domain IN {domainValues:Array(String)}')
    expect(branch.params).not.toHaveProperty('excludedDomains')
  })
})

/**
 * REGRESSION: the `domain IN ('', 'http', 'https')` bucket must belong to
 * exactly one page.
 *
 * Those rows carry a real `email_domain` even though their raw `domain` is
 * blank or scheme-only, so before the exclusion an `email_domain` phase-2
 * branch returned the very rows the caller already held as
 * `candidates.legacyRows`. mergeMatchPages does not deduplicate — by design,
 * see its PRECONDITION — so the merged page came back padded with duplicates
 * that evicted genuinely distinct matches. Measured on real data before the
 * fix: `example.com` in `both` mode returned 100 rows carrying 42 distinct
 * ones, with every row the `domain` branch found evicted.
 *
 * This simulates the endpoint's whole plan over a constructed table so the
 * assertion is about the merged PAGE, not about SQL text.
 */
describe('phase-2 branches + mergeMatchPages — legacy bucket ownership', () => {
  const LEGACY = ['', 'http', 'https']

  /** A stored row, plus the normalized domain lib/ulp-normalize.ts derives for it. */
  interface StoredRow extends MatchRow {
    /** Raw primary-key column: '' / 'http' / 'https' for the corrupted rows. */
    rawDomain: string
    /** MATERIALIZED column: the raw email's domain. */
    email_domain: string
  }

  /**
   * Evaluate one CandidateBranch against a stored row. Understands exactly the
   * fragment grammar buildCandidateValueBranches emits and throws on anything
   * else, so a change to that grammar surfaces here instead of silently
   * passing.
   */
  function branchAdmits(branch: CandidateBranch, row: StoredRow): boolean {
    const col = (name: string) => (name === 'domain' ? row.rawDomain : row.email_domain)
    return branch.clause.split(' AND ').every(fragment => {
      let m = /^(\w+) IN \{(\w+):Array\(String\)\}$/.exec(fragment)
      if (m) return branch.params[m[2]].includes(col(m[1]))
      m = /^(?:NOT (\w+) IN|(\w+) NOT IN) \{(\w+):Array\(String\)\}$/.exec(fragment)
      if (m) return !branch.params[m[3]].includes(col(m[1] ?? m[2]))
      throw new Error(`unrecognized branch fragment: ${fragment}`)
    })
  }

  /**
   * The endpoint's plan, minus ClickHouse: phase 1 resolves per-column values
   * and fetches the legacy bucket as rows, phase 2 runs one bounded page per
   * branch, mergeMatchPages combines them.
   */
  function runPlan(table: StoredRow[], monitored: string, limit: number, excluded: string[]): MatchRow[] {
    const matches = (r: StoredRow) =>
      domainMatches(r.domain, monitored) || domainMatches(r.email_domain, monitored)
    // The database returns each page in raw primary-key order, bounded by LIMIT.
    const page = (rows: StoredRow[]) =>
      rows.slice().sort((a, b) => a.rawDomain.localeCompare(b.rawDomain) || a.email.localeCompare(b.email))
        .slice(0, limit)

    const legacyRows = page(table.filter(r => LEGACY.includes(r.rawDomain) && matches(r)))

    const columns: Array<{ column: CandidateColumn; values: string[] }> = [
      { column: 'domain', values: [...new Set(table.filter(r => domainMatches(r.rawDomain, monitored)).map(r => r.rawDomain))] },
      { column: 'email_domain', values: [...new Set(table.filter(r => domainMatches(r.email_domain, monitored)).map(r => r.email_domain))] },
    ].map(c => ({ ...c, values: c.values.filter(v => !LEGACY.includes(v)) }))

    const pages = buildCandidateValueBranches(columns, excluded)
      .map(branch => page(table.filter(r => branchAdmits(branch, r) && matches(r))))

    return mergeMatchPages([...pages, legacyRows], limit)
  }

  /**
   * One corrupted row whose raw `domain` is blank but whose `email_domain` is
   * real (so the email branch can reach it), plus one ordinary row only the
   * `domain` branch can reach. A limit of 2 makes eviction observable: if the
   * corrupted row is returned twice it takes the ordinary row's slot.
   */
  const table: StoredRow[] = [
    { rawDomain: '', email_domain: 'corp.example.com', url: 'https://shop.example.com/a',
      email: 'ann@corp.example.com', password: 'p1', domain: 'shop.example.com' },
    { rawDomain: 'zeta.example.com', email_domain: 'other.test', url: 'https://zeta.example.com/b',
      email: 'bob@other.test', password: 'p2', domain: 'zeta.example.com' },
  ]
  const key = (r: MatchRow) => `${r.domain}|${r.email}|${r.url}|${r.password}`

  test('returns the corrupted row once, without evicting a distinct match', () => {
    const merged = runPlan(table, 'example.com', 2, LEGACY)
    expect(merged.map(key)).toEqual([
      'shop.example.com|ann@corp.example.com|https://shop.example.com/a|p1',
      'zeta.example.com|bob@other.test|https://zeta.example.com/b|p2',
    ])
  })

  test('and would NOT, without the exclusion — pinning what this guards', () => {
    // Same plan, exclusion removed: the email branch re-returns the row the
    // legacy page already holds, the duplicate fills the page, and the
    // genuinely distinct zeta.example.com match is pushed out entirely.
    const merged = runPlan(table, 'example.com', 2, [])
    expect(merged).toHaveLength(2)
    expect(new Set(merged.map(key)).size).toBe(1)
    expect(merged.map(key)).not.toContain('zeta.example.com|bob@other.test|https://zeta.example.com/b|p2')
  })
})

describe('mergeMatchPages', () => {
  const row = (domain: string, email: string, url = 'u', password = 'p'): MatchRow =>
    ({ domain, email, url, password })

  test('sorts the single-page case exactly like the multi-page case', () => {
    // The route documents that EVERY page is re-sorted in-process, because the
    // database only sorts on the (domain, email) primary-key prefix. A
    // single-page fast path that skipped the sort would silently break the
    // is_new badge's stable display order.
    const page = [row('b.com', 'x@b.com'), row('a.com', 'z@a.com'), row('a.com', 'a@a.com')]
    expect(mergeMatchPages([page], 10).map(r => `${r.domain}/${r.email}`))
      .toEqual(['a.com/a@a.com', 'a.com/z@a.com', 'b.com/x@b.com'])
    // Empty pages must not turn into a single-page shortcut either.
    expect(mergeMatchPages([[], page, []], 10).map(r => r.domain)).toEqual(['a.com', 'a.com', 'b.com'])
  })

  test('never sorts a page the caller still holds', () => {
    // The endpoint passes in candidates.legacyRows, which is CACHED and served
    // again on the next request inside the TTL — reordering it in place would
    // corrupt what the cache hands out.
    const page = [row('b.com', 'x@b.com'), row('a.com', 'z@a.com')]
    const before = page.slice()
    mergeMatchPages([page], 10)
    expect(page).toEqual(before)
  })

  test('caps the merged page at the limit', () => {
    const merged = mergeMatchPages([[row('a.com', 'a@a.com')], [row('b.com', 'b@b.com')]], 1)
    expect(merged).toEqual([row('a.com', 'a@a.com')])
  })

  test('returns an empty page when there is nothing to merge', () => {
    expect(mergeMatchPages([], 10)).toEqual([])
    expect(mergeMatchPages([[], []], 10)).toEqual([])
  })
})

describe('compareMatches', () => {
  test('breaks ties on all four fields, not just the primary-key prefix', () => {
    // The database sorts only on (domain, email); url and password are what
    // pin display order for rows the database left in an arbitrary order.
    const base = { domain: 'a.com', email: 'a@a.com', url: 'u', password: 'p' }
    expect(compareMatches(base, { ...base, url: 'v' })).toBeLessThan(0)
    expect(compareMatches(base, { ...base, password: 'q' })).toBeLessThan(0)
    expect(compareMatches(base, { ...base })).toBe(0)
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
