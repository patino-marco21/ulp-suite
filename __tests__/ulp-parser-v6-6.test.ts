/**
 * Parser v6.6 (docs/superpowers/specs/2026-11-07-parser-v6-6-design.md): three layouts a survey of the source archive found rejected as a bad host, or stored without their site.
 * O: a web scheme in front of an Android app id. Q: a fully qualified host written with its trailing dot. R: an underscore in a label in front of the last one.
 * Everything that is still not a host stays rejected: a host without a dot, an Android package name or a file name behind a web scheme. All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { extractDomain, parseInlineLine, parseLine, parseULPStream } from '@/lib/ulp-parser'
import { stripWebSchemeBeforeAndroid } from '@/lib/ulp-recover'
import { classifyChange, classifyOldOnlyRow, hostRuleOf } from '@/lib/parser-diff'

const src = 'v66.txt'
const id = (n: number) => `AbCdEfGhIjKlMnOp${String(n).padStart(4, '0')}Qr==@com.example.app${n}`

describe('O: a web scheme in front of an app id', () => {
  test('stripWebSchemeBeforeAndroid drops https:// and http:// in front of android://, and nothing else', () => {
    expect(stripWebSchemeBeforeAndroid(`https://android://${id(1)}/:alice:Secret1`)).toBe(`android://${id(1)}/:alice:Secret1`)
    expect(stripWebSchemeBeforeAndroid(`HTTP://android://${id(1)}/:alice:Secret1`)).toBe(`android://${id(1)}/:alice:Secret1`)
    expect(stripWebSchemeBeforeAndroid(`android://${id(1)}/:alice:Secret1`)).toBeNull()
    expect(stripWebSchemeBeforeAndroid('https://shop.example.test/login:alice:Secret1')).toBeNull()
    expect(stripWebSchemeBeforeAndroid('https://android.example.test/login:alice:Secret1')).toBeNull()
    expect(stripWebSchemeBeforeAndroid('ftp://android://x')).toBeNull()
  })

  test('a username login is read (it was rejected as a bad host), and the row is marked as a recovered app-id line', () => {
    const r = parseInlineLine(`https://android://${id(1)}/:alice:Secret1`, src)
    expect(r.credential).toMatchObject({ url: `android://${id(1)}/`, email: 'alice', password: 'Secret1', domain: 'com.example.app1' })
    expect(r.androidRecovered).toBe(true)
  })

  test('an e-mail login keeps its site now (it was stored without a url)', () => {
    const r = parseInlineLine(`https://android://${id(2)}/:alice@mail.test:Secret1`, src)
    expect(r.credential).toMatchObject({ url: `android://${id(2)}/`, email: 'alice@mail.test', password: 'Secret1' })
  })

  test('it works behind a pipe that joins a scheme and the app id: the join comes first, then the web scheme goes', () => {
    const joined = parseInlineLine(`https://| android://${id(3)}/:alice:Secret1`, src)
    const direct = parseInlineLine(`https://android://${id(3)}/:alice:Secret1`, src)
    expect(direct.credential?.url).toBe(`android://${id(3)}/`)
    expect(joined.credential).toEqual(direct.credential)
  })

  test('a line that kept its own android:// prefix, and an ordinary web line, are read as before', () => {
    expect(parseInlineLine(`android://${id(4)}/:alice:Secret1`, src).androidRecovered).toBe(false)
    expect(parseInlineLine('https://shop.example.test/login:alice:Secret1', src).credential?.url).toBe('https://shop.example.test/login')
  })

  test('in a stream the repeats of one account under many app ids are one row per file, like the app ids that lost their scheme', async () => {
    const text = [1, 2, 3].map(n => `https://android://${id(n)}/:alice:Secret1\n`).join('') + `https://android://${id(4)}/:bob:Other22\n`
    const body = Readable.toWeb(Readable.from(Buffer.from(text))) as unknown as ReadableStream<Uint8Array>
    const rows: Array<{ email: string }> = []
    let dedup = 0
    for await (const b of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) { rows.push(...b.credentials); dedup += b.breakdown.dedup }
    expect(rows.map(r => r.email)).toEqual(['alice', 'bob'])
    expect(dedup).toBe(2)
  })
})

describe('Q: a host written with its trailing dot', () => {
  test('the host is the name without the dot, in the stored domain too', () => {
    const r = parseLine('https://portal.example.test./login:alice:Secret1', src)
    expect(r.credential).toMatchObject({ url: 'https://portal.example.test./login', email: 'alice', password: 'Secret1', domain: 'portal.example.test' })
  })

  test('with a port, www., upper case and user info', () => {
    expect(extractDomain('https://WWW.Portal.Example.test.:8443/x')).toBe('portal.example.test')
    expect(extractDomain('https://user@portal.example.test./')).toBe('portal.example.test')
    expect(extractDomain('portal.example.test./x')).toBe('portal.example.test')
  })

  test('a name that is only a label and a dot stays rejected', () => {
    expect(parseLine('https://gmail.:alice:Secret1', src)).toEqual({ credential: null, reason: 'garbage' })
  })
})

describe('R: an underscore in a label in front of the last one', () => {
  test.each([
    ['one label', 'https://shop_one.example.test/login', 'shop_one.example.test'],
    ['several', 'https://sub_a.sub_b.example.co.uk:8443/x', 'sub_a.sub_b.example.co.uk'],
    ['a digit and an underscore', 'https://shop_30.example.test/', 'shop_30.example.test'],
    ['an internationalised name', 'https://café_ü.example.test/', 'café_ü.example.test'],
  ])('%s is a host', (_label, url, domain) => {
    const r = parseLine(`${url}:alice:Secret1`, src)
    expect(r.credential).toMatchObject({ url, email: 'alice', password: 'Secret1', domain })
  })

  test.each([
    ['an Android package name', 'https://com.bank.app_name/'],
    ['a package name with an underscore in the middle and the end', 'https://com.bank_x.app_name/'],
    ['a file name', 'https://main_login.asp'],
    ['a file name, upper case', 'https://Main_Login.PHP'],
    ['a last label with a digit', 'https://shop_one.example.t3st/'],
    ['a last label that is one letter', 'https://shop_one.example.t/'],
    ['a label that starts with an underscore (a service name)', 'https://_dmarc.example.test/'],
    ['a label that ends with an underscore', 'https://shop_.example.test/'],
    ['a label of underscores and a hyphen', 'https://shop_one._-_.example.test/'],
    ['no dot', 'https://shop_one/'],
    ['an underscore only in a name without a dot, with a trailing dot', 'https://shop_one./'],
  ])('%s is not a host', (_label, url) => {
    expect(parseLine(`${url}:alice:Secret1`, src)).toEqual({ credential: null, reason: 'garbage' })
  })

  test('a host longer than DNS allows is rejected without a search', () => {
    const host = `${'a_b.'.repeat(70)}test`
    expect(parseLine(`https://${host}/:alice:Secret1`, src)).toEqual({ credential: null, reason: 'garbage' })
  })

  test('a long hostile host is read in linear time', () => {
    const t0 = performance.now()
    for (const host of ['a_'.repeat(120) + '!', 'a.'.repeat(120) + '!', 'x'.repeat(5000) + '_.test']) {
      for (let i = 0; i < 200; i++) parseInlineLine(`https://${host}/:alice:Secret1`, src)
    }
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  test('hosts without an underscore are judged exactly as before', () => {
    expect(parseLine('https://shop-one.example.test/:alice:Secret1', src).credential?.domain).toBe('shop-one.example.test')
    expect(parseLine('https://-shop.example.test/:alice:Secret1', src).credential).toBeNull()
    expect(parseLine('https://shop.example.test-/:alice:Secret1', src).credential).toBeNull()
    expect(parseLine('https://shop..example.test/:alice:Secret1', src).credential).toBeNull()
    expect(parseLine('https://localhost:3000/:alice:Secret1', src).credential).toBeNull()
  })

  test('a very long host the first pattern accepts (a token in the url position) is still accepted: the length cap belongs to the underscore branch only', () => {
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.test`
    expect(host.length).toBeGreaterThan(253)
    expect(parseLine(`https://${host}/:alice:Secret1`, src).credential?.domain).toBe(host)
  })
})

describe('the differential classes of v6.6', () => {
  const cred = (url: string, email = 'alice', password = 'Secret1') => ({ credential: { url, email, password }, reason: null })
  const rejected = { credential: null, reason: 'garbage' }

  test('hostRuleOf names the host of a stored url', () => {
    expect(hostRuleOf('https://portal.example.test./x')).toBe('host-trailing-dot')
    expect(hostRuleOf('https://user@portal.example.test.:8443/x')).toBe('host-trailing-dot')
    expect(hostRuleOf('https://shop_one.example.test/x')).toBe('host-underscore')
    expect(hostRuleOf('https://shop.example.test/x_y')).toBeNull()
    expect(hostRuleOf('android://x==@com.example.app_x/')).toBeNull()
    expect(hostRuleOf('')).toBeNull()
  })

  test('a rejected line now stored, and an e-mail credential that gained its url, are explained by the rule', () => {
    const repeatLine = (l: string) => classifyChange(l, rejected, cred('https://shop_one.example.test/'), rejected)
    expect(repeatLine('https://shop_one.example.test/:alice:Secret1')).toBe('host-underscore')
    expect(classifyChange('https://portal.example.test./:alice@mail.test:Secret1', cred('', 'alice@mail.test'), cred('https://portal.example.test./', 'alice@mail.test'), cred('', 'alice@mail.test'))).toBe('host-trailing-dot')
    expect(classifyChange(`https://android://${id(1)}/:alice:Secret1`, rejected, cred(`android://${id(1)}/`), rejected)).toBe('android-web-prefix')
    expect(classifyChange(`https://android://${id(1)}/:alice@mail.test:Secret1`, cred('', 'alice@mail.test'), cred(`android://${id(1)}/`, 'alice@mail.test'), cred('', 'alice@mail.test'))).toBe('android-web-prefix')
  })

  test('a changed result the rules do not explain stays unexplained', () => {
    // the same e-mail credential, but the password differs: the host rule must not claim it
    expect(classifyChange('https://portal.example.test./:alice@mail.test:Secret1', cred('', 'alice@mail.test', 'Other22'), cred('https://portal.example.test./', 'alice@mail.test'), cred('', 'alice@mail.test', 'Other22'))).toBe('unexplained')
    // a line without the prefix is never attributed to rule O
    expect(classifyChange('https://shop.example.test/:alice:Secret1', cred('https://shop.example.test/'), cred('https://shop.example.test/', 'bob'), cred('https://shop.example.test/'))).toBe('unexplained')
  })

  test('the url-less row the baseline stored is the one that is gone', () => {
    expect(classifyOldOnlyRow({ url: '', email: 'alice@mail.test', password: 'Secret1' }, { siteTwin: true })).toBe('site-added')
    expect(classifyOldOnlyRow({ url: '', email: 'alice@mail.test', password: 'Secret1' })).not.toBe('site-added')
    expect(classifyOldOnlyRow({ url: 'https://shop.example.test/', email: 'alice', password: 'Secret1' }, { siteTwin: true })).not.toBe('site-added')
  })
})
