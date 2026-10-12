/**
 * Parser v6 (spec 2026-10-12): layouts that used to be rejected are read, and `login == password` is rejected only for an e-mail login.
 * Every fixture is synthetic. The "unchanged" tests pin lines whose result must not move.
 */
import { describe, expect, test } from 'vitest'
import { parseLine } from '@/lib/ulp-parser'

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
