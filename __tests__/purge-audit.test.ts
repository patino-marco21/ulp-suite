import { describe, expect, test } from 'vitest'
import { parseIngestPolicy } from '@/lib/ingest-filter'
import { auditPurgeCandidates, formatAuditReport, parseCandidateLine } from '@/lib/purge-audit'

const hardT3 = parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' })

describe('auditPurgeCandidates: the guard in front of the destructive tier purges', () => {
  test('rows the ingest policy would itself drop are all in agreement', () => {
    const s = auditPurgeCandidates(
      [
        { email: 'a@mail.ru', url: 'https://x.com' }, // T3 email provider
        { email: 'a@gmail.com', url: 'http://site.ru/login' }, // T3 by the URL-TLD fallback
      ],
      hardT3,
    )
    expect(s).toMatchObject({ checked: 2, disagree: 0, stoppedEarly: false, noEmailDomain: 0 })
    expect(s.byIngestTier).toEqual({})
  })

  test('a login with no "@" is not T3 at ingest, whatever the stored country_tier says', () => {
    // 1,781,728 rows of ulp.credentials carry country_tier = 'T3' for exactly this shape:
    // the SQL treats the whole login as the email domain, the importer does not.
    const s = auditPurgeCandidates([{ email: 'john.vn', url: 'https://accounts.google.com' }], hardT3)
    expect(s).toMatchObject({ checked: 1, disagree: 1, noEmailDomain: 1 })
    expect(s.byIngestTier).toEqual({ untiered: 1 })
  })

  test('the email verdict beats a T3 URL TLD: att.com is T1 even on a .br site', () => {
    const s = auditPurgeCandidates([{ email: 'a@att.com', url: 'https://shop.com.br/login' }], hardT3)
    expect(s).toMatchObject({ checked: 1, disagree: 1, noEmailDomain: 0 })
    expect(s.byIngestTier).toEqual({ T1: 1 })
  })

  test('stops after maxDisagree disagreements instead of scanning every candidate', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ email: `user${i}`, url: 'https://x.com' }))
    const s = auditPurgeCandidates(rows, hardT3, { maxDisagree: 3 })
    expect(s).toMatchObject({ checked: 3, disagree: 3, stoppedEarly: true })
  })

  test('the low-tier purge is audited against its own policy, keep-suffixes included', () => {
    const policy = parseIngestPolicy({
      INGEST_FILTER_DROP_SUFFIXES: '.gr',
      INGEST_FILTER_KEEP_SUFFIXES: '.ie',
    })
    expect(auditPurgeCandidates([{ email: 'a@shop.gr', url: 'https://x.com' }], policy).disagree).toBe(0)
    expect(auditPurgeCandidates([{ email: 'a@shop.ie', url: 'https://x.com' }], policy).disagree).toBe(1)
  })

  test('an empty candidate set is trivially in agreement', () => {
    expect(auditPurgeCandidates([], hardT3)).toMatchObject({ checked: 0, disagree: 0, stoppedEarly: false })
  })
})

describe('parseCandidateLine: one line of ClickHouse TSV', () => {
  test('splits email and url on the tab', () => {
    expect(parseCandidateLine('a@b.com\thttps://x.com/p')).toEqual({ email: 'a@b.com', url: 'https://x.com/p' })
  })

  test('undoes ClickHouse TSV escaping', () => {
    expect(parseCandidateLine('a\\tb\\\\c\thttp://x\\ny')).toEqual({ email: 'a\tb\\c', url: 'http://x\ny' })
  })

  test('a line with no tab is an email with an empty url', () => {
    expect(parseCandidateLine('lonely')).toEqual({ email: 'lonely', url: '' })
  })
})

describe('formatAuditReport', () => {
  test('ends with the machine-readable line the purge scripts parse', () => {
    const report = formatAuditReport({ checked: 7, disagree: 0, stoppedEarly: false, noEmailDomain: 0, byIngestTier: {} })
    expect(report.trimEnd().split('\n').pop()).toBe('audit-result: checked=7 disagree=0 stopped_early=0')
  })

  test('explains a disagreement in counts only, never row content', () => {
    const report = formatAuditReport({
      checked: 3,
      disagree: 3,
      stoppedEarly: true,
      noEmailDomain: 2,
      byIngestTier: { untiered: 2, T1: 1 },
    })
    expect(report).toContain('untiered 2')
    expect(report).toContain('T1 1')
    expect(report).toMatch(/no "@"/)
    expect(report.trimEnd().split('\n').pop()).toBe('audit-result: checked=3 disagree=3 stopped_early=1')
  })
})
