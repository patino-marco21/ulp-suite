/** The pure helpers behind the parser v6 recovery rules (spec 2026-10-12). All fixtures are synthetic. */
import { describe, expect, test } from 'vitest'
import {
  COMMON_WEB_PORTS, looksLikeUrlFragment, protocolRelativeToPlain, recoverAndroidAppLine,
  splitNumericLogin, splitSlashInPassword, splitSpacePaddedColons,
} from '@/lib/ulp-recover'

describe('looksLikeUrlFragment', () => {
  test.each([
    'www.other.test/login', 'https://x.test/a', 'other.example.test/login?x=1', 'a?b=1', 'page.php', 'index.html', 'login.aspx',
    'a/b/c/d', 'x.test/path', 'one.two.test/a',
  ])('%s is a fragment', pw => expect(looksLikeUrlFragment(pw)).toBe(true))

  test.each(['Pa/ss1', 'p@ss/word', 'a/b', 'a/b/c', 'Secret1', 'abc/def.ghi', 'Tr0ub4dor&3/x'])('%s is a password', pw =>
    expect(looksLikeUrlFragment(pw)).toBe(false))
})

describe('splitSpacePaddedColons (rule A)', () => {
  test('host : login : password', () => {
    expect(splitSpacePaddedColons('shop.example.test : alice@mail.test : Secret1')).toEqual(['shop.example.test', 'alice@mail.test', 'Secret1'])
  })
  test('any amount of white space around the colons, a path in the host', () => {
    expect(splitSpacePaddedColons('shop.example.test/login  :  alice  :   Secret1')).toEqual(['shop.example.test/login', 'alice', 'Secret1'])
  })
  test('e-mail : password (two parts) needs an e-mail login', () => {
    expect(splitSpacePaddedColons('alice@mail.test : Secret1')).toEqual(['', 'alice@mail.test', 'Secret1'])
    expect(splitSpacePaddedColons('BTC : Secret1')).toBeNull()
  })
  test('banners, hosts with white space and lines with a scheme are left alone', () => {
    expect(splitSpacePaddedColons('Join us : alice : Secret1')).toBeNull()
    expect(splitSpacePaddedColons('Daily : alice : Secret1')).toBeNull() // no dot or slash in the first part
    expect(splitSpacePaddedColons('https://shop.example.test : alice : Secret1')).toBeNull()
  })
  test('an e-mail first part with more padded colons is a login and a password that holds one', () => {
    expect(splitSpacePaddedColons('alice@mail.test : pass : word')).toBeNull()
  })
  test('an ordinary colon line is not touched', () => {
    expect(splitSpacePaddedColons('shop.example.test:alice:Secret1')).toBeNull()
    expect(splitSpacePaddedColons('shop.example.test : alice@mail.test :')).toBeNull()
  })
})

describe('splitSlashInPassword (rule C)', () => {
  test('an e-mail login', () => {
    expect(splitSlashInPassword('https://shop.example.test:alice@mail.test:Pass/word1')).toEqual(['https://shop.example.test', 'alice@mail.test', 'Pass/word1'])
  })
  test('another login, with a port', () => {
    expect(splitSlashInPassword('https://shop.example.test:8443:alice:Pass/word1')).toEqual(['https://shop.example.test:8443', 'alice', 'Pass/word1'])
  })
  test('a password that looks like a URL fragment is refused', () => {
    expect(splitSlashInPassword('https://shop.example.test:alice:www.other.test/login')).toBeNull()
    expect(splitSlashInPassword('https://shop.example.test:alice:Pass/wor/d1/x')).toBeNull()
  })
  test('a url with a path, userinfo, a numeric login or another scheme is not this rule', () => {
    expect(splitSlashInPassword('https://shop.example.test/login:alice:Secret1')).toBeNull()
    expect(splitSlashInPassword('https://user:pw@shop.example.test/login:alice:Secret1')).toBeNull()
    expect(splitSlashInPassword('https://shop.example.test:48213:Pass/word1')).toBeNull()
    expect(splitSlashInPassword('ftp://shop.example.test:alice:Pass/word1')).toBeNull()
  })
})

