/**
 * Tests for normalization expressions in lib/ulp-normalize.ts
 *
 * Coverage:
 *  - NORM_EMAIL_EXPR   non-empty string, contains if(, is not bare "email"
 *  - NORM_DOMAIN_EXPR  non-empty string, contains if(, is not bare "domain"
 *  - NORM_URL_EXPR     non-empty string, contains if(, is not bare "url"
 *  - NORM_COLS         complete SELECT fragment with all aliases
 *  - Column name presence: each expression references the expected column
 */

import { describe, test, expect } from 'vitest'
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR, NORM_URL_EXPR, NORM_COLS } from '@/lib/ulp-normalize'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  NORM_EMAIL_EXPR
// ─────────────────────────────────────────────────────────────────────────────

describe('NORM_EMAIL_EXPR', () => {
  test('is a non-empty string', () => {
    expect(typeof NORM_EMAIL_EXPR).toBe('string')
    expect(NORM_EMAIL_EXPR.length).toBeGreaterThan(0)
  })

  test('contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_EMAIL_EXPR).toContain('if(')
  })

  test('is not just the word "email"', () => {
    expect(NORM_EMAIL_EXPR.trim()).not.toBe('email')
  })

  test('contains "email" to verify it transforms the email column', () => {
    expect(NORM_EMAIL_EXPR).toContain('email')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 2  NORM_DOMAIN_EXPR
// ─────────────────────────────────────────────────────────────────────────────

describe('NORM_DOMAIN_EXPR', () => {
  test('is a non-empty string', () => {
    expect(typeof NORM_DOMAIN_EXPR).toBe('string')
    expect(NORM_DOMAIN_EXPR.length).toBeGreaterThan(0)
  })

  test('contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_DOMAIN_EXPR).toContain('if(')
  })

  test('is not just the word "domain"', () => {
    expect(NORM_DOMAIN_EXPR.trim()).not.toBe('domain')
  })

  test('contains "domain" to verify it transforms the domain column', () => {
    expect(NORM_DOMAIN_EXPR).toContain('domain')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 3  NORM_URL_EXPR
// ─────────────────────────────────────────────────────────────────────────────

describe('NORM_URL_EXPR', () => {
  test('is a non-empty string', () => {
    expect(typeof NORM_URL_EXPR).toBe('string')
    expect(NORM_URL_EXPR.length).toBeGreaterThan(0)
  })

  test('contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_URL_EXPR).toContain('if(')
  })

  test('is not just the word "url"', () => {
    expect(NORM_URL_EXPR.trim()).not.toBe('url')
  })

  test('contains "url" to verify it transforms the url column', () => {
    expect(NORM_URL_EXPR).toContain('url')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 4  NORM_COLS
// ─────────────────────────────────────────────────────────────────────────────

describe('NORM_COLS', () => {
  test('is a non-empty string', () => {
    expect(typeof NORM_COLS).toBe('string')
    expect(NORM_COLS.length).toBeGreaterThan(0)
  })

  test('contains AS url — produces url alias', () => {
    expect(NORM_COLS).toContain('AS url')
  })

  test('contains AS email — produces email alias', () => {
    expect(NORM_COLS).toContain('AS email')
  })

  test('contains AS password — produces password alias', () => {
    expect(NORM_COLS).toContain('AS password')
  })

  test('contains AS domain — produces domain alias', () => {
    expect(NORM_COLS).toContain('AS domain')
  })

  test('contains if( — is a normalizing expression not bare column names', () => {
    expect(NORM_COLS).toContain('if(')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 5  Case-A jsessionid guard (regression — 2026-06-14)
// ─────────────────────────────────────────────────────────────────────────────

describe('case-A jsessionid guard', () => {
  // 2,984 rows had a valid url + correct domain plus a bare 'jsessionid=token'
  // email. The unguarded case-A transform fired on them and discarded the good
  // url, blanked the email, and emptied the domain. The fix gates case A on
  // url='' so only original-shape rows (empty url) are rewritten; good-url rows
  // fall through to their raw values. These string-shape checks lock the guard
  // in (the SQL semantics themselves can only be verified against ClickHouse).
  test("jsessionid branch requires url='' in every expression that uses it", () => {
    expect(NORM_URL_EXPR).toContain("jsessionid=' AND url=''")
    expect(NORM_EMAIL_EXPR).toContain("jsessionid=' AND url=''")
    expect(NORM_DOMAIN_EXPR).toContain("jsessionid=' AND url=''")
    expect(NORM_COLS).toContain("jsessionid=' AND url=''")
  })

  test('no positive jsessionid equality is used unguarded as a condition', () => {
    // Old bug: `lower(...)='jsessionid='` used directly as an if() condition,
    // i.e. immediately followed by a comma. The guarded form is followed by
    // " AND url=''"; the case-D form is a NOT-equals (!=). So a positive
    // equality (`[^!]='jsessionid='`) directly followed by a comma is the bug.
    expect(NORM_COLS).not.toMatch(/[^!]='jsessionid='\s*,/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 6  Case-D URL reconstruction is scheme-aware (regression — 2026-06-14)
// ─────────────────────────────────────────────────────────────────────────────

describe('case-D scheme-aware URL reconstruction', () => {
  // ~45,529 case-D rows hold the URL in the email column; most already carry a
  // scheme. The old d_url = concat('https://', email) double-schemed those
  // ("https://https://account...") so domain() returned the junk host "https",
  // making the rows unmatchable by domain. d_url now prepends https:// only
  // when no scheme is present.
  test('d_url only prepends https:// when the email has no scheme', () => {
    const guarded = "startsWith(lower(email),'https://'), email, concat('https://',email)"
    expect(NORM_URL_EXPR).toContain(guarded)
    expect(NORM_DOMAIN_EXPR).toContain(guarded)
    expect(NORM_COLS).toContain(guarded)
  })

  test("concat('https://',email) only appears as the guard's else-branch", () => {
    // The old bug used concat('https://',email) directly as d_url. It must now
    // always be preceded by ", email," — i.e. the else-branch of the startsWith
    // scheme guard, never standalone.
    const bare = "concat('https://',email)"
    for (const expr of [NORM_URL_EXPR, NORM_DOMAIN_EXPR, NORM_COLS]) {
      let idx = expr.indexOf(bare)
      while (idx !== -1) {
        expect(expr.slice(Math.max(0, idx - 7), idx)).toBe('email, ')
        idx = expr.indexOf(bare, idx + 1)
      }
    }
  })
})
