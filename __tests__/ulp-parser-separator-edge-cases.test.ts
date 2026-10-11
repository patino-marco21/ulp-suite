/**
 * Two lines shapes that the separator rules (tab beats ';' beats '|' beats ':') took for something else:
 *  - "https://shop.example.test/login;jsessionid=AB12:alice:Secret1": a ";name=value" path parameter in the url was read as the field separator, so the url
 *    became the login and the rest the password (about 915k lines of one pile, 0.03% of the stored rows of the first 10M);
 *  - "alice@mail.test:Secret1 | Country: US": the pipe was read as the field separator, so "alice@mail.test:Secret1" became the login.
 * All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine } from '@/lib/ulp-parser'

const parse = (line: string) => parseLine(line, 'separators.txt')

describe('a ";name=value" path parameter in the url', () => {
  test.each([
    ['one parameter', 'https://shop.example.test/login;jsessionid=AB12:alice:Secret1', 'https://shop.example.test/login;jsessionid=AB12', 'alice', 'Secret1'],
    ['two parameters', 'https://shop.example.test/login;jsessionid=AB12;lang=en:alice@mail.test:Secret1', 'https://shop.example.test/login;jsessionid=AB12;lang=en', 'alice@mail.test', 'Secret1'],
    ['a password that holds a ";name=value"', 'https://shop.example.test/login:alice:Se;cret=1', 'https://shop.example.test/login', 'alice', 'Se;cret=1'],
    ['http', 'http://shop.example.test/login;jsessionid=AB12:alice:Secret1', 'http://shop.example.test/login;jsessionid=AB12', 'alice', 'Secret1'],
  ])('is part of the url (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })

  test.each([
    ['url;login;password', 'https://shop.example.test;alice;Secret1', 'https://shop.example.test', 'alice', 'Secret1'],
    ['url with a path;login;password', 'https://shop.example.test/login;alice;Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['login;password', 'alice;Secret1', '', 'alice', 'Secret1'],
    ['a password with an equals sign', 'alice;pass=word', '', 'alice', 'pass=word'],
  ])('a semicolon-separated line is unchanged (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })
})

describe('an e-mail login and its password in front of a pipe', () => {
  test.each([
    ['a note after a pipe with a space', 'alice@mail.test:Secret1 | Country: US'],
    ['a note after a pipe', 'alice@mail.test:Secret1|Country: US'],
    ['a short note', 'alice@mail.test:Secret1|x'],
  ])('is a credential followed by a note (%s)', (_label, line) => {
    expect(parse(line).credential).toMatchObject({ url: '', email: 'alice@mail.test', password: 'Secret1' })
  })

  test.each([
    ['login|password', 'alice@mail.test|Secret1', '', 'alice@mail.test', 'Secret1'],
    ['url|login|password', 'https://shop.example.test|alice@mail.test|Secret1', 'https://shop.example.test', 'alice@mail.test', 'Secret1'],
    ['host:port|login|password', 'shop.example.test:8080|alice|Secret1', 'shop.example.test:8080', 'alice', 'Secret1'],
    ['a credential with two colons in front of the pipe', 'shop.example.test:alice:Secret1|meta', 'shop.example.test', 'alice', 'Secret1'],
  ])('a pipe-separated line is unchanged (%s)', (_label, line, url, email, password) => {
    expect(parse(line).credential).toMatchObject({ url, email, password })
  })
})