describe('splitNumericLogin (rule D)', () => {
  test('a number after the host that is not a web port is a login', () => {
    expect(splitNumericLogin('https://shop.example.test:48213:Secret1')).toEqual(['https://shop.example.test', '48213', 'Secret1'])
  })
  test.each(['https://shop.example.test:8080:Secret1', 'https://shop.example.test:443:Secret1', 'https://shop.example.test:65536:Secret1'])('%s is not', line =>
    expect(splitNumericLogin(line)).toBeNull())
  test('a password with a colon or a slash is not this shape', () => {
    expect(splitNumericLogin('https://shop.example.test:48213:Sec:ret')).toBeNull()
    expect(splitNumericLogin('https://shop.example.test:48213:pa/ss')).toBeNull()
  })
  test('the common web ports', () => {
    for (const p of [80, 443, 8080, 8443, 3000, 8000, 8888, 9000]) expect(COMMON_WEB_PORTS.has(p)).toBe(true)
    expect(COMMON_WEB_PORTS.has(48213)).toBe(false)
  })
})

describe('protocolRelativeToPlain (rule E)', () => {
  test('//host/path:login:password loses its slashes', () => {
    expect(protocolRelativeToPlain('//shop.example.test/login:alice:Secret1')).toBe('shop.example.test/login:alice:Secret1')
    expect(protocolRelativeToPlain('//shop.example.test:alice:Secret1')).toBe('shop.example.test:alice:Secret1')
    expect(protocolRelativeToPlain('//shop.example.test:8080/login:alice:Secret1')).toBe('shop.example.test:8080/login:alice:Secret1')
  })
  test('a trailing :http or :https (a scheme moved to the end) is cut', () => {
    expect(protocolRelativeToPlain('//shop.example.test/login:alice:Secret1:https')).toBe('shop.example.test/login:alice:Secret1')
    expect(protocolRelativeToPlain('//shop.example.test/login:alice:Secret1:HTTP')).toBe('shop.example.test/login:alice:Secret1')
  })
  test('comments, three slashes, hosts without a dot and short lines stay as they are', () => {
    expect(protocolRelativeToPlain('// a comment')).toBeNull()
    expect(protocolRelativeToPlain('//TODO:fix:this')).toBeNull()
    expect(protocolRelativeToPlain('///shop.example.test:alice:Secret1')).toBeNull()
    expect(protocolRelativeToPlain('//shop.example.test/login:alice')).toBeNull()
    expect(protocolRelativeToPlain('shop.example.test:alice:Secret1')).toBeNull()
  })
})

describe('recoverAndroidAppLine (rule B)', () => {
  const hash = 'AbCdEfGhIjKlMnOpQrSt'
  test('an app id without its scheme gets android:// back', () => {
    expect(recoverAndroidAppLine(`${hash}==@com.example.app/:alice@mail.test:Secret1`)).toBe(`android://${hash}==@com.example.app/:alice@mail.test:Secret1`)
  })
  test('with a leading // only the scheme name is missing', () => {
    expect(recoverAndroidAppLine(`//${hash}==@com.example.app/:alice@mail.test:Secret1`)).toBe(`android://${hash}==@com.example.app/:alice@mail.test:Secret1`)
  })
  test('a short fingerprint, an ordinary line and a line that kept its scheme are left alone', () => {
    expect(recoverAndroidAppLine('abc==@com.example.app/:x:y')).toBeNull()
    expect(recoverAndroidAppLine('https://shop.example.test/login:alice:Secret1')).toBeNull()
    expect(recoverAndroidAppLine(`android://${hash}==@com.example.app/:alice@mail.test:Secret1`)).toBeNull()
  })
})
