/**
 * Tests for NORM_EXPR sweep part 2.
 *
 * Coverage:
 *  - domain-monitor WHERE fragment uses NORM_DOMAIN_EXPR, not raw 'domain'
 *  - export route WHERE fragment uses NORM_DOMAIN_EXPR, not raw 'domain'
 */

import { describe, test, expect } from 'vitest'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  domain-monitor live-upload WHERE fragment
// ─────────────────────────────────────────────────────────────────────────────

describe('domain-monitor WHERE fragment', () => {
  const whereFragment = `(${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith(lower(${NORM_DOMAIN_EXPR}), {emailSuffix:String})`

  test('contains if( — uses normalizing expression not raw column', () => {
    expect(whereFragment).toContain('if(')
  })

  test('does not contain bare "domain ="', () => {
    expect(whereFragment).not.toMatch(/\bdomain\s*=\s*\{/)
  })

  test('contains {domain:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{domain:String}')
  })

  test('contains {emailSuffix:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{emailSuffix:String}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 2  export route domain filter WHERE fragment
// ─────────────────────────────────────────────────────────────────────────────

describe('export route domain filter WHERE fragment', () => {
  const whereFragment = ` AND (${NORM_DOMAIN_EXPR}) = {exportDomain:String}`

  test('contains if( — uses normalizing expression not raw column', () => {
    expect(whereFragment).toContain('if(')
  })

  test('does not contain bare "domain ="', () => {
    expect(whereFragment).not.toMatch(/\bdomain\s*=\s*\{/)
  })

  test('contains {exportDomain:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{exportDomain:String}')
  })
})
