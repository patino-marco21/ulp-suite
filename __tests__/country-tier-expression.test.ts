import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'
import { buildCountryTierExpression, classifyTier, emailDomainOf } from '@/lib/country-tiers'
import { buildCountryTierModifySql } from '@/lib/clickhouse-migrations'

// Whitespace and SQL comments are layout; everything else must match token for token.
const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, '')

describe('buildCountryTierExpression — the stored country_tier column', () => {
  const expr = buildCountryTierExpression()

  test('takes the email domain from the stored email_domain column, which is blank for a login with no "@"', () => {
    // The old form was splitByChar('@', lower(email))[-1], which is the WHOLE login when there is no '@':
    // 1,781,728 rows of ulp.credentials such as a login ending in ".co" were stored as Tier 3 for that reason.
    expect(expr).toContain('email_domain')
    expect(expr).not.toContain("splitByChar('@', lower(email))")
    // `email` on its own (outside the quoted provider names, one of which is 'email.cz'): every use goes through email_domain
    expect(expr.replace(/'[^']*'/g, "''")).not.toMatch(/\bemail\b/)
  })

  test('derives the URL top-level label the way the importer does, not with ClickHouse topLevelDomain / the stored tld column', () => {
    // topLevelDomain('https://user:pw@host.co.uk:8080/x') is '' and topLevelDomain('https://a.b.c.d:pw@host.com:9/') is 'd'
    // (it reads the userinfo as the host); the importer's urlTldOf() strips scheme, userinfo and port first. Measured on a
    // 1.39M-row live sample: 536 rows (0.0385%) disagreed for exactly these shapes.
    expect(expr).not.toMatch(/\btld\b/)
    expect(expr).not.toContain('topLevelDomain')
    expect(expr).toContain("position(url, '://')")                // scheme
    expect(expr).toContain("splitByRegexp('[/?#]'")               // end of the authority
    expect(expr).toContain("splitByChar('@'")                     // userinfo: everything up to the LAST '@' goes
    expect(expr).toContain("splitByChar(':'")                     // port
    expect(expr).toContain("splitByChar('.'")                     // last label
  })

  test('the URL signal still ends in the same three lists, after the email signal', () => {
    const urlConditions = [...expr.matchAll(/ IN \(('[a-z]{2}'(?:,'[a-z]{2}')*)\), '(T[123])'/g)].map(m => [m[2], m[1].split(',').length])
    expect(urlConditions.map(c => c[0])).toEqual(['T1', 'T2', 'T3'])
  })

  test('the signal order is unchanged: email T1, T2, T3, then URL T1, T2, T3, else untiered', () => {
    const order = [...expr.matchAll(/'(T[123])',/g)].map(m => m[1])
    expect(order).toEqual(['T1', 'T2', 'T3', 'T1', 'T2', 'T3'])
    expect(expr.trim().endsWith("''\n)")).toBe(true)
  })

  test('the TypeScript twin agrees on the shapes that were wrong: a login with no "@" has no email domain', () => {
    expect(emailDomainOf('ivan.ru')).toBe('')
    expect(classifyTier('ivan.ru', 'https://login.microsoftonline.com/common/oauth2')).toBe('')
    expect(classifyTier('someone.co', 'https://accounts.google.com')).toBe('')
    // and still classifies a real address by its domain, then by the URL
    expect(classifyTier('a@b.ru', 'https://x.com')).toBe('T3')
    expect(classifyTier('a@gmail.com', 'https://shop.example.co.uk')).toBe('T1')
  })
})

describe('DDL v26 — swapping the expression on the live table', () => {
  test('MODIFY COLUMN carries the generator output and nothing that rewrites data', () => {
    const sql = buildCountryTierModifySql()
    expect(sql).toContain('ALTER TABLE ulp.credentials MODIFY COLUMN country_tier LowCardinality(String) MATERIALIZED multiIf(')
    expect(sql).toContain(buildCountryTierExpression())
    expect(sql).not.toMatch(/MATERIALIZE COLUMN/i)
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b/i)
  })

  const src = readFileSync('lib/clickhouse-migrations.ts', 'utf8')

  test('v26 runs once, inside its own try/catch, before the version is saved, and does NOT materialize at app start', () => {
    expect(src).toMatch(/const DDL_VERSION = (2[6-9]|[3-9]\d)\b/)
    const start = src.indexOf('if (lastDdl < 26)')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toContain('buildCountryTierModifySql()')
    expect(block).toMatch(/try \{[\s\S]*\} catch/)
    // App start must not be coupled to a mutation over 1.39B rows (see v23): the backfill is supervised.
    expect(block).not.toMatch(/MATERIALIZE/)
    expect(block).toContain('materialize-country-tier.sh')
  })

  test('email_domain is added BEFORE country_tier in the column list, because the expression now reads it', () => {
    const emailDomainAt = src.indexOf('ADD COLUMN IF NOT EXISTS email_domain')
    const tierAt = src.indexOf('ADD COLUMN IF NOT EXISTS country_tier')
    expect(emailDomainAt).toBeGreaterThan(-1)
    expect(tierAt).toBeGreaterThan(-1)
    expect(emailDomainAt).toBeLessThan(tierAt)
  })
})

describe('the init SQL mirrors the generator, so a fresh install starts with the right column', () => {
  const init = readFileSync('docker/clickhouse/init/01-ulp-tables.sql', 'utf8')
  const marker = 'country_tier LowCardinality(String) MATERIALIZED '

  test('the country_tier expression in 01-ulp-tables.sql is the generator output', () => {
    const from = init.indexOf(marker)
    expect(from).toBeGreaterThan(-1)
    const to = init.indexOf('login_type LowCardinality(String) MATERIALIZED', from)
    const block = init.slice(from + marker.length, to).trim().replace(/,$/, '')
    expect(squash(block)).toBe(squash(buildCountryTierExpression()))
  })
})
