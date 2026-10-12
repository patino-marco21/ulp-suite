/**
 * Parser v6.1, rule I: a ';' behind a credential that is already complete belongs to the password. "https://host:alice@mail.test:Sec;ret1" used to be read
 * as "url;login" with the whole credential as the login and "ret1" as the password (about 125k stored rows of the first pile import).
 * Every fixture is synthetic. The "unchanged" tests pin the semicolon layouts that already parse.
 */
import { describe, expect, test } from 'vitest'
import { parseLine } from '@/lib/ulp-parser'
import { holdsCredential } from '@/lib/ulp-recover'

const fields = (line: string) => { const c = parseLine(line, 'semi.txt').credential; return c && { url: c.url, email: c.email, password: c.password } }

describe('a semicolon in the password of a colon-separated line', () => {
  test.each([
    ['url, e-mail, password', 'https://shop.example.test:alice@mail.test:Sec;ret1', { url: 'https://shop.example.test', email: 'alice@mail.test', password: 'Sec;ret1' }],
    ['url with a path, login, password', 'https://shop.example.test/login:alice:Sec;ret1', { url: 'https://shop.example.test/login', email: 'alice', password: 'Sec;ret1' }],
    ['host, login, password (two colons)', 'shop.example.test:alice:Sec;ret1', { url: 'shop.example.test', email: 'alice', password: 'Sec;ret1' }],
    ['e-mail, password (no url)', 'alice@mail.test:Sec;ret1', { url: '', email: 'alice@mail.test', password: 'Sec;ret1' }],
    ['several semicolons', 'alice@mail.test:Sec;re;t1', { url: '', email: 'alice@mail.test', password: 'Sec;re;t1' }],
    ['punctuation around it', 'https://shop.example.test/login:alice@mail.test:p;w(^x', { url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'p;w(^x' }],
  ])('%s', (_label, line, want) => {
    expect(fields(line)).toMatchObject(want)
  })
})

describe('a semicolon at the end of a complete credential is a delimiter, not part of the password', () => {
  test.each([
    ['e-mail, password;', 'alice@mail.test:Secret1;', { url: '', email: 'alice@mail.test', password: 'Secret1' }],
    ['url, login, password;;', 'https://shop.example.test:alice:Secret1;;', { url: 'https://shop.example.test', email: 'alice', password: 'Secret1' }],
    ['a trailing semicolon and a space', 'https://shop.example.test/login:alice@mail.test:Secret1; ', { url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1' }],
    ['an inner semicolon stays, the last one goes', 'alice@mail.test:Sec;ret1;', { url: '', email: 'alice@mail.test', password: 'Sec;ret1' }],
  ])('%s', (_label, line, want) => {
    expect(fields(line)).toMatchObject(want)
  })
  test('a line the ";name=value" path-parameter guard already reads as one credential keeps its trailing semicolon, as before', () => {
    expect(fields('https://shop.example.test/app:alice@mail.test:i1;R=x;')).toMatchObject({ url: 'https://shop.example.test/app', email: 'alice@mail.test', password: 'i1;R=x;' })
  })
  test('url;login;password; (the semicolon layout) is not touched by it', () => {
    expect(fields('https://shop.example.test;alice;Secret1;')).toMatchObject({ url: 'https://shop.example.test', email: 'alice', password: 'Secret1;' })
  })
})

describe('the semicolon layouts that already parse do not move', () => {
  test.each([
    ['url;login;password', 'https://shop.example.test;alice;Secret1', { url: 'https://shop.example.test', email: 'alice', password: 'Secret1' }],
    ['url with a path;login;password', 'https://shop.example.test/login;alice;Secret1', { url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' }],
    ['host:port;login;password', 'shop.example.test:8080;alice;Secret1', { url: 'shop.example.test:8080', email: 'alice', password: 'Secret1' }],
    ['url with a port;login;password', 'https://shop.example.test:8443;alice;Secret1', { url: 'https://shop.example.test:8443', email: 'alice', password: 'Secret1' }],
    ['login;password', 'alice;Secret1', { url: '', email: 'alice', password: 'Secret1' }],
    ['e-mail;password', 'alice@mail.test;Secret1', { url: '', email: 'alice@mail.test', password: 'Secret1' }],
    ['url;e-mail;password with semicolons', 'https://shop.example.test;alice@mail.test;p;a;s;s', { url: 'https://shop.example.test', email: 'alice@mail.test', password: 'p;a;s;s' }],
    ['a password with a colon after url;login;', 'https://shop.example.test;alice;Sec:ret1', { url: 'https://shop.example.test', email: 'alice', password: 'Sec:ret1' }],
    ['a path parameter in the url', 'https://shop.example.test/login;jsessionid=AB12:alice:Secret1', { url: 'https://shop.example.test/login;jsessionid=AB12', email: 'alice', password: 'Secret1' }],
  ])('%s', (_label, line, want) => {
    expect(fields(line)).toMatchObject(want)
  })
})

describe('a ";name=value" path parameter in a url without a scheme', () => {
  test.each([
    ['one parameter', 'shop.example.test/app;jsessionid=AB12:alice:Secret1', { url: 'shop.example.test/app;jsessionid=AB12', email: 'alice', password: 'Secret1' }],
    ['two parameters, an e-mail login', 'shop.example.test/app;jsessionid=AB12;lang=en:alice@mail.test:Secret1', { url: 'shop.example.test/app;jsessionid=AB12;lang=en', email: 'alice@mail.test', password: 'Secret1' }],
    ['a port in the host', 'shop.example.test:8080/app;jsessionid=AB12:alice:Secret1', { url: 'shop.example.test:8080/app;jsessionid=AB12', email: 'alice', password: 'Secret1' }],
  ])('is part of the url (%s)', (_label, line, want) => {
    expect(fields(line)).toMatchObject(want)
  })
  test.each([
    ['url with a path;login;password', 'shop.example.test/login;alice;Secret1', { url: 'shop.example.test/login', email: 'alice', password: 'Secret1' }],
    ['login;password with an equals sign', 'alice;pass=word', { url: '', email: 'alice', password: 'pass=word' }],
    ['host;login;password with an equals sign in the password', 'shop.example.test;alice;pass=word', { url: 'shop.example.test', email: 'alice', password: 'pass=word' }],
    ['a path then ;login=...;password', 'shop.example.test/login;user=alice;Secret1', { url: 'shop.example.test/login', email: 'user=alice', password: 'Secret1' }],
  ])('a semicolon-separated line is unchanged (%s)', (_label, line, want) => {
    expect(fields(line)).toMatchObject(want)
  })
})

describe('holdsCredential: the text in front of a separator is already a credential', () => {
  test.each([
    ['https://shop.example.test:alice:Secret1', true],
    ['shop.example.test:alice:Secret1', true],
    ['alice@mail.test:Secret1', true],
    ['https://shop.example.test/login:alice:x', true],
    ['https://shop.example.test', false],
    ['https://shop.example.test:8443', false],
    ['shop.example.test:8080', false],
    ['alice', false],
    ['alice:Secret1', false],
  ])('%s is %s', (before, want) => expect(holdsCredential(before)).toBe(want))
})
