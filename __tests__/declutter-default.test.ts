import { describe, test, expect } from 'vitest'
import { declutterByDefault, type DeclutterSearch } from '@/lib/declutter-default'

const browse: DeclutterSearch = { q: '', scope: 'all', regex: false, domain: '', urlHost: '', emailDomain: '' }
const search = (over: Partial<DeclutterSearch>): DeclutterSearch => ({ ...browse, ...over })

// Declutter hides IP-address hosts, :port URLs, every .php URL and rows the parser mangled. That is clutter in a browse or a broad search (the
// logins admin and root are 56% and 71% hidden, nearly all router panels) and a loss in a lookup of one site, address or text (a site that runs on
// .php loses 40% of its rows; 1.3% of addresses lose every row). So it starts on for the first and off for the second.
describe('declutterByDefault — Declutter starts on for browsing and broad searches, off for a lookup of one thing', () => {
  test('the bare browse has it on, so the default view does not open on parser junk', () => {
    expect(declutterByDefault(browse)).toBe(true)
    expect(declutterByDefault(search({ q: '   ' }))).toBe(true)
  })

  test.each([
    ['a site', 'example.tld'],
    ['a subdomain', 'login.corp.example.tld'],
    ['an IP address, whose rows Declutter would hide whatever they are', '192.168.1.1'],
    ['an address', 'person@example.tld'],
    ['everyone at one e-mail domain', '@corp.example.tld'],
    ['a URL with a path', 'https://example.tld/login.php'],
    ['a text with a symbol in it', 'Summer2024!'],
    ['a text with a space in it', 'two words'],
  ])('%s is a lookup: off (%s)', (_what, q) => {
    expect(declutterByDefault(search({ q }))).toBe(false)
  })

  test.each([
    ['a word', 'binance'],
    ['a word with a hyphen', 'my-word'],
    ['a common login', 'admin'],
  ])('%s is a broad search: on (%s)', (_what, q) => {
    expect(declutterByDefault(search({ q }))).toBe(true)
  })

  test('in a login scope a word or a dotted name is a user name, so it stays broad; only a whole address names one person', () => {
    for (const scope of ['login', 'login_contains'] as const) {
      expect(declutterByDefault(search({ scope, q: 'admin' }))).toBe(true)
      expect(declutterByDefault(search({ scope, q: 'john.smith' }))).toBe(true)
      expect(declutterByDefault(search({ scope, q: 'john@example.tld' }))).toBe(false)
    }
    // a `login:` prefix on one term does the same inside the default scope
    expect(declutterByDefault(search({ q: 'login:john.smith' }))).toBe(true)
    expect(declutterByDefault(search({ q: 'login:john@example.tld' }))).toBe(false)
  })

  test('a pattern is a broad search, even when it looks like a site', () => {
    expect(declutterByDefault(search({ q: 'example.tld', regex: true }))).toBe(true)
  })

  test.each([
    ['the Domain box', { domain: 'example.tld' }],
    ['the host filter', { urlHost: 'login.example.tld' }],
    ['the e-mail domain filter', { emailDomain: 'corp.example.tld' }],
  ])('%s names one site or domain exactly: off', (_what, over) => {
    expect(declutterByDefault(search(over))).toBe(false)
    expect(declutterByDefault(search({ ...over, q: 'admin' }))).toBe(false)
  })

  test('terms are ANDed, so one that names a single thing makes the whole search a lookup', () => {
    expect(declutterByDefault(search({ q: 'admin, example.tld' }))).toBe(false)
    expect(declutterByDefault(search({ q: 'binance, admin' }))).toBe(true)
  })

  test('a term that only excludes does not decide: the search is as broad as what is left', () => {
    expect(declutterByDefault(search({ q: '-example.tld' }))).toBe(true)
    expect(declutterByDefault(search({ q: 'example.tld, -admin' }))).toBe(false)
    expect(declutterByDefault(search({ q: 'admin, -example.tld' }))).toBe(true)
  })
})
