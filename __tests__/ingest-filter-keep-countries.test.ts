/** INGEST_FILTER_HARD_KEEP_COUNTRIES: the T3 hard drop does not apply to a line whose first T3 signal belongs to a listed country. */
import { describe, expect, test } from 'vitest'
import { DEFAULT_HARD_KEEP_COUNTRIES, makeHardDropPredicate, parseIngestPolicy, policyActive, shouldDropAtIngest } from '@/lib/ingest-filter'

/** null = the variable is absent (an explicit undefined would pick the default parameter). */
const policy = (keep: string | null = DEFAULT_HARD_KEEP_COUNTRIES) =>
  parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3', ...(keep === null ? {} : { INGEST_FILTER_HARD_KEEP_COUNTRIES: keep }) })

describe('parsing', () => {
  test('two-letter codes, any case, spaces; everything else is ignored', () => {
    expect([...policy('pl, CZ ,xx9,,sa,Polska').hardKeepCountries].sort()).toEqual(['CZ', 'PL', 'SA'])
  })
  test('absent or empty means no exception', () => {
    expect(policy(null).hardKeepCountries.size).toBe(0)
    expect(policy('').hardKeepCountries.size).toBe(0)
  })
  test('a keep-list alone does not activate the policy', () => {
    expect(policyActive(parseIngestPolicy({ INGEST_FILTER_HARD_KEEP_COUNTRIES: 'PL' }))).toBe(false)
  })
  test('the default is the 15 countries with a GDP per capita (PPP) of at least $40k', () => {
    expect(DEFAULT_HARD_KEEP_COUNTRIES.split(',').sort()).toEqual(['BG', 'CZ', 'EE', 'HR', 'KZ', 'LT', 'LV', 'PA', 'PL', 'RO', 'RU', 'SA', 'SI', 'SK', 'TR'])
  })
})

describe('the hard drop with a keep-list', () => {
  const drop = makeHardDropPredicate(policy())!
  test.each([
    ['a@mail.ru', 'https://x.com'],              // provider
    ['a@wp.pl', 'https://x.com'],
    ['a@gmail.com', 'https://shop.example.pl/x'], // url TLD
    ['a@gmail.com', 'https://shop.sa/x'],
    ['a@user.tr', ''],                             // e-mail suffix
    ['a@mail.ru', 'https://shop.com.br/x'],        // the e-mail signal comes first: Russia
  ])('%s / %s is kept', (email, url) => {
    expect(drop(email, url)).toBe(false)
    expect(shouldDropAtIngest(email, url, '', policy())).toBe(false)
  })
  test.each([
    ['a@gmail.com', 'https://shop.com.br/x'],
    ['a@gmail.com', 'https://shop.in/x'],
    ['a@user.id', ''],
    ['a@qq.com', ''],
    ['a@user.br', 'https://shop.pl/x'],           // e-mail first: Brazil, so dropped although the url is Polish
  ])('%s / %s is still dropped', (email, url) => {
    expect(drop(email, url)).toBe(true)
    expect(shouldDropAtIngest(email, url, '', policy())).toBe(true)
  })
  test('T1, T2 and untiered lines are never touched', () => {
    for (const [e, u] of [['a@foo.co.uk', ''], ['a@web.de', ''], ['a@gmail.com', 'https://x.com']]) expect(drop(e, u)).toBe(false)
  })
  test('with no keep-list every T3 line is dropped', () => {
    const none = makeHardDropPredicate(policy(''))!
    expect(none('a@mail.ru', '')).toBe(true)
    expect(none('a@wp.pl', '')).toBe(true)
  })
  test('a keep suffix still cannot rescue a hard-dropped country (the old invariant)', () => {
    const p = parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3', INGEST_FILTER_KEEP_SUFFIXES: '.br' })
    expect(shouldDropAtIngest('a@gmail.com', 'https://shop.br/x', '', p)).toBe(true)
  })
})
