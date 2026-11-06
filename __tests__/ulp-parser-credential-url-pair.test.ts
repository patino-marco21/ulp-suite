/**
 * "alice:Secret1 http://shop.example.test/login": login:password, one space, then the url. The mirror of "url login:password" (ulp-parser-url-space-pair.test.ts),
 * which the parser already reads. In a batch of five dumps 4.11% of one file and 2.30% of another were of this shape, and every one was rejected as "no_fields",
 * which also made the quality gate hold the second file on its first million lines. The rule is only a fallback, tried after every other split found no fields, so a line
 * that parsed before parses the same. All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'

const src = 'credential-url.txt'
const parse = (line: string) => parseLine(line, src)

describe('login:password, a space, then the url', () => {
  test.each([
    ['a path', 'alice:Secret1 http://shop.example.test/login', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['no path', 'alice:Secret1 http://shop.example.test', 'http://shop.example.test', 'alice', 'Secret1'],
    ['https', 'alice:Secret1 https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['a port', 'alice:Secret1 http://shop.example.test:8080/login', 'http://shop.example.test:8080/login', 'alice', 'Secret1'],
    ['an e-mail login', 'alice@mail.test:Secret1 http://shop.example.test/login', 'http://shop.example.test/login', 'alice@mail.test', 'Secret1'],
    ['several spaces', 'alice:Secret1   http://shop.example.test/login', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['a line ending in CRLF', 'alice:Secret1 http://shop.example.test/login\r', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['a colon in the password (the first colon ends the login, as in "login:password")', 'alice:pa:ss1 http://shop.example.test/login', 'http://shop.example.test/login', 'alice', 'pa:ss1'],
    ['a url that holds a url', 'alice:Secret1 https://shop.example.test/login?next=https://other.test/home', 'https://shop.example.test/login?next=https://other.test/home', 'alice', 'Secret1'],
  ])('is read as url, login, password (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })

  test('the domain is the url\'s host', () => {
    expect(parse('alice:Secret1 https://shop.example.test/login').credential?.domain).toBe('shop.example.test')
  })
})

describe('what is not read that way', () => {
  test.each([
    ['a login that holds a "/" (a path, not a login)', 'alice/x:Secret1 http://shop.example.test/login'],
    ['a password with a space in it', 'alice:Secret 1 http://shop.example.test/login'],
    ['a login and no password', 'alice http://shop.example.test/login'],
    ['an empty password (a label in front of a url)', 'alice: http://shop.example.test/login'],
    ['an empty login', ':Secret1 http://shop.example.test/login'],
    ['a password shorter than three characters (the usual rule)', 'alice:ab http://shop.example.test/login'],
    ['a url with a space in it', 'alice:Secret1 http://shop.example.test/a b'],
    ['a scheme other than http and https', 'alice:Secret1 ftp://files.example.test/'],
    ['a label in front of a Telegram link', 'Login: https://t.me/SomeChannel'],
  ])('%s is still rejected', (_label, line) => {
    expect(parse(line).credential).toBeNull()
  })

  test('a Telegram link is never the url (the tag stripper cuts it before any split, as before)', () => {
    expect(parse('Telegram:@SomeChannel https://t.me/SomeChannel').credential?.url ?? '').not.toContain('t.me')
  })

  test('a line the other splits can take parses as before', () => {
    expect(parse('http://shop.example.test/login alice:Secret1').credential).toMatchObject({ url: 'http://shop.example.test/login', email: 'alice', password: 'Secret1' })
    expect(parse('http://shop.example.test/login:alice:Secret1').credential).toMatchObject({ url: 'http://shop.example.test/login', email: 'alice', password: 'Secret1' })
    expect(parse('alice@mail.test:Secret1').credential).toMatchObject({ url: '', email: 'alice@mail.test', password: 'Secret1' })
  })

  test('the policies after the split still apply: a placeholder login is garbage, a hard-dropped tier is dropped', () => {
    const placeholder = parse('UNKNOWN:Secret1 http://shop.example.test/login')
    expect(placeholder.credential).toBeNull()
    expect(placeholder.reason).toBe('garbage')
    const dropped = parseLine('alice@mail.test:Secret1 http://shop.example.test/login', src, () => true)
    expect(dropped.credential).toBeNull()
    expect(dropped.reason).toBe('tier_dropped')
  })
})

describe('in a file', () => {
  const content = ['alice:Secret1 http://one.example.test/login', 'bob:Secret2 http://two.example.test', 'http://three.example.test/ carol:Secret3'].join('\n') + '\n'

  test('parseULPContent keeps all three and opens no positional record', () => {
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['alice', 'bob', 'carol'])
  })

  test('parseULPStream keeps all three and opens no positional record', async () => {
    const out: string[] = []
    const body = new Response(content).body as ReadableStream<Uint8Array>
    for await (const batch of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) out.push(...batch.credentials.map(c => c.email))
    expect(out).toEqual(['alice', 'bob', 'carol'])
  })
})

describe('a degenerate line takes linear time', () => {
  // One line of a few hundred thousand characters held the importer's thread for minutes once (ulp-recover-linear-time.test.ts); a new fallback must not repeat that.
  const n = 300_000
  test.each([
    ['a long run of spaces after login:password', 'alice:Secret1' + ' '.repeat(n) + 'x'],
    ['a long run of spaces and then a url', 'alice:Secret1' + ' '.repeat(n) + 'http://shop.example.test/'],
    ['a long password and then a url', 'alice:' + 'p'.repeat(n) + ' http://shop.example.test/'],
    ['a long run of spaces in front', ' '.repeat(n) + 'alice:Secret1 http://shop.example.test/'],
    ['many "login:" pieces', 'a:'.repeat(n / 2) + ' http://shop.example.test/'],
    ['a long url', 'alice:Secret1 http://shop.example.test/' + 'a'.repeat(n)],
  ])('%s', (_label, line) => {
    const t0 = performance.now()
    parse(line)
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
