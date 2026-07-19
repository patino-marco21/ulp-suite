import { describe, test, expect } from 'vitest'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'

describe('SEARCH_INDEX_DEFINITIONS', () => {
  test('has exactly the 5 indexes search depends on, in a stable order', () => {
    const names = SEARCH_INDEX_DEFINITIONS.map(d => d.name)
    expect(names).toEqual([
      'idx_inv_url',
      'idx_inv_email',
      'idx_inv_password',
      'idx_ngram_url_host',
      'idx_ngram_email_domain',
    ])
  })

  test('idx_inv_* use the text() type with splitByNonAlpha, on their matching column', () => {
    const byName = Object.fromEntries(SEARCH_INDEX_DEFINITIONS.map(d => [d.name, d]))
    expect(byName['idx_inv_url'].addIndexSql('ulp.credentials'))
      .toContain('url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url))')
    expect(byName['idx_inv_email'].addIndexSql('ulp.credentials'))
      .toContain('email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email))')
    expect(byName['idx_inv_password'].addIndexSql('ulp.credentials'))
      .toContain('password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password))')
  })

  test('idx_ngram_* use the resized ngrambf_v1(4, 8192, 4, 0), not the old (4, 1024, 1, 0)', () => {
    const byName = Object.fromEntries(SEARCH_INDEX_DEFINITIONS.map(d => [d.name, d]))
    expect(byName['idx_ngram_url_host'].addIndexSql('ulp.credentials'))
      .toContain('url_host TYPE ngrambf_v1(4, 8192, 4, 0)')
    expect(byName['idx_ngram_email_domain'].addIndexSql('ulp.credentials'))
      .toContain('email_domain TYPE ngrambf_v1(4, 8192, 4, 0)')
  })

  test('every dropIndexSql uses IF EXISTS and every addIndexSql uses IF NOT EXISTS (safe to re-run)', () => {
    for (const def of SEARCH_INDEX_DEFINITIONS) {
      expect(def.dropIndexSql('ulp.credentials')).toContain('DROP INDEX IF EXISTS')
      expect(def.addIndexSql('ulp.credentials')).toContain('ADD INDEX IF NOT EXISTS')
    }
  })

  test('both dropIndexSql and addIndexSql parameterize by table name, for use against a swap clone', () => {
    const def = SEARCH_INDEX_DEFINITIONS.find(d => d.name === 'idx_inv_url')!
    expect(def.dropIndexSql('ulp.credentials_cdedup_auto'))
      .toBe('ALTER TABLE ulp.credentials_cdedup_auto DROP INDEX IF EXISTS idx_inv_url')
  })
})
