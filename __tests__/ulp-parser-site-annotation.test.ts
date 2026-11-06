/**
 * "shop.example.test/login:(shop.example.test/login):alice:Secret1": a url, a parenthesised copy of the site, then login:password. The colon chain read the copy as the login
 * and "alice:Secret1" as the password (about 0.09% of the lines of the dumps looked at, 487,041 stored rows in 401 files by 2026-11-06). Parser v6.5 treats the copy as an
 * annotation when the parenthesised text repeats the url's host and the password holds a colon with something on both sides. Everything else stays as it was: a number in
 * parentheses, a bracket other than "(", text that is not the host. All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { splitSiteAnnotation } from '@/lib/ulp-recover'
import { parseLine, parseULPStream } from '@/lib/ulp-parser'

const src = 'site-annotation.txt'
const parse = (line: string) => parseLine(line, src)

describe('splitSiteAnnotation', () => {
  test.each([
    ['a path', 'shop.example.test/login', '(shop.example.test/login)', 'alice:Secret1', ['alice', 'Secret1']],
    ['a scheme in the url', 'https://shop.example.test/login', '(shop.example.test/login)', 'alice:Secret1', ['alice', 'Secret1']],
    ['www. in the url and not in the copy', 'https://www.shop.example.test/login', '(shop.example.test/login)', 'alice:Secret1', ['alice', 'Secret1']],
    ['upper case in the copy', 'https://shop.example.test/', '(SHOP.Example.test/)', 'alice:Secret1', ['alice', 'Secret1']],
    ['a port in the url', 'https://shop.example.test:8443/login', '(shop.example.test/login)', 'alice:Secret1', ['alice', 'Secret1']],
    ['an e-mail login', 'shop.example.test/login', '(shop.example.test/login)', 'alice@mail.test:Secret1', ['alice@mail.test', 'Secret1']],
    ['a colon in the password: the first colon ends the login', 'shop.example.test/login', '(shop.example.test/login)', 'alice:pa:ss1', ['alice', 'pa:ss1']],
    ['the host alone in parentheses', 'shop.example.test/login', '(shop.example.test)', 'alice:Secret1', ['alice', 'Secret1']],
  ])('is read as login, password (%s)', (_label, url, login, password, expected) => {
    expect(splitSiteAnnotation(url, login, password)).toEqual(expected)
  })

  test.each([
    ['a number in parentheses', 'shop.example.test/login', '(123)', 'alice:Secret1'],
    ['a country prefix in parentheses', 'shop.example.test/login', '(+7)', '9123456789:Secret1'],
    ['text that is not the host', 'shop.example.test/login', '(Shop App)', 'alice:Secret1'],
    ['another host', 'shop.example.test/login', '(other.example.test/login)', 'alice:Secret1'],
    ['square brackets', 'shop.example.test/login', '[shop.example.test/login]', 'alice:Secret1'],
    ['curly brackets', 'shop.example.test/login', '{shop.example.test/login}', 'alice:Secret1'],
    ['mismatched brackets', 'shop.example.test/login', '(shop.example.test/login]', 'alice:Secret1'],
    ['no closing bracket', 'shop.example.test/login', '(shop.example.test/login', 'alice:Secret1'],
    ['no colon in the password: the parenthesised text is the login', 'shop.example.test/login', '(shop.example.test/login)', 'Secret1'],
    ['nothing before the colon in the password', 'shop.example.test/login', '(shop.example.test/login)', ':Secret1'],
    ['nothing after the colon in the password', 'shop.example.test/login', '(shop.example.test/login)', 'alice:'],
    ['no url', '', '(shop.example.test/login)', 'alice:Secret1'],
    ['a url that is not a host', 'login', '(login)', 'alice:Secret1'],
    ['a login that is not wrapped', 'shop.example.test/login', 'shop.example.test/login', 'alice:Secret1'],
    ['an empty copy', 'shop.example.test/login', '()', 'alice:Secret1'],
  ])('leaves the fields alone (%s)', (_label, url, login, password) => {
    expect(splitSiteAnnotation(url, login, password)).toBeNull()
  })
})

describe('in a line', () => {
  test.each([
    ['no scheme', 'shop.example.test/login:(shop.example.test/login):alice:Secret1', 'shop.example.test/login', 'alice', 'Secret1'],
    ['a scheme', 'https://shop.example.test/login:(shop.example.test/login):alice:Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['an e-mail login', 'shop.example.test/login:(shop.example.test/login):alice@mail.test:Secret1', 'shop.example.test/login', 'alice@mail.test', 'Secret1'],
    ['CRLF', 'shop.example.test/login:(shop.example.test/login):alice:Secret1\r', 'shop.example.test/login', 'alice', 'Secret1'],
  ])('keeps the url, takes login and password after the copy (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })

  test('the domain is still the url\'s host', () => {
    expect(parse('shop.example.test/login:(shop.example.test/login):alice:Secret1').credential?.domain).toBe('shop.example.test')
  })

  test.each([
    ['a number in parentheses', 'shop.example.test/login:(123):alice:Secret1', '(123)', 'alice:Secret1'],
    ['text that is not the host', 'shop.example.test/login:(ShopApp):alice:Secret1', '(ShopApp)', 'alice:Secret1'],
    ['square brackets', 'shop.example.test/login:[shop.example.test/login]:alice:Secret1', '[shop.example.test/login]', 'alice:Secret1'],
  ])('is stored as before (%s)', (_label, line, email, password) => {
    expect(parse(line).credential).toMatchObject({ email, password })
  })

  test('a line without the copy parses as before', () => {
    expect(parse('shop.example.test/login:alice:Secret1').credential).toMatchObject({ url: 'shop.example.test/login', email: 'alice', password: 'Secret1' })
  })

  test('the policies after the split still apply: a password under three characters is dropped, a placeholder login is garbage, a hard-dropped tier is dropped', () => {
    expect(parse('shop.example.test/login:(shop.example.test/login):alice:ab').credential).toBeNull()
    expect(parse('shop.example.test/login:(shop.example.test/login):UNKNOWN:Secret1').reason).toBe('garbage')
    const dropped = parseLine('shop.example.test/login:(shop.example.test/login):alice@mail.test:Secret1', src, () => true)
    expect(dropped.credential).toBeNull()
    expect(dropped.reason).toBe('tier_dropped')
  })

  test('parseULPStream stores both layouts', async () => {
    const content = ['shop.example.test/a:(shop.example.test/a):alice:Secret1', 'shop.example.test/b:bob:Secret2'].join('\n') + '\n'
    const out: string[] = []
    const body = new Response(content).body as ReadableStream<Uint8Array>
    for await (const batch of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) out.push(...batch.credentials.map(c => `${c.email}|${c.password}`))
    expect(out).toEqual(['alice|Secret1', 'bob|Secret2'])
  })
})

describe('a degenerate line takes linear time', () => {
  const n = 300_000
  test.each([
    ['a long copy that is not the host', 'shop.example.test/login:(' + 'a'.repeat(n) + '):alice:Secret1'],
    ['a long copy made of the host\'s first characters', 'shop.example.test/login:(' + 'shop.example.tes'.repeat(n / 16) + '):alice:Secret1'],
    ['a long url', 'shop.example.test/' + 'a'.repeat(n) + ':(shop.example.test/login):alice:Secret1'],
    ['a long password with many colons', 'shop.example.test/login:(shop.example.test/login):' + 'a:'.repeat(n / 2)],
    ['many opening brackets', 'shop.example.test/login:' + '('.repeat(n) + ':alice:Secret1'],
    ['many closing brackets', 'shop.example.test/login:(shop.example.test/login' + ')'.repeat(n) + ':alice:Secret1'],
  ])('%s', (_label, line) => {
    const t0 = performance.now()
    parse(line)
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
