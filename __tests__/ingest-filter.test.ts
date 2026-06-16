import { describe, test, expect } from 'vitest'
import { classifyTier } from '@/lib/country-tiers'
import { parseIngestPolicy, policyActive, shouldDropAtIngest } from '@/lib/ingest-filter'

describe('classifyTier (mirrors the country_tier SQL)', () => {
  test.each([
    // [email, url, expected, why]
    ['a@foo.co.uk', 'https://x.com', 'T1', 'T1 email ccTLD suffix'],
    ['a@comcast.net', 'https://x.com', 'T1', 'T1 ISP provider'],
    ['a@web.de', 'https://x.com', 'T2', 'T2 provider'],
    ['a@user.jp', 'https://x.com', 'T2', 'T2 email ccTLD'],
    ['a@mail.ru', 'https://x.com', 'T3', 'T3 provider'],
    ['a@user.br', 'https://x.com', 'T3', 'T3 email ccTLD'],
    ['a@gmail.com', 'https://site.co.uk', 'T1', 'generic email → URL TLD fallback (uk)'],
    ['a@gmail.com', 'http://site.ru/login', 'T3', 'URL TLD fallback (ru)'],
    ['a@gmail.com', 'https://example.com', '', 'generic email + non-cc TLD → untiered'],
  ])('%s / %s → %s', (email, url, expected) => {
    expect(classifyTier(email, url)).toBe(expected)
  })
})

describe('parseIngestPolicy', () => {
  test('off by default (no env)', () => {
    expect(policyActive(parseIngestPolicy({}))).toBe(false)
  })
  test('parses tiers', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_TIERS: 't3, T2' })
    expect([...p.tiers].sort()).toEqual(['T2', 'T3'])
    expect(policyActive(p)).toBe(true)
  })
  test('normalizes drop suffixes (leading dot) and derives TLDs', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_SUFFIXES: 'pt, .gr , IL' })
    expect(p.drop.suffixes).toEqual(['.pt', '.gr', '.il'])
    expect([...p.drop.tlds].sort()).toEqual(['gr', 'il', 'pt'])
  })
  test('parses keep suffixes (keep-only does not by itself activate dropping)', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_KEEP_SUFFIXES: '.ie,.ae' })
    expect(p.keep.suffixes).toEqual(['.ie', '.ae'])
    expect(policyActive(p)).toBe(false) // nothing to drop yet
  })
  test('ignores unknown tier tokens', () => {
    expect(parseIngestPolicy({ INGEST_FILTER_DROP_TIERS: 'T9,foo' }).tiers.size).toBe(0)
  })
})

describe('shouldDropAtIngest', () => {
  test('drops by tier (T3), keeps T2 and untiered', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_TIERS: 'T3' })
    expect(shouldDropAtIngest('a@mail.ru', 'https://x.com', p)).toBe(true)
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', p)).toBe(false)
    expect(shouldDropAtIngest('a@gmail.com', 'https://x.com', p)).toBe(false)
  })

  test('drops specific countries via suffixes, regardless of tier', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_SUFFIXES: '.pt,.gr' })
    expect(shouldDropAtIngest('a@sapo.pt', 'https://x.com', p)).toBe(true)      // email suffix
    expect(shouldDropAtIngest('a@gmail.com', 'https://news.gr', p)).toBe(true)  // URL TLD
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', p)).toBe(false)
  })

  test('keep-override wins: wealthy countries survive a T2/T3 tier drop', () => {
    // The "wealthy + English + Gulf oil" target.
    const p = parseIngestPolicy({
      INGEST_FILTER_DROP_TIERS: 'T2,T3',
      INGEST_FILTER_KEEP_SUFFIXES: '.ie,.mt,.ae,.sa,.qa,.kw,.bh,.om',
    })
    // kept: T1, untiered, and the listed wealthy countries
    expect(shouldDropAtIngest('a@foo.co.uk', 'https://x.com', p)).toBe(false) // T1
    expect(shouldDropAtIngest('a@gmail.com', 'https://x.com', p)).toBe(false) // untiered (US gmail)
    expect(shouldDropAtIngest('a@eircom.net', 'https://x.ie', p)).toBe(false) // Ireland (T2) via TLD
    expect(shouldDropAtIngest('a@x.ae', 'https://x.com', p)).toBe(false)      // UAE (T2)
    expect(shouldDropAtIngest('a@x.sa', 'https://x.com', p)).toBe(false)      // Saudi (T3)
    // dropped: the rest of T2/T3
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', p)).toBe(true)     // Germany (T2)
    expect(shouldDropAtIngest('a@user.jp', 'https://x.com', p)).toBe(true)    // Japan (T2)
    expect(shouldDropAtIngest('a@mail.ru', 'https://x.com', p)).toBe(true)    // Russia (T3)
    expect(shouldDropAtIngest('a@user.br', 'https://x.com', p)).toBe(true)    // Brazil (T3)
  })

  test('keeps everything when policy is empty', () => {
    const p = parseIngestPolicy({})
    expect(shouldDropAtIngest('a@mail.ru', 'http://x.ru', p)).toBe(false)
  })
})
