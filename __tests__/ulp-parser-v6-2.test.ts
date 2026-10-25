/**
 * Parser v6.2 (docs/superpowers/specs/2026-10-24-parser-v6-2-and-gate-noise-design.md): four layouts the quality gate caught in real files, each of which parseLine
 * stored as a wrong split (or not at all), and the test for a line that cannot hold a credential. Every fixture is synthetic (made-up hosts, logins and passwords).
 *
 *   J  ":https://host/path:login:pass"          a colon in front of the scheme is an empty first field, not part of the url
 *   K  "login;password:https://host/path"        the url comes last, behind a semicolon-separated pair
 *   L  "host/|Username:login:Password:pass"      a labelled pair behind a pipe
 *   M  "https://host/a?next=https://other/b:login:pass"   a "://" inside the url is not a field separator
 *
 * The "unchanged" tests pin the layouts that already parsed, so a rule cannot grow past the lines it was written for.
 */
import { describe, expect, test } from 'vitest'
import { parseInlineLine, parseLine, parseULPStream } from '@/lib/ulp-parser'
import {
  cannotHoldCredential, splitPipedLabelledPair, splitSemicolonPasswordUrl, stripLeadingColonBeforeScheme,
} from '@/lib/ulp-recover'

const src = 'v62.txt'
const cred = (line: string) => parseLine(line, src).credential
const fields = (line: string) => { const c = cred(line); return c && { url: c.url, email: c.email, password: c.password, domain: c.domain } }
const reason = (line: string) => parseLine(line, src).reason

