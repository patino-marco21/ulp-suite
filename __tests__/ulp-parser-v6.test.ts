/**
 * Parser v6 (spec 2026-10-12): layouts that used to be rejected are read, and `login == password` is rejected only for an e-mail login.
 * Every fixture is synthetic. The "unchanged" tests pin lines whose result must not move.
 */
import { describe, expect, test } from 'vitest'
import { parseInlineLine, parseLine, parseULPStream } from '@/lib/ulp-parser'

const src = 'v6.txt'
const cred = (line: string) => parseLine(line, src).credential
const why = (line: string) => parseLine(line, src).reason
const fields = (line: string) => { const c = cred(line); return c && { url: c.url, email: c.email, password: c.password, domain: c.domain } }

describe('rule A: space-padded colons without a scheme', () => {
  test('host : e-mail : password', () => {
    expect(fields('shop.example.test : alice@mail.test : Secret1')).toEqual({ url: 'shop.example.test', email: 'alice@mail.test', password: 'Secret1', domain: 'shop.example.test' })
  })
  test('host/path : login : password', () => {
    expect(fields('shop.example.test/login : alice : Secret1')).toMatchObject({ url: 'shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
  test('e-mail : password has no url', () => {
    expect(fields('alice@mail.test : Secret1')).toEqual({ url: '', email: 'alice@mail.test', password: 'Secret1', domain: 'mail.test' })
  })
  test('a banner stays rejected', () => {
    expect(cred('BTC : Secret1')).toBeNull()
    expect(cred('Join us : alice : Secret1')).toBeNull()
  })
})

describe('rule C: a slash in the password', () => {
  test('e-mail login', () => {
    expect(fields('https://shop.example.test:alice@mail.test:Pass/word1')).toMatchObject({ url: 'https://shop.example.test', email: 'alice@mail.test', password: 'Pass/word1', domain: 'shop.example.test' })
  })
  test('another login', () => {
    expect(fields('https://shop.example.test:alice:Pass/word1')).toMatchObject({ url: 'https://shop.example.test', email: 'alice', password: 'Pass/word1' })
  })
  test('a password that is a URL fragment is still rejected', () => {
    expect(cred('https://shop.example.test:alice:www.other.test/login')).toBeNull()
    expect(why('https://shop.example.test:alice:www.other.test/login')).toBe('no_fields')
  })
  test('lines that parse today are untouched', () => {
    expect(fields('https://shop.example.test/login:alice:Secret1')).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' })
    expect(fields('https://shop.example.test:8443/login:alice:Secret1')).toMatchObject({ url: 'https://shop.example.test:8443/login', email: 'alice' })
  })
})

describe('rule D: a number after the host that is not a web port is the login', () => {
  test('48213 is a login', () => {
    expect(fields('https://shop.example.test:48213:Secret1')).toMatchObject({ url: 'https://shop.example.test', email: '48213', password: 'Secret1' })
  })
  test('8080 is a port: the line stays rejected', () => {
    expect(cred('https://shop.example.test:8080:Secret1')).toBeNull()
  })
})

describe('rule E: a protocol-relative url', () => {
  test('//host/path:login:password is a scheme-less url', () => {
    expect(fields('//shop.example.test/login:alice:Secret1')).toMatchObject({ url: 'shop.example.test/login', email: 'alice', password: 'Secret1', domain: 'shop.example.test' })
  })
  test('a trailing :https is cut', () => {
    expect(fields('//shop.example.test/login:alice:Secret1:https')).toMatchObject({ url: 'shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
  test('a real comment stays blank', () => {
    expect(why('// not a credential')).toBe('blank')
    expect(why('//TODO:fix:this')).toBe('blank')
  })
  test('a password that is a URL fragment is garbage', () => {
    expect(why('//shop.example.test/login:alice:www.other.test/x')).toBe('garbage')
  })
})

describe('login == password', () => {
  test('a login that is not an e-mail address is accepted', () => {
    expect(fields('https://shop.example.test/login:admin:admin')).toMatchObject({ email: 'admin', password: 'admin' })
    expect(cred('user:user')).not.toBeNull()
  })
  test('an e-mail login equal to the password is still rejected', () => {
    expect(why('alice@mail.test:alice@mail.test')).toBe('no_password')
    expect(why('https://shop.example.test/login:alice@mail.test:alice@mail.test')).toBe('no_password')
  })
  test('a password under three characters is still rejected', () => {
    expect(why('https://shop.example.test/login:alice:ab')).toBe('no_password')
  })
})

async function streamParse(content: string, dedupInFile = false) {
  const credentials: Array<{ url: string; email: string; password: string }> = []
  let rejected = 0
  let dedup = 0
  const body = new Response(content).body as ReadableStream<Uint8Array>
  for await (const b of parseULPStream(body, src, 1000, undefined, { dedupInFile })) {
    credentials.push(...b.credentials)
    rejected += b.rejected
    dedup += b.breakdown.dedup
  }
  return { credentials, rejected, dedup }
}

describe('rule B: Android app ids without their scheme (stream parser)', () => {
  const id = (n: number) => `AbCdEfGhIjKlMnOpQrSt${n}==@com.example.app${n}`
  const line = (n: number, login = 'alice@mail.test', pw = 'Secret1') => `${id(n)}/:${login}:${pw}\n`

  test('the scheme is put back and the row looks like the ones that kept it', async () => {
    const r = await streamParse(line(1))
    expect(r.credentials).toEqual([expect.objectContaining({ url: `android://${id(1)}/`, email: 'alice@mail.test', password: 'Secret1' })])
  })

  test('the same login and password under many app ids is one row per file', async () => {
    const r = await streamParse(line(1) + line(2) + line(3) + line(4, 'alice@mail.test', 'Other-pw1'))
    expect(r.credentials.map(c => c.password)).toEqual(['Secret1', 'Other-pw1'])
    expect(r.dedup).toBe(2)
    expect(r.rejected).toBe(2)
  })

  test('the per-file rule applies even when in-file dedup is off (novelty-aware ingest)', async () => {
    const r = await streamParse(line(1) + line(2), false)
    expect(r.credentials).toHaveLength(1)
  })

  test('lines that kept their android:// prefix are not touched by it', async () => {
    const kept = (n: number) => `android://${id(n)}/:alice@mail.test:Secret1\n`
    const r = await streamParse(kept(1) + kept(2))
    expect(r.credentials).toHaveLength(2)
  })

  test('parseInlineLine says when the scheme was put back', () => {
    const r = parseInlineLine(`${id(1)}/:alice@mail.test:Secret1`, src)
    expect(r.androidRecovered).toBe(true)
    expect(r.credential?.url).toBe(`android://${id(1)}/`)
    expect(parseInlineLine('https://shop.example.test/login:alice:Secret1', src).androidRecovered).toBe(false)
  })
})
