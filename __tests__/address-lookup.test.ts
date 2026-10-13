import { describe, expect, test } from 'vitest'
import {
  ADDRESS_INDEX_EXPR, ADDRESS_INDEX_NAME, ADDRESS_LOOKUP_SETTING, addressDiffers, addressEquals, addressIn, addressIndexAddSql, addressIndexDropSql,
} from '@/lib/address-lookup'

describe('address lookup SQL', () => {
  test('the projection setting every address query carries is the one that was measured', () => {
    expect(ADDRESS_LOOKUP_SETTING).toBe('optimize_use_projections = 0')
  })

  test('equality lowers both sides, with the exact expression the index is built on', () => {
    expect(addressEquals('email')).toBe('lower(email) = lower({email:String})')
    expect(addressEquals('exactemail3')).toBe('lower(email) = lower({exactemail3:String})')
  })

  test('inequality is the same expression', () => {
    expect(addressDiffers('email')).toBe('lower(email) != lower({email:String})')
  })

  test('IN lowers every element', () => {
    expect(addressIn(['email0', 'email1'])).toBe('lower(email) IN (lower({email0:String}), lower({email1:String}))')
    expect(addressIn(['email0'])).toBe('lower(email) IN (lower({email0:String}))')
  })

  test('every builder writes ADDRESS_INDEX_EXPR verbatim (a skip index is used only for the identical expression)', () => {
    for (const sql of [addressEquals('p'), addressDiffers('p'), addressIn(['p']), addressIndexAddSql('ulp.credentials')]) {
      expect(sql).toContain(ADDRESS_INDEX_EXPR)
    }
  })

  test('the index DDL is idempotent and takes the table, for a content-dedup clone', () => {
    expect(addressIndexAddSql('ulp.credentials')).toBe(
      'ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_email_lc lower(email) TYPE bloom_filter(0.05) GRANULARITY 1',
    )
    expect(addressIndexDropSql('ulp.credentials_cdedup_auto')).toBe('ALTER TABLE ulp.credentials_cdedup_auto DROP INDEX IF EXISTS idx_bf_email_lc')
    expect(ADDRESS_INDEX_NAME).toBe('idx_bf_email_lc')
  })
})
