/**
 * "https://alice@mail.test:Secret1": an e-mail address and a password behind a stray scheme, no url (the url field was empty when the list was
 * made). One 100 MB file of a Telegram combo list held 216,000 of them (7% of its lines); the field split rejected every one as "no_fields".
 * They are salvaged as an e-mail:password pair with no url, like "alice@mail.test:Secret1". All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'

const src = 'scheme-email.txt'
const parse = (line: string) => parseLine(line, src)

describe('a stray scheme in front of an e-mail login', () => {
  test.each([
    ['https', 'https://alice@mail.test:Secret1'],
    ['http', 'http://alice@mail.test:Secret1'],
    ['upper case', 'HTTPS://alice@mail.test:Secret1'],
    ['a line ending in CRLF', 'https://alice@mail.test:Secret1\r'],
  ])('is an e-mail:password pair with no url (%s)', (_label, line) => {
    expect(parse(line).credential).toEqual({ url: '', email: 'alice@mail.test', password: 'Secret1', domain: 'mail.test', source_file: src })
  })

  test('parses like the same pair without the scheme', () => {
    expect(parse('https://alice@mail.test:Secret1').credential).toEqual(parse('alice@mail.test:Secret1').credential)
  })

  test('a second colon makes it a three-field line, as before (url, login, password)', () => {
    expect(parse('https://alice@mail.test:bob:Secret1').credential).toMatchObject({ url: 'https://alice@mail.test', email: 'bob', password: 'Secret1' })
  })

  test('the normal three-field lines are unchanged', () => {
    expect(parse('https://shop.example.test:alice@mail.test:Secret1').credential).toMatchObject({ url: 'https://shop.example.test', email: 'alice@mail.test', password: 'Secret1' })
    expect(parse('https://shop.example.test/login:alice@mail.test:Secret1').credential).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1' })
  })
})

describe('what is not salvaged', () => {
  test.each([
    ['a host and a password, no login', 'https://shop.example.test:Secret1'],
    ['a url with user info and a port', 'https://alice@mail.test:8080'],
    ['a url with user info and the highest port', 'https://alice@mail.test:65535'],
    ['an app id', 'android://AbC-dEf==@com.example.app:Secret1'],
    ['a user name that is not an e-mail address', 'https://alice@localhost:Secret1'],
    ['an empty password', 'https://alice@mail.test:'],
    ['a password with a "/" in it (the field split takes it for a path)', 'https://alice@mail.test:Pass/word1'],
  ])('%s', (_label, line) => {
    expect(parse(line).credential).toBeNull()
  })

  test('a number past the port range is a password', () => {
    expect(parse('https://alice@mail.test:123456').credential).toMatchObject({ email: 'alice@mail.test', password: '123456' })
  })
})

describe('in a file', () => {
  const content = ['https://alice@mail.test:Secret1', 'https://one.example.test:carol:Secret2', 'https://bob@mail.test:Secret3'].join('\n') + '\n'

  test('parseULPContent keeps all three and never opens a positional record', () => {
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['alice@mail.test', 'carol', 'bob@mail.test'])
  })

  test('parseULPStream keeps all three and never opens a positional record', async () => {
    const out: string[] = []
    const body = new Response(content).body as ReadableStream<Uint8Array>
    for await (const batch of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) out.push(...batch.credentials.map(c => c.email))
    expect(out).toEqual(['alice@mail.test', 'carol', 'bob@mail.test'])
  })
})
