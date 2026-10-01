import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import { NORM_COLS } from '@/lib/ulp-normalize'
import {
  RELATED_BY_EMAIL_SQL,
  RELATED_BY_DOMAIN_SQL,
  RELATED_BY_PASSWORD_SQL,
  RELATED_LIMIT,
} from '@/lib/related-queries'

/** The text inside `FROM ( ... ) AS t` and everything around it. */
function splitInnerOuter(sql: string): { inner: string; outer: string } {
  const open = sql.indexOf('FROM (')
  const close = sql.indexOf(') AS t')
  expect(open).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(open)
  return {
    inner: sql.slice(open + 'FROM ('.length, close),
    outer: sql.slice(0, open) + sql.slice(close + ') AS t'.length),
  }
}

const placeholders = (sql: string) => [...new Set([...sql.matchAll(/\{(\w+):/g)].map(m => m[1]))].sort()

const buckets = [
  { name: 'by_email', sql: RELATED_BY_EMAIL_SQL, where: 'WHERE email = {email:String}', params: ['email'] },
  { name: 'by_domain', sql: RELATED_BY_DOMAIN_SQL, where: 'WHERE domain = {domain:String} AND email != {email:String}', params: ['domain', 'email'] },
  { name: 'by_password', sql: RELATED_BY_PASSWORD_SQL, where: 'WHERE password = {password:String} AND email != {email:String}', params: ['email', 'password'] },
]

describe.each(buckets)('related queries — $name (alias-shadowing regression: 78/78 queries hit the 30 s cap with 0 rows)', ({ sql, where, params }) => {
  const { inner, outer } = splitInnerOuter(sql)

  test('the inner query filters raw stored columns', () => {
    expect(inner).toContain('FROM ulp.credentials')
    expect(inner).toContain(where)
  })

  test('the inner query has no NORM_COLS and no alias reusing a column name', () => {
    // Either one makes WHERE resolve against the normalized expression, which disables
    // primary-key and bloom-filter pruning (see lib/related-queries.ts).
    expect(inner).not.toContain(NORM_COLS)
    expect(inner).not.toMatch(/\bAS (url|email|password|domain)\b/i)
    expect(inner).not.toContain('if(')
  })

  test('NORM_COLS is applied once, by the outer query', () => {
    expect(outer).toContain(NORM_COLS)
    expect(outer.split(NORM_COLS)).toHaveLength(2)
  })

  test('the inner query takes the first rows in primary-key order, so popular values stop early', () => {
    // `ORDER BY imported_at` here read the whole table for popular logins/passwords
    // (measured 9.5-22 s on 1.39B rows); the key prefix reads in order and stops at the limit.
    expect(inner).toMatch(new RegExp(`ORDER BY domain, email\\s+LIMIT ${RELATED_LIMIT}\\b`))
    expect(inner).not.toContain('imported_at DESC')
  })

  test('the outer query only orders the sample for display and does not limit again', () => {
    expect(outer).toMatch(/ORDER BY imported_at DESC/)
    expect(outer).not.toMatch(/\bLIMIT\b/)
  })

  test('keeps the execution cap and bypasses the query cache', () => {
    expect(sql).toContain('max_execution_time = 30')
    expect(sql).toContain('use_query_cache = 0')
  })

  test('selects the same output columns the panel renders', () => {
    for (const col of ['url', 'email', 'password', 'domain', 'breach_name', 'country_tier', 'login_type', 'imported_at']) {
      expect(sql).toContain(col)
    }
  })

  test('binds only the parameters the route supplies', () => {
    expect(placeholders(sql)).toEqual(params)
  })
})

describe('related route — runs the shared split queries', () => {
  const source = readFileSync(new URL('../app/api/related/route.ts', import.meta.url), 'utf8')

  test('imports the three queries from lib/related-queries', () => {
    expect(source).toMatch(/import \{[^}]*RELATED_BY_EMAIL_SQL[^}]*RELATED_BY_DOMAIN_SQL[^}]*RELATED_BY_PASSWORD_SQL[^}]*\} from "@\/lib\/related-queries"/)
  })

  test('does not inline SQL or NORM_COLS again', () => {
    expect(source).not.toContain('NORM_COLS')
    expect(source).not.toContain('FROM ulp.credentials')
  })

  test('binds each query to its own parameters', () => {
    expect(source).toContain('executeQuery(RELATED_BY_EMAIL_SQL, { email })')
    expect(source).toContain('executeQuery(RELATED_BY_DOMAIN_SQL, { domain, email })')
    expect(source).toContain('executeQuery(RELATED_BY_PASSWORD_SQL, { password, email })')
  })
})
