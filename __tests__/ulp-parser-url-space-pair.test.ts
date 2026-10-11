/**
 * "http://shop.example.test/login alice:Secret1": a url, one space, then login:password. About 3% of the lines of a large Telegram combo
 * list were of this shape and were rejected as "no_fields". The rule is only a fallback: a line the field split can take parses as before.
 * All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'

const src = 'url-space.txt'
const parse = (line: string) => parseLine(line, src)

describe('url, a space, then login:password', () => {
  test.each([
    ['a path', 'http://shop.example.test/login alice:Secret1', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['no path', 'http://shop.example.test alice:Secret1', 'http://shop.example.test', 'alice', 'Secret1'],
    ['https', 'https://shop.example.test/login alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['a port', 'http://shop.example.test:8080/login alice:Secret1', 'http://shop.example.test:8080/login', 'alice', 'Secret1'],
    ['an e-mail login', 'http://shop.example.test/login alice@mail.test:Secret1', 'http://shop.example.test/login', 'alice@mail.test', 'Secret1'],
    ['several spaces', 'http://shop.example.test/login   alice:Secret1', 'http://shop.example.test/login', 'alice', 'Secret1'],
    ['a line ending in CRLF', 'http://shop.example.test/login alice:Secret1\r', 'http://shop.example.test/login', 'alice', 'Secret1'],
  ])('is read as url, login, password (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })
})

describe('what is not read that way', () => {
  test.each([
    ['a login that holds a "/" (a path or a port written after the host)', 'http://134.35.80.224 80**/:alice:Secret1'],
    ['a password with a space in it', 'http://shop.example.test/login alice:Secret 1'],
    ['a line without a scheme', 'shop.example.test/login alice:Secret1'],
    ['a single value after the url', 'http://shop.example.test/login alice'],
    ['a url and a password only', 'http://shop.example.test/login :Secret1'],
    ['a Telegram banner is not a url', 'https://t.me/SomeChannel Daily:Updates'],
    ['a second colon: the field split takes it as url, login, password (and rejects the short password), as before', 'http://shop.example.test/login alice:pa:ss'],
  ])('%s is still rejected', (_label, line) => {
    expect(parse(line).credential).toBeNull()
  })

  test('a line the field split can take parses as before, even with a space in the url', () => {
    expect(parse('http://shop.example.test/a b:alice:Secret1').credential).toMatchObject({ url: 'http://shop.example.test/a b', email: 'alice', password: 'Secret1' })
    expect(parse('http://shop.example.test/login:alice:Secret1').credential).toMatchObject({ url: 'http://shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
})

describe('in a file', () => {
  const content = ['http://one.example.test/login alice:Secret1', 'http://two.example.test:bob:Secret2', 'http://three.example.test/ carol:Secret3'].join('\n') + '\n'

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
