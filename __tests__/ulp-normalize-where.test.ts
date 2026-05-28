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
