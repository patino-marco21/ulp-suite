/**
 * classifyTier used to scan the tier arrays linearly (~400 string comparisons per call, half of the parse time of a pile file). It now uses hash
 * lookups. This file keeps the OLD code verbatim as a reference and proves the new code gives the same answer for every entry of every list and for
 * 200,000 generated (login, url) pairs. All data is synthetic.
 */
import { describe, expect, test } from 'vitest'
import { TIER_LISTS as L, classifyTier, emailDomainOf, t3CountryOf, urlTldOf } from '@/lib/country-tiers'

// ── the code this task replaced, verbatim ─────────────────────────────────────
function refHostOf(url: string): string {
  let s = url
  const scheme = s.indexOf('://')
  if (scheme !== -1) s = s.slice(scheme + 3)
  s = s.split(/[/?#]/)[0]
  const at = s.lastIndexOf('@')
  if (at !== -1) s = s.slice(at + 1)
  s = s.split(':')[0]
  return s.toLowerCase()
}
function refUrlTldOf(url: string): string {
  const h = refHostOf(url)
  if (!h.includes('.')) return ''
  const parts = h.split('.')
  return parts[parts.length - 1]
}
const refMatches = (ed: string, suffixes: readonly string[], providers: readonly string[]) => suffixes.some(suf => ed.endsWith(suf)) || providers.includes(ed)
function refClassifyTier(email: string, url: string): string {
  const ed = emailDomainOf(email)
  if (refMatches(ed, L.T1.emailSuffixes, L.T1.emailProviders)) return 'T1'
  if (refMatches(ed, L.T2.emailSuffixes, L.T2.emailProviders)) return 'T2'
  if (refMatches(ed, L.T3.emailSuffixes, L.T3.emailProviders)) return 'T3'
  const tld = refUrlTldOf(url)
  if (L.T1.urlTlds.includes(tld)) return 'T1'
  if (L.T2.urlTlds.includes(tld)) return 'T2'
  if (L.T3.urlTlds.includes(tld)) return 'T3'
  return ''
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('the lists', () => {
  test('every e-mail suffix starts with a dot (the hash lookup relies on it)', () => {
    for (const t of ['T1', 'T2', 'T3'] as const) for (const s of L[t].emailSuffixes) expect(s.startsWith('.'), s).toBe(true)
  })
  test('every Tier 3 provider has a country, and nothing else has', () => {
    expect([...L.T3.providerCountry.keys()].sort()).toEqual([...L.T3.emailProviders].sort())
    for (const c of L.T3.providerCountry.values()) expect(c).toMatch(/^[A-Z]{2}$/)
  })
})

describe('classifyTier / urlTldOf = the old code', () => {
  test('every entry of every list, as an e-mail domain and as a url TLD', () => {
    for (const t of ['T1', 'T2', 'T3'] as const) {
      for (const s of L[t].emailSuffixes) for (const d of [`x${s}`, `a.b${s}`, `X${s.toUpperCase()}`, s]) expect(classifyTier(`u@${d}`, 'https://x.com'), d).toBe(refClassifyTier(`u@${d}`, 'https://x.com'))
      for (const p of L[t].emailProviders) for (const d of [p, p.toUpperCase(), `x.${p}`, `${p}.`]) expect(classifyTier(`u@${d}`, ''), d).toBe(refClassifyTier(`u@${d}`, ''))
      for (const tld of L[t].urlTlds) for (const u of [`https://h.${tld}/p`, `h.${tld}`, `HTTPS://WWW.H.${tld.toUpperCase()}./`, `http://u:pw@h.${tld}:8080/x?y#z`]) {
        expect(classifyTier('u@gmail.com', u), u).toBe(refClassifyTier('u@gmail.com', u))
        expect(urlTldOf(u), u).toBe(refUrlTldOf(u))
      }
    }
  })

  test('200,000 generated pairs', () => {
    const r = rng(20261012)
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)]
    const suffixes = [...L.T1.emailSuffixes, ...L.T2.emailSuffixes, ...L.T3.emailSuffixes]
    const providers = [...L.T1.emailProviders, ...L.T2.emailProviders, ...L.T3.emailProviders]
    const tlds = [...L.T1.urlTlds, ...L.T2.urlTlds, ...L.T3.urlTlds, 'com', 'net', 'org', 'io', 'xyz', 'co', 'me', '']
    const labels = ['mail', 'a', 'shop', 'x-y', 'WWW', 'Example', 'co', 'com', '']
    const domain = (): string => {
      switch (Math.floor(r() * 7)) {
        case 0: return r() < 0.5 ? pick(providers) : pick(providers).toUpperCase()
        case 1: return pick(labels) + pick(suffixes)
        case 2: return `${pick(labels)}.${pick(labels)}.${pick(tlds)}`
        case 3: return pick(['gmail.com', 'outlook.com', 'example.org', 'yahoo.com'])
        case 4: return pick(['', '.', '..', 'a..b', 'x.', '.ru', 'ru', '.co.uk', 'co.uk'])
        case 5: return `${pick(providers)}.`
        default: return `${pick(labels)}${pick(suffixes)}${r() < 0.2 ? '.' : ''}`
      }
    }
    const email = (): string => {
      const d = domain()
      switch (Math.floor(r() * 6)) {
        case 0: return d
        case 1: return `a@b@${d}`
        case 2: return `user@@${d}`
        case 3: return ''
        case 4: return `@${d}`
        default: return `user@${d}`
      }
    }
    const url = (): string => {
      const h = pick(labels), tld = pick(tlds), t2 = pick(tlds)
      switch (Math.floor(r() * 10)) {
        case 0: return `https://${h}.${tld}/p?q#f`
        case 1: return `http://u:pw@${h}.${tld}:8080/x`
        case 2: return `${h}.${tld}`
        case 3: return `HTTPS://WWW.${h.toUpperCase()}.${tld.toUpperCase()}./`
        case 4: return `android://hash==@com.${h}.${tld}/`
        case 5: return `//${h}.${tld}/x`
        case 6: return pick(['', 'localhost', 'a.b', '@', 'x@', '@x.ru', 'a@b://c.ru/d'])
        case 7: return `${h}.${tld}:99`
        case 8: return `ftp://${h}.${tld}?x=@y.${t2}`
        default: return `https://a@b@${h}.${tld}/`
      }
    }
    for (let i = 0; i < 200_000; i++) {
      const e = email(), u = url()
      const ref = refClassifyTier(e, u)
      const got = classifyTier(e, u)
      if (got !== ref) throw new Error(`classifyTier(${JSON.stringify(e)}, ${JSON.stringify(u)}) = ${got}, the old code gave ${ref}`)
      if (urlTldOf(u) !== refUrlTldOf(u)) throw new Error(`urlTldOf(${JSON.stringify(u)}) = ${urlTldOf(u)}, the old code gave ${refUrlTldOf(u)}`)
      if ((t3CountryOf(e, u) !== '') !== (ref === 'T3')) throw new Error(`t3CountryOf(${JSON.stringify(e)}, ${JSON.stringify(u)}) = ${t3CountryOf(e, u)} but the tier is ${ref}`)
    }
  })
})

describe('t3CountryOf: the country of the first Tier 3 signal', () => {
  test.each([
    ['a@mail.ru', 'https://x.com', 'RU'],
    ['a@yandex.com', '', 'RU'],            // a provider that does not end in a country code
    ['a@wp.pl', 'https://x.com', 'PL'],
    ['a@seznam.cz', '', 'CZ'],
    ['a@mynet.com', '', 'TR'],
    ['a@qq.com', '', 'CN'],
    ['a@gmail.com', 'https://shop.com.br/login', 'BR'],
    ['a@gmail.com', 'https://shop.sa/x', 'SA'],
    ['user', 'https://login.example.pl/x', 'PL'],
    ['a@mail.ru', 'https://shop.co.uk/x', 'RU'],      // the e-mail signal comes first
    ['a@user.br', 'https://shop.pl/x', 'BR'],
  ])('%s / %s -> %s', (email, url, country) => {
    expect(classifyTier(email, url)).toBe('T3')
    expect(t3CountryOf(email, url)).toBe(country)
  })

  test.each([
    ['a@gmail.com', 'https://shop.example.com/x'],      // untiered
    ['a@foo.co.uk', 'https://shop.ru/x'],               // T1 first
    ['a@web.de', 'https://shop.br/x'],                  // T2 first
    ['a@gmail.com', 'https://shop.de/x'],               // T2 by url
    ['a@gmail.com', 'https://shop.uk/x'],               // T1 by url
  ])('%s / %s is not Tier 3: no country', (email, url) => {
    expect(t3CountryOf(email, url)).toBe('')
  })
})
