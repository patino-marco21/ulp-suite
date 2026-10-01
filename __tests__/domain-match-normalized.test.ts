import { describe, test, expect } from 'vitest'
import { buildDomainSetWhereClause, buildNormalizedDomainSetMatch } from '@/lib/domain-match'

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('buildNormalizedDomainSetMatch', () => {
  test('url mode tests the precomputed normalized domain against the whole set with one arrayExists', () => {
    const { clause, params, normalizedColumns } = buildNormalizedDomainSetMatch(['ledger.com', 'trezor.io'], 'url')
    expect(clause).toBe(
      'arrayExists((d, s) -> nd = d OR endsWith(nd, s), {matchDomains:Array(String)}, {matchSuffixes:Array(String)})',
    )
    expect(params).toEqual({
      matchDomains: ['ledger.com', 'trezor.io'],
      matchSuffixes: ['.ledger.com', '.trezor.io'],
    })
    expect(normalizedColumns).toContain(' AS nd')
    expect(normalizedColumns).not.toContain(' AS ne')
    expect(normalizedColumns).not.toContain(' AS ed')
  })

  test('credential mode requires an @ and matches the part after the last one', () => {
    const { clause, normalizedColumns } = buildNormalizedDomainSetMatch(['ledger.com'], 'credential')
    // position() returns 0 (not -1) when '@' is absent -- without the guard the "domain after the
    // last @" would be the whole string and false-match emails that merely equal a monitored domain.
    expect(clause).toBe(
      "(position(ne, '@') > 0 AND arrayExists((d, s) -> ed = d OR endsWith(ed, s), {matchDomains:Array(String)}, {matchSuffixes:Array(String)}))",
    )
    expect(normalizedColumns).toContain(' AS ne')
    expect(normalizedColumns).toContain(`arrayElement(splitByChar('@', ne), -1) AS ed`)
    expect(normalizedColumns).not.toContain(' AS nd')
  })

  test('both mode ORs the two conditions and defines all three helper columns', () => {
    const { clause, normalizedColumns } = buildNormalizedDomainSetMatch(['ledger.com'], 'both')
    expect(clause.startsWith('(arrayExists((d, s) -> nd = d')).toBe(true)
    expect(clause).toContain(" OR (position(ne, '@') > 0 AND arrayExists((d, s) -> ed = d")
    for (const alias of [' AS nd', ' AS ne', ' AS ed']) expect(normalizedColumns).toContain(alias)
  })

  test('lowercases and trims the monitored domains and dot-prefixes the suffix array', () => {
    const { params } = buildNormalizedDomainSetMatch(['  Ledger.COM ', 'TREZOR.io'], 'both')
    expect(params.matchDomains).toEqual(['ledger.com', 'trezor.io'])
    expect(params.matchSuffixes).toEqual(['.ledger.com', '.trezor.io'])
  })

  test('the normalization text appears once however many domains are monitored (the per-domain cost this removes)', () => {
    const one = buildNormalizedDomainSetMatch(['a.com'], 'both')
    const many = buildNormalizedDomainSetMatch(Array.from({ length: 40 }, (_, i) => `d${i}.com`), 'both')
    expect(many.normalizedColumns).toBe(one.normalizedColumns)
    expect(many.clause).toBe(one.clause)
    // ...whereas the original per-domain builder repeats it for every domain.
    const perDomain = (n: number) =>
      count(buildDomainSetWhereClause(Array.from({ length: n }, (_, i) => `d${i}.com`), 'both').clause, 'jsessionid')
    expect(perDomain(40)).toBeGreaterThan(perDomain(1) * 20)
    expect(count(one.normalizedColumns, 'jsessionid')).toBeGreaterThan(0)
    expect(count(one.clause, 'jsessionid')).toBe(0)
  })

  test('an empty domain list matches nothing, in every mode', () => {
    for (const mode of ['url', 'credential', 'both'] as const) {
      expect(buildNormalizedDomainSetMatch([], mode).clause).toBe('0')
    }
  })

  test('helper aliases never reuse a stored column name, so a WHERE on the raw domain column still prunes', () => {
    const { normalizedColumns } = buildNormalizedDomainSetMatch(['a.com'], 'both')
    expect(normalizedColumns).not.toMatch(/\bAS (url|email|password|domain)\b/i)
  })
})
