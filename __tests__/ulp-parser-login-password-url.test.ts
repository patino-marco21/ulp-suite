/**
 * "alice:Secret1:https://shop.example.test/login": the layout login:password:url, the url comes last. About 3 million lines of one pile
 * (170 files, up to 40% of a single file) were rejected as "no_fields" because a line that holds "://" was always read as url-first.
 * All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'

const src = 'lpu.txt'
const parse = (line: string) => parseLine(line, src)

describe('login:password:url', () => {
  test.each([
    ['a path', 'alice:Secret1:https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['no path', 'alice:Secret1:https://shop.example.test', 'https://shop.example.test', 'alice', 'Secret1'],
    ['a trailing slash', 'alice:Secret1:https://shop.example.test/', 'https://shop.example.test/', 'alice', 'Secret1'],
    ['a port', 'alice:Secret1:https://shop.example.test:8443/login', 'https://shop.example.test:8443/login', 'alice', 'Secret1'],
    ['http', 'alice:Secret1:http://shop.example.test/login', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['upper case', 'alice:Secret1:HTTPS://shop.example.test/login', 'HTTPS://shop.example.test/login', 'alice', 'Secret1'],
    ['an e-mail login', 'alice@mail.test:Secret1:https://shop.example.test/login', 'https://shop.example.test/login', 'alice@mail.test', 'Secret1'],
    ['a colon in the password', 'alice:pa:ss:https://shop.example.test/login', 'https://shop.example.test/login', 'alice', 'pa:ss'],
    ['a line ending in CRLF', 'alice:Secret1:https://shop.example.test/login\r', 'https://shop.example.test/login', 'alice', 'Secret1'],
  ])('is read as login, password, url (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })

  test('the domain comes from the url', () => {
    expect(parse('alice:Secret1:https://shop.example.test/login').credential?.domain).toBe('shop.example.test')
  })
})

describe('what is not read that way', () => {
  test.each([
    ['a url that holds another colon in its path', 'alice:Secret1:https://shop.example.test/a:b'],
    ['a url with query colons', 'alice:Secret1:https://shop.example.test/login?next=a:b'],
    ['one field in front of the url', 'alice:https://shop.example.test/login'],
    ['a scheme that is not http', 'alice:Secret1:ftp://shop.example.test/login'],
    ['a login that is a path', 'a/b:Secret1:https://shop.example.test/login'],
    ['a login with a space in it', 'alice smith:Secret1:https://shop.example.test/login'],
    ['an empty password', 'alice::https://shop.example.test/login'],
  ])('%s is still rejected', (_label, line) => {
    expect(parse(line).credential).toBeNull()
  })

  test.each([
    ['url first, a host and a login', 'https://shop.example.test:alice:Secret1', 'https://shop.example.test', 'alice', 'Secret1'],
    ['url first, with a path', 'https://shop.example.test/login:alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['an app id first', 'android://hash@com.example.app:alice:Secret1', 'android://hash@com.example.app', 'alice', 'Secret1'],
    ['a country code in front of the url', 'DZ https://shop.example.test/login:alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
  ])('a line with the url first is unchanged (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })

  test('a Telegram tag after the pair is cut first, so it is not mistaken for the url', () => {
    expect(parse('alice:Secret1:https://t.me/SomeChannel').credential).toMatchObject({ url: '', email: 'alice', password: 'Secret1' })
  })
})

describe('in a file', () => {
  const content = ['alice:Secret1:https://one.example.test/login', 'https://two.example.test:bob:Secret2', 'carol:Secret3:https://three.example.test/'].join('\n') + '\n'

  test('parseULPContent keeps all three, in either layout', () => {
    expect(parseULPContent(content, src).credentials.map(c => `${c.email}@${c.domain}`)).toEqual(['alice@one.example.test', 'bob@two.example.test', 'carol@three.example.test'])
  })

  test('parseULPStream keeps all three, in either layout', async () => {
    const out: string[] = []
    const body = new Response(content).body as ReadableStream<Uint8Array>
    for await (const batch of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) out.push(...batch.credentials.map(c => `${c.email}@${c.domain}`))
    expect(out).toEqual(['alice@one.example.test', 'bob@two.example.test', 'carol@three.example.test'])
  })
})