describe('rule J: a colon in front of the scheme', () => {
  test('is dropped, so the url, its host and its scheme are clean', () => {
    expect(fields(':https://shop.example.test/login:alice@mail.test:Secret1')).toEqual({ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1', domain: 'shop.example.test' })
  })
  test.each([
    ['a host and a port', ':https://shop.example.test:8443:alice:Secret1', 'https://shop.example.test:8443', 'alice', 'Secret1'],
    ['a host and a path', ':https://shop.example.test/:alice:Secret1', 'https://shop.example.test/', 'alice', 'Secret1'],
    ['http', ':http://shop.example.test/login:alice:Secret1', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['an app id', ':android://hash@com.example.app:alice:Secret1', 'android://hash@com.example.app', 'alice', 'Secret1'],
    ['two colons', '::https://shop.example.test/login:alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['a url, a space and e-mail:password', ':https://shop.example.test/a alice@mail.test:Secret1', 'https://shop.example.test/a', 'alice@mail.test', 'Secret1'],
    ['a pipe that joins the url and the credential', ':https://shop.example.test|alice:Secret1', 'https://shop.example.test', 'alice', 'Secret1'],
  ])('%s', (_label, line, url, email, password) => {
    expect(cred(line)).toMatchObject({ url, email, password })
  })
  test('parseInlineLine (the importer\'s entry) reads it the same way', () => {
    expect(parseInlineLine(':https://shop.example.test/login:alice:Secret1', src).credential).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
  test('a url with one field behind it is still not a credential', () => {
    expect(cred(':https://shop.example.test:8443:Secret1')).toBeNull()
    expect(reason(':https://shop.example.test:8443:Secret1')).toBe('no_fields')
  })

  describe('stripLeadingColonBeforeScheme', () => {
    test.each([
      [':https://a.test/x', 'https://a.test/x'],
      ['::http://a.test', 'http://a.test'],
      [':android://hash@com.app:x:y', 'android://hash@com.app:x:y'],
      [':HTTPS://a.test', 'HTTPS://a.test'],
    ])('%s -> %s', (line, out) => expect(stripLeadingColonBeforeScheme(line)).toBe(out))
    test.each([
      ['https://a.test/x'],            // no colon in front
      [':alice:Secret1'],              // a colon, but no scheme behind it
      [': https://a.test'],            // a space
      [':/path:x:y'],
      [':'],
      [''],
      [':1http://a.test'],             // a scheme starts with a letter
      ['a:https://a.test'],            // the colon is not the first character
    ])('%j is left as it is', line => expect(stripLeadingColonBeforeScheme(line)).toBe(line))
  })
})

describe('rule K: login;password:url', () => {
  test.each([
    ['a path', 'alice;Secret1:https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['no path', 'alice;Secret1:https://shop.example.test', 'https://shop.example.test', 'alice', 'Secret1'],
    ['a trailing slash', 'alice;Secret1:https://shop.example.test/', 'https://shop.example.test/', 'alice', 'Secret1'],
    ['a port', 'alice;Secret1:https://shop.example.test:8443/login', 'https://shop.example.test:8443/login', 'alice', 'Secret1'],
    ['http', 'alice;Secret1:http://shop.example.test/login', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['an e-mail login', 'alice@mail.test;Secret1:https://shop.example.test/login', 'https://shop.example.test/login', 'alice@mail.test', 'Secret1'],
    ['a number with dots and a dash as the login', '122.895.087-30;Secret1:https://shop.example.test/login', 'https://shop.example.test/login', '122.895.087-30', 'Secret1'],
    ['a colon in the password', 'alice;pa:ss:https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'pa:ss'],
    ['a semicolon in the password', 'alice;pa;ss:https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'pa;ss'],
    ['a semicolon in front of the url', 'alice;Secret1;https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['a semicolon in front of an address with a port', 'admin;admin;http://10.20.30.40:8090/', 'http://10.20.30.40:8090/', 'admin', 'admin'],
    ['a semicolon in front of the url and an e-mail login', 'alice@mail.test;Secret1;https://shop.example.test:2083', 'https://shop.example.test:2083', 'alice@mail.test', 'Secret1'],
    ['a semicolon in front of a url whose path holds a colon', 'alice;Secret1;https://shop.example.test/app/login.xhtml:flow=ab12', 'https://shop.example.test/app/login.xhtml:flow=ab12', 'alice', 'Secret1'],
    ['a line ending in CRLF', 'alice;Secret1:https://shop.example.test/login\r', 'https://shop.example.test/login', 'alice', 'Secret1'],
  ])('is read as login, password, url (%s)', (_label, line, url, email, password) => {
    expect(cred(line)).toMatchObject({ url, email, password })
  })
  test('the domain comes from the url', () => {
    expect(cred('alice;Secret1:https://shop.example.test/login')?.domain).toBe('shop.example.test')
  })

  describe('what is not read that way', () => {
    test.each([
      ['a url that holds another colon in its path', 'alice;Secret1:https://shop.example.test/a:b'],
      ['a scheme that is not http', 'alice;Secret1:ftp://shop.example.test/login'],
      ['a login that is a path', 'a/b;Secret1:https://shop.example.test/login'],
      ['a login with a space in it', 'alice smith;Secret1:https://shop.example.test/login'],
      ['an empty password', 'alice;:https://shop.example.test/login'],
      ['no password at all', 'alice;https://shop.example.test/login'],
      ['url first and a url as the last field', 'https://one.example.test;alice;https://two.example.test'],
      ['a url with white space in it', 'alice;Secret1;https://shop.example.test/a b'],
    ])('%s keeps the reading it had', (_label, line) => {
      expect(splitSemicolonPasswordUrl(line)).toBeNull()
    })
    test.each([
      ['a plain pair', 'alice;Secret1', '', 'alice', 'Secret1'],
      ['url;login;password', 'https://shop.example.test/login;alice;Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
      ['a credential followed by a semicolon and a note', 'alice@mail.test:Secret1;note', '', 'alice@mail.test', 'Secret1;note'],
      ['a path parameter in a url', 'https://shop.example.test/login;jsessionid=AB12:alice:Secret1', 'https://shop.example.test/login;jsessionid=AB12', 'alice', 'Secret1'],
    ])('a line that already parsed is unchanged (%s)', (_label, line, url, email, password) => {
      expect(cred(line)).toMatchObject({ url, email, password })
    })
    test('a Telegram tag after the pair is cut first, so it is not mistaken for the url', () => {
      expect(cred('alice;Secret1:https://t.me/SomeChannel')).toMatchObject({ url: '', email: 'alice', password: 'Secret1' })
    })
  })
})

describe('rule L: host/|Username:login:Password:password', () => {
  test.each([
    ['a host and a slash', 'shop.example.test/|Username:alice:Password:Secret1', 'shop.example.test/', 'alice', 'Secret1'],
    ['a host and a path', 'shop.example.test/login|Username:alice:Password:Secret1', 'shop.example.test/login', 'alice', 'Secret1'],
    ['an e-mail login', 'shop.example.test/|Username:alice@mail.test:Password:Secret1', 'shop.example.test/', 'alice@mail.test', 'Secret1'],
    ['a url with a scheme', 'https://shop.example.test/|Username:alice:Password:Secret1', 'https://shop.example.test/', 'alice', 'Secret1'],
    ['upper case labels', 'shop.example.test/|USERNAME:alice:PASSWORD:Secret1', 'shop.example.test/', 'alice', 'Secret1'],
    ['other label words', 'shop.example.test/|Login:alice:Pass:Secret1', 'shop.example.test/', 'alice', 'Secret1'],
    ['a colon and symbols in the password', 'shop.example.test/|Username:alice:Password:Se:cret!1', 'shop.example.test/', 'alice', 'Se:cret!1'],
    ['white space around the pipe', 'shop.example.test/ | Username:alice:Password:Secret1', 'shop.example.test/', 'alice', 'Secret1'],
  ])('is read as url, login, password (%s)', (_label, line, url, email, password) => {
    expect(cred(line)).toMatchObject({ url, email, password })
  })
  test('the domain comes from the host', () => {
    expect(cred('shop.example.test/|Username:alice:Password:Secret1')?.domain).toBe('shop.example.test')
  })
  test('parseInlineLine reads a scheme url with labels the same way (its pipe join must not run first)', () => {
    expect(parseInlineLine('https://shop.example.test/|Username:alice:Password:Secret1', src).credential).toMatchObject({ url: 'https://shop.example.test/', email: 'alice', password: 'Secret1' })
    expect(parseInlineLine('shop.example.test/|Username:alice:Password:Secret1', src).credential).toMatchObject({ url: 'shop.example.test/', email: 'alice', password: 'Secret1' })
  })

  describe('what is not read that way', () => {
    test.each([
      ['no labels', 'shop.example.test/|alice:Secret1'],
      ['a pipe where a colon belongs', 'shop.example.test/|Username:alice|Password:Secret1'],
      ['a label that is not a login label', 'shop.example.test/|Country:US:Password:Secret1'],
      ['a label that is not a password label', 'shop.example.test/|Username:alice:Country:US'],
      ['an empty login', 'shop.example.test/|Username::Password:Secret1'],
      ['an empty password', 'shop.example.test/|Username:alice:Password:'],
      ['a head that is not a url', 'Join us|Username:alice:Password:Secret1'],
      ['only one label', 'shop.example.test/|Username:alice:Secret1'],
    ])('%s', (_label, line) => {
      expect(splitPipedLabelledPair(line)).toBeNull()
    })
    test.each([
      ['url|login|password', 'https://shop.example.test/login|alice|Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
      ['login|password', 'alice|Secret1', '', 'alice', 'Secret1'],
      ['a url, a pipe and login:password (rule H)', 'https://shop.example.test/login|alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
      ['a label, a pipe and a credential (rule G)', 'Network:| shop.example.test:alice:Secret1', 'shop.example.test', 'alice', 'Secret1'],
    ])('a pipe layout that already parsed is unchanged (%s)', (_label, line, url, email, password) => {
      expect(cred(line)).toMatchObject({ url, email, password })
    })
  })
})

describe('rule M: a "://" inside the url is not a field separator', () => {
  test.each([
    ['a nested url', 'https://sso.example.test/login?service=https://app.example.test/home:alice:Secret1', 'https://sso.example.test/login?service=https://app.example.test/home', 'alice', 'Secret1'],
    ['a nested url with a port', 'https://sso.example.test/cas?next=https://app.example.test:8443/home:alice:Secret1', 'https://sso.example.test/cas?next=https://app.example.test:8443/home', 'alice', 'Secret1'],
    ['a nested url and an e-mail login', 'https://sso.example.test/cas?next=https://app.example.test/a/b?x=1:alice@mail.test:Secret1', 'https://sso.example.test/cas?next=https://app.example.test/a/b?x=1', 'alice@mail.test', 'Secret1'],
    ['a nested url in a path', 'https://web.archive.example.test/web/2020/https://shop.example.test/:alice:Secret1', 'https://web.archive.example.test/web/2020/https://shop.example.test/', 'alice', 'Secret1'],
  ])('is read as url, login, password (%s)', (_label, line, url, email, password) => {
    expect(cred(line)).toMatchObject({ url, email, password })
  })
  test('the domain is the outer host', () => {
    expect(cred('https://sso.example.test/login?service=https://app.example.test/home:alice:Secret1')?.domain).toBe('sso.example.test')
  })
  test('a nested url followed by ONE field is not a credential (it used to be stored with the url tail as the login)', () => {
    const line = 'https://sso.example.test/login?continue=https://app.example.test/home:Token1234567890'
    expect(cred(line)).toBeNull()
    expect(reason(line)).toBe('no_fields')
  })
  test.each([
    ['a plain url with a path', 'https://shop.example.test/login:alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['a query without a nested url', 'https://shop.example.test/login?next=home:alice:Secret1', 'https://shop.example.test/login?next=home', 'alice', 'Secret1'],
    ['an app id with a slash', 'android://HASHHASHHASHHASH==@com.example.app/:alice@mail.test:Secret1', 'android://HASHHASHHASHHASH==@com.example.app/', 'alice@mail.test', 'Secret1'],
    ['a password that holds a url (after the login)', 'https://shop.example.test/login:alice:see https://x.test', 'https://shop.example.test/login', 'alice', 'see https://x.test'],
  ])('a line that already parsed is unchanged (%s)', (_label, line, url, email, password) => {
    expect(cred(line)).toMatchObject({ url, email, password })
  })
})

describe('cannotHoldCredential: a rejected line that carries no credential', () => {
  test.each([
    ['an emoji banner', '💸 Premium access ➜ $50 💰'],
    ['a divider of block characters', '████████████████████████████████'],
    ['a banner with several emoji and no separator', '█ 🔥 Daily fresh logs • updated 🔥 █'],
    ['a line of punctuation only', '**********************'],
    ['a line of underscores', '______________'],
    ['a bare url', 'https://shop.example.test/login'],
    ['a bare url with a port', 'https://shop.example.test:8443'],
    ['a bare host and path', 'shop.example.test/login'],
    ['a url, a port and one field', 'https://shop.example.test:8443:Secret1'],
    ['the same with a leading colon', ':https://shop.example.test:8443:Secret1'],
    ['a url and one field', 'https://shop.example.test/login:Secret1'],
    ['a url with a nested url and one field', 'https://sso.example.test/login?continue=https://app.example.test/home:Token1234567890'],
    ['a host, a path and one field', 'shop.example.test/login:Secret1'],
  ])('%s', (_label, line) => {
    expect(cannotHoldCredential(line)).toBe(true)
  })
  test.each([
    ['plain text without a separator (a layout nobody taught the parser could look like this)', 'alice Secret1'],
    ['a bare e-mail address', 'alice@mail.test'],
    ['e-mail and password with a space', 'alice@mail.test Secret1'],
    ['login:password', 'alice:Secret1'],
    ['three fields', 'a:b:c'],
    ['a url and two fields', 'https://shop.example.test/login:alice:Secret1'],
    ['a url, a space and e-mail:password', 'https://shop.example.test/a alice@mail.test:Secret1'],
    ['a url and fields separated by semicolons', 'https://shop.example.test;alice;Secret1'],
    ['a url and fields separated by pipes', 'https://shop.example.test|alice|Secret1'],
    ['a host, a path and two fields', 'shop.example.test/login:alice:Secret1'],
    ['a banner that has a colon', 'Join us on Telegram: https://t.me/Channel'],
    ['a tab-separated line', 'shop.example.test\talice\tSecret1'],
  ])('%s is still counted', (_label, line) => {
    expect(cannotHoldCredential(line)).toBe(false)
  })
})

describe('in a stream', () => {
  const lines = [
    ':https://one.example.test/login:alice:Secret1',             // J
    'bob;Secret2:https://two.example.test/login',                // K
    'three.example.test/|Username:carol:Password:Secret3',       // L
    'https://sso.example.test/x?next=https://four.example.test/y:dave:Secret4',  // M
    '💸 Premium access ➜ $50 💰',                                 // a banner
    '████████████████████',                                      // a divider
    'https://five.example.test:8443:Secret5',                    // one field behind a url
    'erin:Secret6',                                              // an ordinary pair
  ].join('\n') + '\n'
  const run = async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines)); c.close() } })
    const out: { credentials: Array<{ url: string; email: string; password: string }>; rejected: number; breakdown: Record<string, number>; noCredential?: number }[] = []
    for await (const b of parseULPStream(body, 'v62.txt', 100, undefined, { dedupInFile: false })) out.push(b)
    return out
  }
  test('the four layouts are stored with clean fields', async () => {
    const rows = (await run()).flatMap(b => b.credentials).map(c => `${c.url} | ${c.email} | ${c.password}`)
    expect(rows).toEqual([
      'https://one.example.test/login | alice | Secret1',
      'https://two.example.test/login | bob | Secret2',
      'three.example.test/ | carol | Secret3',
      'https://sso.example.test/x?next=https://four.example.test/y | dave | Secret4',
      ' | erin | Secret6',
    ])
  })
  test('the lines that carry no credential are rejected as no_fields and counted apart', async () => {
    const batches = await run()
    const noFields = batches.reduce((n, b) => n + (b.breakdown.no_fields ?? 0), 0)
    const noCredential = batches.reduce((n, b) => n + (b.noCredential ?? 0), 0)
    expect(noFields).toBe(3)        // the banner, the divider and the url with one field
    expect(noCredential).toBe(3)    // all three cannot hold a credential
  })
  test('an unreadable line that does look like a credential is not counted apart', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('alice@mail.test\nalice Secret1\n')); c.close() } })
    let noFields = 0, noCredential = 0
    for await (const b of parseULPStream(body, 'v62.txt', 100, undefined, { dedupInFile: false })) { noFields += b.breakdown.no_fields ?? 0; noCredential += b.noCredential ?? 0 }
    expect(noFields).toBeGreaterThan(0)
    expect(noCredential).toBe(0)
  })
})
