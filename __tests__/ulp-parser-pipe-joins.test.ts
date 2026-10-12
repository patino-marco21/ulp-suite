/**
 * Parser v6.1: a pipe that sits between a url (or only its scheme, or a label) and a colon-separated credential is the join of the two, not the
 * login/password separator. Before, "https://| host:alice:Secret1" stored the login "https://" with the password "host:alice:Secret1".
 * Every fixture is synthetic. The "unchanged" tests pin the pipe layouts that already parse (url|login|pass, login|pass, credential|note).
 */
import { describe, expect, test } from 'vitest'
import { parseInlineLine, parseLine, parseULPStream } from '@/lib/ulp-parser'
import { joinPipedUrl, pipeJoinAll } from '@/lib/ulp-recover'

const src = 'pipes.txt'
const cred = (line: string) => parseLine(line, src).credential
const fields = (line: string) => { const c = cred(line); return c && { url: c.url, email: c.email, password: c.password, domain: c.domain } }

describe('rule F: only the scheme in front of the pipe', () => {
  test('scheme | host : e-mail : password', () => {
    expect(fields('https://| shop.example.test:alice@mail.test:Secret1')).toEqual({ url: 'https://shop.example.test', email: 'alice@mail.test', password: 'Secret1', domain: 'shop.example.test' })
  })
  test('scheme | host/path : login : password, with and without the space', () => {
    expect(fields('https://| shop.example.test/login:alice:Secret1')).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' })
    expect(fields('http://|shop.example.test/login:alice:Secret1')).toMatchObject({ url: 'http://shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
  test('scheme | host/ : : login : password keeps its slash', () => {
    expect(fields('https://| shop.example.test/:alice:Secret1')).toMatchObject({ url: 'https://shop.example.test/', email: 'alice', password: 'Secret1' })
  })
  test('scheme | e-mail : password has no url', () => {
    expect(fields('https://| alice@mail.test:Secret1')).toEqual({ url: '', email: 'alice@mail.test', password: 'Secret1', domain: 'mail.test' })
  })
  test('a note after a second pipe is cut', () => {
    expect(fields('https://| shop.example.test:alice:Secret1 | Country: US')).toMatchObject({ url: 'https://shop.example.test', email: 'alice', password: 'Secret1' })
  })
  test('nothing behind the scheme is still nothing', () => {
    expect(cred('https://|')).toBeNull()
    expect(cred('https://| ')).toBeNull()
  })
})

describe('rule G: a one-word label and a colon in front of the pipe', () => {
  test('label | host : login : password', () => {
    expect(fields('Network:| shop.example.test:alice:Secret1')).toMatchObject({ url: 'shop.example.test', email: 'alice', password: 'Secret1' })
  })
  test('label | host : e-mail : password', () => {
    expect(fields('Network:| shop.example.test:alice@mail.test:Secret1')).toMatchObject({ url: 'shop.example.test', email: 'alice@mail.test', password: 'Secret1' })
  })
  test('label | e-mail : password has no url', () => {
    expect(fields('Network:| alice@mail.test:Secret1')).toEqual({ url: '', email: 'alice@mail.test', password: 'Secret1', domain: 'mail.test' })
  })
  test('label | scheme-less host/path : login : password', () => {
    expect(fields('Network:| shop.example.test/login:alice:Secret1')).toMatchObject({ url: 'shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
})

describe('rule H: a url, then the pipe, then login : password', () => {
  test('url : | login : password', () => {
    expect(fields('https://shop.example.test/login:| alice:Secret1')).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
  test('url |: login : password', () => {
    expect(fields('https://shop.example.test/login |:alice@mail.test:Secret1')).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1' })
  })
  test('url | e-mail : password', () => {
    expect(fields('https://shop.example.test/login|alice@mail.test:Secret1')).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1' })
  })
  test('a url with a port', () => {
    expect(fields('https://shop.example.test:8443/login|alice:Secret1')).toMatchObject({ url: 'https://shop.example.test:8443/login', email: 'alice', password: 'Secret1' })
  })
  test('a password with a colon keeps it', () => {
    expect(fields('https://shop.example.test/login|alice:Sec:ret1')).toMatchObject({ email: 'alice', password: 'Sec:ret1' })
  })
  test('host : | login : password (a scheme-less host followed by a colon and the pipe)', () => {
    expect(fields('shop.example.test:| alice:Secret1')).toMatchObject({ url: 'shop.example.test', email: 'alice', password: 'Secret1' })
  })
})

describe('the pipe layouts that already parse do not move', () => {
  test.each([
    ['url|login|pass, three fields', 'https://shop.example.test|alice@mail.test|Secret1', { url: 'https://shop.example.test', email: 'alice@mail.test', password: 'Secret1' }],
    ['bare host|login|pass', 'shop.example.test|alice|Secret1', { url: 'shop.example.test', email: 'alice', password: 'Secret1' }],
    ['e-mail|password', 'alice@mail.test|Secret1', { url: '', email: 'alice@mail.test', password: 'Secret1' }],
    ['e-mail|password with a colon in the password', 'alice@mail.test|Sec:ret1', { url: '', email: 'alice@mail.test', password: 'Sec:ret1' }],
    ['url|login|pass with a colon in the password', 'https://shop.example.test|alice|Sec:ret1', { url: 'https://shop.example.test', email: 'alice', password: 'Sec:ret1' }],
    ['a credential then a note', 'https://shop.example.test/login:alice:Secret1|RU|source.txt', { url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' }],
    ['a credential then a note with a colon', 'https://shop.example.test/login:alice:Secret1|Country: US', { url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' }],
    ['host:login:pass then a note', 'shop.example.test:alice:Secret1|RU', { url: 'shop.example.test', email: 'alice', password: 'Secret1' }],
    ['url with a port | login | pass', 'ftp://files.example.test:21|ftpuser|Secret1', { url: 'ftp://files.example.test:21', email: 'ftpuser', password: 'Secret1' }],
  ])('%s', (_label, line, want) => {
    expect(fields(line)).toMatchObject(want)
  })
})

describe('the join is applied before the Android rule and before a second pipe', () => {
  const id = 'AbCdEfGhIjKlMnOpQrSt'
  test('a label in front of an Android app id without its scheme', () => {
    const r = parseInlineLine(`Network:| ${id}==@com.example.app/:alice@mail.test:Secret1`, src)
    expect(r.androidRecovered).toBe(true)
    expect(r.credential).toMatchObject({ url: `android://${id}==@com.example.app/`, email: 'alice@mail.test', password: 'Secret1' })
  })
  test('the scheme and then a url, a colon and a second pipe', () => {
    expect(fields('https://| shop.example.test/login:|:alice:Secret1')).toMatchObject({ url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' })
  })
  test('joinPipedUrl is tried only where the pipe would have been the login/password separator', () => {
    expect(joinPipedUrl('https://shop.example.test/login:alice:Secret1|Country:US')).toBeNull()      // a credential in front of the pipe: the rest is a note
    expect(joinPipedUrl('alice@mail.test:Secret1|Country:US')).toBeNull()                            // an e-mail login and its password in front of the pipe
    expect(joinPipedUrl('https://|shop.example.test;alice;Secret1')).toBeNull()                      // a semicolon is the primary separator
    expect(joinPipedUrl('|https://shop.example.test:alice:Secret1')).toBeNull()
    expect(joinPipedUrl('https://| shop.example.test:alice:Secret1')).toEqual({ kind: 'scheme', line: 'https://shop.example.test:alice:Secret1' })
  })
  test('pipeJoinAll applies the joins one after the other and names the first layout', () => {
    expect(pipeJoinAll('https://| shop.example.test/login:|:alice:Secret1')).toEqual({ kind: 'scheme', line: 'https://shop.example.test/login:alice:Secret1' })
    expect(pipeJoinAll('https://shop.example.test:alice:Secret1')).toBeNull()
  })
})

describe('the stream parser applies them too', () => {
  test('three joined layouts and one plain line come out as four credentials', async () => {
    const text = [
      'https://| shop.example.test:alice@mail.test:Secret1',
      'Network:| shop.example.test:bob:Secret2',
      'https://shop.example.test/login|carol@mail.test:Secret3',
      'https://shop.example.test:dave:Secret4',
    ].join('\n') + '\n'
    const stream = new Response(text).body as ReadableStream<Uint8Array>
    const rows: Array<[string, string, string]> = []
    for await (const b of parseULPStream(stream, src, 1000)) for (const c of b.credentials) rows.push([c.url, c.email, c.password])
    expect(rows).toEqual([
      ['https://shop.example.test', 'alice@mail.test', 'Secret1'],
      ['shop.example.test', 'bob', 'Secret2'],
      ['https://shop.example.test/login', 'carol@mail.test', 'Secret3'],
      ['https://shop.example.test', 'dave', 'Secret4'],
    ])
  })
})
