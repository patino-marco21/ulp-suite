// __tests__/ulp-normalize-where.test.ts
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR, NORM_COLS } from '@/lib/ulp-normalize'

describe('NORM_EXPR strings used in WHERE clauses', () => {
  // ── NORM_EMAIL_EXPR ─────────────────────────────────────────────────────────
  it('NORM_EMAIL_EXPR is a non-empty string', () => {
    expect(typeof NORM_EMAIL_EXPR).toBe('string')
    expect(NORM_EMAIL_EXPR.length).toBeGreaterThan(0)
  })

  it('NORM_EMAIL_EXPR contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_EMAIL_EXPR).toContain('if(')
  })

  it('NORM_EMAIL_EXPR is not just the word "email"', () => {
    expect(NORM_EMAIL_EXPR.trim()).not.toBe('email')
  })

  // ── NORM_DOMAIN_EXPR ────────────────────────────────────────────────────────
  it('NORM_DOMAIN_EXPR is a non-empty string', () => {
    expect(typeof NORM_DOMAIN_EXPR).toBe('string')
    expect(NORM_DOMAIN_EXPR.length).toBeGreaterThan(0)
  })

  it('NORM_DOMAIN_EXPR contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_DOMAIN_EXPR).toContain('if(')
  })

  it('NORM_DOMAIN_EXPR is not just the word "domain"', () => {
    expect(NORM_DOMAIN_EXPR.trim()).not.toBe('domain')
  })

  // ── NORM_COLS ───────────────────────────────────────────────────────────────
  it('NORM_COLS is a non-empty string', () => {
    expect(typeof NORM_COLS).toBe('string')
    expect(NORM_COLS.length).toBeGreaterThan(0)
  })

  it('NORM_COLS contains AS url — produces url alias', () => {
    expect(NORM_COLS).toContain('AS url')
  })

  it('NORM_COLS contains AS email — produces email alias', () => {
    expect(NORM_COLS).toContain('AS email')
  })

  it('NORM_COLS contains AS password — produces password alias', () => {
    expect(NORM_COLS).toContain('AS password')
  })

  it('NORM_COLS contains AS domain — produces domain alias', () => {
    expect(NORM_COLS).toContain('AS domain')
  })

  it('NORM_COLS contains if( — is a normalizing expression not bare column names', () => {
    expect(NORM_COLS).toContain('if(')
  })

  // ── WHERE wrapping safety ───────────────────────────────────────────────────
  it('NORM_EMAIL_EXPR wrapped in parens forms a valid WHERE fragment', () => {
    const fragment = `WHERE (${NORM_EMAIL_EXPR}) = {email:String}`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(') = {email:String}')
  })

  it('NORM_DOMAIN_EXPR wrapped in parens forms a valid WHERE fragment', () => {
    const fragment = `WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(') = {domain:String}')
  })

  it('NORM_EMAIL_EXPR wrapped in parens forms a valid IN fragment', () => {
    const emailList = '{e0:String},{e1:String}'
    const fragment = `WHERE (${NORM_EMAIL_EXPR}) IN (${emailList})`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(`) IN (${emailList})`)
  })

  it('NORM_DOMAIN_EXPR wrapped in parens forms a valid IN fragment', () => {
    const domainList = '{d0:String},{d1:String}'
    const fragment = `WHERE (${NORM_DOMAIN_EXPR}) IN (${domainList})`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(`) IN (${domainList})`)
  })
})
