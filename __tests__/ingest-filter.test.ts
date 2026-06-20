import { describe, test, expect } from 'vitest'
import { classifyTier } from '@/lib/country-tiers'
import { parseIngestPolicy, policyActive, shouldDropAtIngest } from '@/lib/ingest-filter'

describe('classifyTier (mirrors the country_tier SQL)', () => {
  test.each([
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
    expect(policyActive(p)).toBe(false)
  })
  test('parses DROP_NOISE (true/1/yes/on) and it activates the policy', () => {
    expect(parseIngestPolicy({ INGEST_FILTER_DROP_NOISE: 'true' }).dropNoise).toBe(true)
    expect(parseIngestPolicy({ INGEST_FILTER_DROP_NOISE: '1' }).dropNoise).toBe(true)
    expect(parseIngestPolicy({ INGEST_FILTER_DROP_NOISE: 'false' }).dropNoise).toBe(false)
    expect(policyActive(parseIngestPolicy({ INGEST_FILTER_DROP_NOISE: 'true' }))).toBe(true)
  })
  test('ignores unknown tier tokens', () => {
    expect(parseIngestPolicy({ INGEST_FILTER_DROP_TIERS: 'T9,foo' }).tiers.size).toBe(0)
  })
  test('parses valid hard tiers and activates a hard-tier-only policy', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 't3, T9' })
    expect([...p.hardTiers]).toEqual(['T3'])
    expect(policyActive(p)).toBe(true)
  })
  test('has no hard tiers when the variable is absent', () => {
    expect(parseIngestPolicy({}).hardTiers.size).toBe(0)
  })
})

describe('shouldDropAtIngest', () => {
  test('hard T3 drop cannot be rescued by a keep suffix', () => {
    const p = parseIngestPolicy({
      INGEST_FILTER_HARD_DROP_TIERS: 'T3',
      INGEST_FILTER_KEEP_SUFFIXES: '.sa',
    })
    expect(shouldDropAtIngest('a@x.sa', 'https://x.com', 'x.com', p)).toBe(true)
  })

  test('hard T3-only policy preserves T1, T2, and unknown rows', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' })
    expect(shouldDropAtIngest('a@foo.co.uk', 'https://x.com', 'x.com', p)).toBe(false)
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', 'x.com', p)).toBe(false)
    expect(shouldDropAtIngest('a@gmail.com', 'https://x.com', 'x.com', p)).toBe(false)
    expect(shouldDropAtIngest('a@mail.ru', 'https://x.com', 'x.com', p)).toBe(true)
  })

  test('drops by tier (T3), keeps T2 and untiered', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_TIERS: 'T3' })
    expect(shouldDropAtIngest('a@mail.ru', 'https://x.com', 'x.com', p)).toBe(true)
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', 'x.com', p)).toBe(false)
    expect(shouldDropAtIngest('a@gmail.com', 'https://x.com', 'x.com', p)).toBe(false)
  })

  test('drops specific countries via suffixes, regardless of tier', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_SUFFIXES: '.pt,.gr' })
    expect(shouldDropAtIngest('a@sapo.pt', 'https://x.com', 'x.com', p)).toBe(true)
    expect(shouldDropAtIngest('a@gmail.com', 'https://news.gr', 'news.gr', p)).toBe(true)
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', 'x.com', p)).toBe(false)
  })

  test('keep-override wins: wealthy countries survive a T2/T3 tier drop', () => {
    const p = parseIngestPolicy({
      INGEST_FILTER_DROP_TIERS: 'T2,T3',
      INGEST_FILTER_KEEP_SUFFIXES: '.ie,.mt,.ae,.sa,.qa,.kw,.bh,.om',
    })
    expect(shouldDropAtIngest('a@foo.co.uk', 'https://x.com', 'x.com', p)).toBe(false) // T1
    expect(shouldDropAtIngest('a@gmail.com', 'https://x.com', 'x.com', p)).toBe(false) // untiered
    expect(shouldDropAtIngest('a@eircom.net', 'https://x.ie', 'x.ie', p)).toBe(false)  // Ireland (T2)
    expect(shouldDropAtIngest('a@x.ae', 'https://x.com', 'x.com', p)).toBe(false)      // UAE (T2)
    expect(shouldDropAtIngest('a@x.sa', 'https://x.com', 'x.com', p)).toBe(false)      // Saudi (T3)
    expect(shouldDropAtIngest('a@web.de', 'https://x.com', 'x.com', p)).toBe(true)     // Germany
    expect(shouldDropAtIngest('a@user.jp', 'https://x.com', 'x.com', p)).toBe(true)    // Japan
    expect(shouldDropAtIngest('a@mail.ru', 'https://x.com', 'x.com', p)).toBe(true)    // Russia
    expect(shouldDropAtIngest('a@user.br', 'https://x.com', 'x.com', p)).toBe(true)    // Brazil
  })

  test('DROP_NOISE drops junk URLs at ingest, independent of country', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_DROP_NOISE: 'true' })
    expect(shouldDropAtIngest('a@x.com', 'http://10.0.0.5/admin', '10.0.0.5', p)).toBe(true)     // IP host
    expect(shouldDropAtIngest('a@x.com', 'chrome://settings/passwords', 'chrome', p)).toBe(true) // non-web scheme
    expect(shouldDropAtIngest('a@x.com', 'https://site.com/wp-login.php', 'site.com', p)).toBe(true) // .php
    expect(shouldDropAtIngest('a@x.com', 'https://site.com/login', 'site.com', p)).toBe(false)   // real site kept
  })

  test('noise beats the keep-override: junk is junk even for a kept country', () => {
    const p = parseIngestPolicy({
      INGEST_FILTER_DROP_TIERS: 'T2,T3',
      INGEST_FILTER_KEEP_SUFFIXES: '.ae',
      INGEST_FILTER_DROP_NOISE: 'true',
    })
    expect(shouldDropAtIngest('a@x.ae', 'http://10.0.0.5/', '10.0.0.5', p)).toBe(true)  // kept country but junk URL → dropped
    expect(shouldDropAtIngest('a@x.ae', 'https://x.com', 'x.com', p)).toBe(false)        // kept country, real URL → kept
  })

  test('keeps everything when policy is empty', () => {
    const p = parseIngestPolicy({})
    expect(shouldDropAtIngest('a@mail.ru', 'http://x.ru', 'x.ru', p)).toBe(false)
  })
})
