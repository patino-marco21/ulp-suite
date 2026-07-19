/**
 * Comprehensive tests for lib/ulp-search.ts
 *
 * Coverage:
 *  - parseULPQuery()   all token types: email_full, email_dom, token, like, negation
 *  - buildULPWhere()   SQL clause generation, parameterization, AND chaining, NOT negation
 *  - buildULPWhereRegex() regex mode clause generation
 */

import { describe, test, expect } from 'vitest'
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from '@/lib/ulp-search'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  parseULPQuery — token type detection
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery — token type detection', () => {
  test('full email → type: email_full', () => {
    const tokens = parseULPQuery('john@gmail.com')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].type).toBe('email_full')
    expect(tokens[0].value).toBe('john@gmail.com')
    expect(tokens[0].negate).toBe(false)
  })

  test('full email stores lowercased emailDomain', () => {
    const tokens = parseULPQuery('John@Gmail.COM')
    expect(tokens[0].type).toBe('email_full')
    expect(tokens[0].emailDomain).toBe('gmail.com')
  })

  test('@domain-only → type: email_dom', () => {
    const tokens = parseULPQuery('@gmail.com')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].type).toBe('email_dom')
    expect(tokens[0].emailDomain).toBe('gmail.com')
  })

  test('@domain strips leading www.', () => {
    const tokens = parseULPQuery('@www.gmail.com')
    expect(tokens[0].type).toBe('email_dom')
    expect(tokens[0].emailDomain).toBe('gmail.com')
  })

  test('pure alphanumeric word → type: token', () => {
    const tokens = parseULPQuery('password123')
    expect(tokens[0].type).toBe('token')
  })

  test('word with hyphen → type: token', () => {
    const tokens = parseULPQuery('my-password')
    expect(tokens[0].type).toBe('token')
  })

  test('word with special chars (no @) → type: like', () => {
    // No @ so not email; has ! so not a clean [\w-]+ token → like
    const tokens = parseULPQuery('passw0rd!')
    expect(tokens[0].type).toBe('like')
  })

  test('word with @ is always email_full or email_dom, never like', () => {
    // p@ssw0rd! — has @ with non-empty local+domain parts → email_full
    const tokens = parseULPQuery('p@ssw0rd!')
    expect(tokens[0].type).toBe('email_full')
  })

  test('two-label dotted word → type: domain (not like)', () => {
    // "pass.word" fits the domain shape (word.word) even though it isn't a real
    // TLD -- the classifier recognizes the shape, it doesn't validate TLDs.
    const tokens = parseULPQuery('pass.word')
    expect(tokens[0].type).toBe('domain')
  })

  test('dotted word with a path segment → type: like (unchanged)', () => {
    const tokens = parseULPQuery('pass.word/path')
    expect(tokens[0].type).toBe('like')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 1b  parseULPQuery — domain-shaped token type detection
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery — domain-shaped token type detection', () => {
  test('two-label domain → type: domain', () => {
    const tokens = parseULPQuery('ledger.com')
    expect(tokens[0].type).toBe('domain')
    expect(tokens[0].value).toBe('ledger.com')
  })

  test('another two-label domain → type: domain', () => {
    const tokens = parseULPQuery('trezor.io')
    expect(tokens[0].type).toBe('domain')
  })

  test('three-label domain (subdomain) → type: domain', () => {
    const tokens = parseULPQuery('mail.google.com')
    expect(tokens[0].type).toBe('domain')
  })

  test('IP address → type: domain (intentional; the domain branch never calls hasToken(), so there is no separator-character error risk)', () => {
    const tokens = parseULPQuery('192.168.1.1')
    expect(tokens[0].type).toBe('domain')
  })

  test('trailing dot → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger.')
    expect(tokens[0].type).toBe('like')
  })

  test('leading dot → type: like (not domain)', () => {
    const tokens = parseULPQuery('.com')
    expect(tokens[0].type).toBe('like')
  })

  test('double dot (empty label) → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger..com')
    expect(tokens[0].type).toBe('like')
  })

  test('domain with a path → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger.com/login')
    expect(tokens[0].type).toBe('like')
  })

  test('domain with a space → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger .com')
    expect(tokens[0].type).toBe('like')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 2  parseULPQuery — negation
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery — negation', () => {
  test('leading minus sets negate: true', () => {
    const tokens = parseULPQuery('-gmail')
    expect(tokens[0].negate).toBe(true)
    expect(tokens[0].value).toBe('gmail')
  })

  test('leading minus on email_dom', () => {
    const tokens = parseULPQuery('-@yahoo.com')
    expect(tokens[0].negate).toBe(true)
    expect(tokens[0].type).toBe('email_dom')
  })

  test('leading minus on full email', () => {
    const tokens = parseULPQuery('-user@spam.com')
    expect(tokens[0].negate).toBe(true)
    expect(tokens[0].type).toBe('email_full')
  })

  test('standalone minus → parsed as token with value "-" (not negation)', () => {
    // '-' alone: startsWith('-') && length > 1 is false → negate=false, value='-'
    // /^[\w-]+$/.test('-') → true → type token
    const tokens = parseULPQuery('-')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].negate).toBe(false)
    expect(tokens[0].value).toBe('-')
    expect(tokens[0].type).toBe('token')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 3  parseULPQuery — comma-separated multi-token
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery — comma-separated multi-token', () => {
  test('parses multiple comma-separated terms', () => {
    const tokens = parseULPQuery('gmail, john@gmail.com, hunter2')
    expect(tokens).toHaveLength(3)
    expect(tokens[0].type).toBe('token')
    expect(tokens[1].type).toBe('email_full')
    expect(tokens[2].type).toBe('token')
  })

  test('empty segments are filtered out', () => {
    const tokens = parseULPQuery('gmail,,, john')
    expect(tokens).toHaveLength(2)
  })

  test('mixed positive and negative terms', () => {
    const tokens = parseULPQuery('@gmail.com, -@yahoo.com')
    expect(tokens[0].negate).toBe(false)
    expect(tokens[1].negate).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 4  parseULPQuery — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery — edge cases', () => {
  test('empty string returns empty array', () => {
    expect(parseULPQuery('')).toHaveLength(0)
  })

  test('whitespace-only string returns empty array', () => {
    expect(parseULPQuery('   ')).toHaveLength(0)
  })

  test('single comma returns empty array', () => {
    expect(parseULPQuery(',')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 5  buildULPWhere — empty input
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — empty input', () => {
  test('empty token list returns "1=1" clause with no params', () => {
    const { clause, params } = buildULPWhere([])
    expect(clause).toBe('1=1')
    expect(params).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 6  buildULPWhere — token type → SQL expression
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — token type SQL generation', () => {
  test('token type → hasToken() on url/email/password', () => {
    const tokens = parseULPQuery('hunter2')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('hasToken(url,')
    expect(clause).toContain('hasToken(email,')
    expect(clause).toContain('hasToken(password,')
    // Params contain the token value
    const paramValues = Object.values(params)
    expect(paramValues).toContain('hunter2')
  })

  test('email_full type → exact email = {param:String} (bloom_filter accelerated)', () => {
    const tokens = parseULPQuery('john@gmail.com')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('email =')
    // Must NOT contain LIKE (would bypass index)
    expect(clause).not.toContain('LIKE')
    // Value is lowercased
    const paramValues = Object.values(params)
    expect(paramValues).toContain('john@gmail.com')
  })

  test('email_full lowercases the value in params', () => {
    const tokens = parseULPQuery('JOHN@GMAIL.COM')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('john@gmail.com')
    expect(paramValues).not.toContain('JOHN@GMAIL.COM')
  })

  test('email_dom type → email_domain = OR domain =', () => {
    const tokens = parseULPQuery('@gmail.com')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('email_domain =')
    expect(clause).toContain('OR')
    expect(clause).toContain('domain =')
    const paramValues = Object.values(params)
    expect(paramValues).toContain('gmail.com')
  })

  test('email_dom lowercases the domain in params', () => {
    const tokens = parseULPQuery('@Gmail.COM')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('gmail.com')
  })

  test('like type → LIKE %value% on url/email/password', () => {
    // Use a string with special chars but no @ (@ triggers email classification)
    const tokens = parseULPQuery('passw0rd!')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('LIKE')
    const paramValues = Object.values(params)
    expect(paramValues.some(v => typeof v === 'string' && v.includes('passw0rd!'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 6b  buildULPWhere — domain type → SQL expression
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — domain type SQL generation', () => {
  test('domain type → exact match, subdomain suffix, url_host, and email_domain LIKE, OR-joined', () => {
    const tokens = parseULPQuery('ledger.com')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toContain('domain =')
    expect(clause).toContain('domain LIKE')
    expect(clause).toContain('url_host LIKE')
    expect(clause).toContain('email_domain LIKE')
    expect(clause).not.toContain('hasToken')
  })

  test('domain type params: exact value, subdomain suffix pattern, substring pattern', () => {
    const tokens = parseULPQuery('ledger.com')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('ledger.com')
    expect(paramValues).toContain('%.ledger.com')
    expect(paramValues).toContain('%ledger.com%')
  })

  test('domain type lowercases the value', () => {
    const tokens = parseULPQuery('Ledger.COM')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('ledger.com')
    expect(paramValues.some(v => typeof v === 'string' && v.includes('Ledger'))).toBe(false)
  })

  test('domain type escapes underscores in the LIKE patterns', () => {
    const tokens = parseULPQuery('my_site.com')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('%my\\_site.com%')
  })

  test('negated domain term produces NOT (...)', () => {
    const tokens = parseULPQuery('-ledger.com')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toMatch(/^NOT\s+\(/)
  })

  test('domain clause is valid ClickHouse parameter syntax (no string literals)', () => {
    const tokens = parseULPQuery('ledger.com')
    const { clause } = buildULPWhere(tokens)
    const literalStrings = clause.match(/'[^']*'/g) ?? []
    expect(literalStrings).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 7  buildULPWhere — negation
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — negation', () => {
  test('negated token produces NOT (...)', () => {
    const tokens = parseULPQuery('-gmail')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toMatch(/^NOT\s+\(/)
  })

  test('positive token does not have NOT prefix', () => {
    const tokens = parseULPQuery('gmail')
    const { clause } = buildULPWhere(tokens)
    expect(clause).not.toMatch(/^NOT\s+/)
  })

  test('negated email_dom produces NOT (...)', () => {
    const tokens = parseULPQuery('-@yahoo.com')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toMatch(/^NOT\s+/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 8  buildULPWhere — multiple tokens joined with AND
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — multiple tokens', () => {
  test('two tokens are joined with AND', () => {
    const tokens = parseULPQuery('gmail, hunter2')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toContain(' AND ')
  })

  test('three tokens produce two AND joins', () => {
    const tokens = parseULPQuery('gmail, hunter2, -@yahoo.com')
    const { clause } = buildULPWhere(tokens)
    const andCount = (clause.match(/ AND /g) || []).length
    expect(andCount).toBe(2)
  })

  test('each token gets a unique parameter name (no collisions)', () => {
    const tokens = parseULPQuery('alpha, beta, gamma')
    const { params } = buildULPWhere(tokens)
    const keys = Object.keys(params)
    const uniqueKeys = new Set(keys)
    expect(uniqueKeys.size).toBe(keys.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 9  buildULPWhere — no SQL injection
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — parameterization safety', () => {
  test('user input never appears literally in clause', () => {
    const tokens = parseULPQuery('1 OR 1=1; DROP TABLE credentials --')
    const { clause, params } = buildULPWhere(tokens)
    // The dangerous string must be in params, not in the clause itself
    expect(clause).not.toContain('DROP TABLE')
    expect(clause).not.toContain('OR 1=1')
    const paramValues = Object.values(params)
    // The value is parameterized
    expect(paramValues.some(v => String(v).includes('DROP'))).toBe(true)
  })

  test('email with SQL in local part is safely parameterized', () => {
    const tokens = parseULPQuery("evil'); DROP TABLE credentials--@gmail.com")
    const { clause } = buildULPWhere(tokens)
    expect(clause).not.toContain('DROP TABLE')
  })

  test('clause only contains valid ClickHouse parameter placeholders', () => {
    const tokens = parseULPQuery('test@example.com')
    const { clause } = buildULPWhere(tokens)
    // All param references should be in {name:Type} format
    const literalStrings = clause.match(/'[^']*'/g) ?? []
    expect(literalStrings).toHaveLength(0) // no string literals in clause
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 10  buildULPWhereRegex
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhereRegex', () => {
  test('empty tokens returns "1=1"', () => {
    const { clause } = buildULPWhereRegex([])
    expect(clause).toBe('1=1')
  })

  test('single token → match() on url/email/password', () => {
    const tokens = parseULPQuery('^admin@')
    const { clause, params } = buildULPWhereRegex(tokens)
    expect(clause).toContain('match(url,')
    expect(clause).toContain('match(email,')
    expect(clause).toContain('match(password,')
    const paramValues = Object.values(params)
    expect(paramValues).toContain('^admin@')
  })

  test('negation in regex mode', () => {
    const tokens = parseULPQuery('-^test')
    const { clause } = buildULPWhereRegex(tokens)
    expect(clause).toMatch(/^NOT\s+\(/)
  })

  test('multiple regex tokens joined with AND', () => {
    const tokens = parseULPQuery('pattern1, pattern2')
    const { clause } = buildULPWhereRegex(tokens)
    expect(clause).toContain(' AND ')
  })

  test('each token has a unique parameter name', () => {
    const tokens = parseULPQuery('foo, bar, baz')
    const { params } = buildULPWhereRegex(tokens)
    const keys = Object.keys(params)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('regex value is preserved verbatim in params', () => {
    const pattern = 'pass(word)?[0-9]+'
    const tokens = parseULPQuery(pattern)
    const { params } = buildULPWhereRegex(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain(pattern)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 11  Integration: parseULPQuery + buildULPWhere round-trips
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery + buildULPWhere integration', () => {
  test('full email search generates correct params count', () => {
    const tokens = parseULPQuery('alice@example.com')
    const { params } = buildULPWhere(tokens)
    expect(Object.keys(params)).toHaveLength(1)
  })

  test('email_dom search generates one param for the domain', () => {
    const tokens = parseULPQuery('@example.com')
    const { params } = buildULPWhere(tokens)
    expect(Object.keys(params)).toHaveLength(1)
    expect(Object.values(params)[0]).toBe('example.com')
  })

  test('three-term AND query generates four params (token type uses two)', () => {
    // @gmail.com → email_dom  → 1 param
    // hunter2   → token      → 2 params (lowercase value for hasToken, LIKE pattern for url_host/email_domain)
    // alice@…   → email_full → 1 param
    // Total: 4 params
    const tokens = parseULPQuery('@gmail.com, hunter2, alice@gmail.com')
    const { params } = buildULPWhere(tokens)
    expect(Object.keys(params)).toHaveLength(4)
  })

  test('clause is valid ClickHouse-compatible SQL fragment', () => {
    const tokens = parseULPQuery('@gmail.com')
    const { clause } = buildULPWhere(tokens)
    // Should only use ClickHouse-safe expressions
    expect(clause).toMatch(/\(email_domain = \{[a-z0-9]+:String\} OR domain = \{[a-z0-9]+:String\}\)/)
  })

  test('hasToken clause uses correct ClickHouse syntax', () => {
    const tokens = parseULPQuery('hunter2')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toMatch(/hasToken\(url, \{[a-z0-9]+:String\}\)/)
    expect(clause).toMatch(/hasToken\(email, \{[a-z0-9]+:String\}\)/)
    expect(clause).toMatch(/hasToken\(password, \{[a-z0-9]+:String\}\)/)
  })

  test('token type includes url_host LIKE for compound-domain substring matching', () => {
    // "ledger" must also match coinledger.com, ledgernano.com, etc.
    const tokens = parseULPQuery('ledger')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('url_host LIKE')
    // The LIKE pattern must be in params
    const paramValues = Object.values(params)
    expect(paramValues).toContain('%ledger%')
  })

  test('token type includes email_domain LIKE for compound email-domain substring matching', () => {
    const tokens = parseULPQuery('ledger')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toContain('email_domain LIKE')
  })

  test('token LIKE pattern escapes underscores so they are not treated as LIKE wildcards', () => {
    const tokens = parseULPQuery('foo_bar')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('%foo\\_bar%')
  })

  test('token search always lowercases the value (case-insensitive for hasToken + LIKE)', () => {
    // The text() inverted index uses preprocessor = lower(col), so stored tokens are
    // lowercase.  hasToken(url, 'GOOGLE') would return 0 rows even though google.com
    // credentials exist.  We always lowercase the needle so 'Google'→'google'.
    const tokens = parseULPQuery('Ledger')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    // The lowercase form appears for hasToken, and the LIKE pattern is also lowercase
    expect(paramValues).toContain('ledger')
    expect(paramValues).toContain('%ledger%')
    expect(paramValues).not.toContain('Ledger')
  })
})
