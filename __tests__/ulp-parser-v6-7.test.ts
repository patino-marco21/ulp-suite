/**
 * Parser v6.7 (docs/superpowers/specs/2026-11-08-parser-v6-7-design.md): a pipe where the colon behind the scheme belongs (rule S), and four kinds of field that are no credential
 * (lib/ulp-field-junk.ts). Every fixture is synthetic.
 */
import { describe, expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { parseInlineLine, parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'
import { joinSchemeWordPipe } from '@/lib/ulp-recover'
import { hasFieldJunk, isDecryptErrorText, isEmojiAd, isJsonFragment, lacksLetterOrDigit } from '@/lib/ulp-field-junk'
import { classifyChange, classifyOldOnlyRow } from '@/lib/parser-diff'

const src = 'v67.txt'

describe('S: a pipe where the colon behind the scheme belongs', () => {
  test('joinSchemeWordPipe puts the scheme back, and touches nothing else', () => {
    expect(joinSchemeWordPipe('https|//shop.example.test/|alice|Secret1')).toBe('https://shop.example.test/|alice|Secret1')
    expect(joinSchemeWordPipe('http:|//shop.example.test/|alice|Secret1')).toBe('http://shop.example.test/|alice|Secret1')
    expect(joinSchemeWordPipe('HTTPS|//shop.example.test/:alice:Secret1')).toBe('HTTPS://shop.example.test/:alice:Secret1')
    expect(joinSchemeWordPipe('https://shop.example.test/|alice|Secret1')).toBeNull()
    expect(joinSchemeWordPipe('https://|shop.example.test/|alice|Secret1')).toBeNull()
    expect(joinSchemeWordPipe('https|shop.example.test|alice|Secret1')).toBeNull()
    expect(joinSchemeWordPipe('ftp|//shop.example.test/|alice|Secret1')).toBeNull()
    expect(joinSchemeWordPipe('httpsx|//shop.example.test/|alice|Secret1')).toBeNull()
    expect(joinSchemeWordPipe('alice|//Secret1')).toBeNull()
    expect(joinSchemeWordPipe('')).toBeNull()
  })

  test.each([
    ['an e-mail login', 'https|//shop.example.test/|alice@mail.test|Secret1', 'https://shop.example.test/', 'alice@mail.test', 'Secret1'],
    ['a username login and a path', 'https|//shop.example.test/login|alice|Secret1', 'https://shop.example.test/login', 'alice', 'Secret1'],
    ['http with a colon', 'http:|//shop.example.test/|alice|Secret1', 'http://shop.example.test/', 'alice', 'Secret1'],
    ['a pipe in the password', 'https|//shop.example.test/|alice|pass|word', 'https://shop.example.test/', 'alice', 'pass|word'],
    ['colons behind the url', 'https|//shop.example.test/:alice:Secret1', 'https://shop.example.test/', 'alice', 'Secret1'],
    ['an app host with a port', 'https|//shop.example.test:8443/x|alice|Secret1', 'https://shop.example.test:8443/x', 'alice', 'Secret1'],
  ])('%s is read as url|login|password', (_label, line, url, login, password) => {
    const r = parseInlineLine(line, src)
    expect(r.credential).toMatchObject({ url, email: login, password })
    expect(r.androidRecovered).toBe(false)
  })

  test('the result is what the line gives with its scheme written the ordinary way', () => {
    for (const rest of ['shop.example.test/|alice@mail.test|Secret1', 'shop.example.test/x|alice|Secret1']) {
      expect(parseLine(`https|//${rest}`, src)).toEqual(parseLine(`https://${rest}`, src))
    }
  })

  test('a line the rule does not cover is read as before', () => {
    expect(parseLine('https|shop.example.test|alice|Secret1', src).credential).toMatchObject({ url: 'https', email: 'shop.example.test' })
    expect(parseLine('https://shop.example.test/|alice|Secret1', src).credential).toMatchObject({ url: 'https://shop.example.test/', email: 'alice', password: 'Secret1' })
  })

  test('in a stream, and in a file read as text, the rows come out whole', async () => {
    const text = 'https|//shop.example.test/|alice@mail.test|Secret1\nhttps|//other.example.test/|bob|Other22\n'
    const body = Readable.toWeb(Readable.from(Buffer.from(text))) as unknown as ReadableStream<Uint8Array>
    const rows: Array<{ url: string; email: string; password: string }> = []
    for await (const b of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) rows.push(...b.credentials)
    expect(rows.map(r => [r.url, r.email, r.password])).toEqual([
      ['https://shop.example.test/', 'alice@mail.test', 'Secret1'], ['https://other.example.test/', 'bob', 'Other22'],
    ])
    expect(parseULPContent(text, src).credentials.map(r => r.url)).toEqual(['https://shop.example.test/', 'https://other.example.test/'])
  })

  test('a long hostile line is read in linear time', () => {
    const t0 = performance.now()
    for (const line of [`https|//${'a|'.repeat(5000)}`, `https:|//${'/'.repeat(5000)}|x`, `https|${'/'.repeat(5000)}`, `https|//${'a'.repeat(20000)}`]) {
      for (let i = 0; i < 100; i++) parseInlineLine(line, src)
    }
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('the four kinds of field that are no credential', () => {
  test.each(['Decryption failed.', 'decryption failed', 'Old or unknown version', 'Unable to decrypt', "Can't decode", 'Can’t decode', '[UNKNOWN or V70]', '  Decryption   failed. '])(
    '%j as the password is rejected', password => {
      expect(parseLine(`https://shop.example.test/:alice:${password}`, src)).toEqual({ credential: null, reason: 'garbage' })
    })

  test('a password that only contains such words, or a longer text, is kept', () => {
    expect(parseLine('https://shop.example.test/:alice:Decryption failed.1', src).credential?.password).toBe('Decryption failed.1')
    expect(parseLine('https://shop.example.test/:alice:please decode me', src).credential?.password).toBe('please decode me')
    expect(isDecryptErrorText('x'.repeat(5000))).toBe(false)
  })

  test.each([['""'], ["''"], ['????'], ['---'], ['(  )']])('the login %s has no letter or digit and is rejected', login => {
    expect(parseLine(`https://shop.example.test/:${login}:Secret1`, src)).toEqual({ credential: null, reason: 'garbage' })
  })

  test('a login with a letter or digit in any script is kept', () => {
    for (const login of ['alice', '+4915112345', '用户', 'ülkü', '_a_', '7']) {
      expect(parseLine(`https://shop.example.test/:${login}:Secret1`, src).credential?.email).toBe(login)
    }
    expect(lacksLetterOrDigit('')).toBe(true)
  })

  test.each([
    ['https://shop.example.test/:{"user":"x","k":"v"}'],
    ['https://app.example.test:{"user":"x","k":"v"}'],
    ['https://shop.example.test/:alice:["a","b"]'],
    ['https://shop.example.test/:{ "user":"x":Secret1'],
  ])('a JSON fragment in a field is rejected: %s', line => {
    expect(parseLine(line, src)).toEqual({ credential: null, reason: 'garbage' })
  })

  test('a password that starts with a brace or a quote, but is not JSON, is kept', () => {
    expect(parseLine('https://shop.example.test/:alice:{Admin123}', src).credential?.password).toBe('{Admin123}')
    expect(parseLine('https://shop.example.test/:alice:[Admin123]', src).credential?.password).toBe('[Admin123]')
    expect(isJsonFragment('"quoted"')).toBe(false)
    expect(isJsonFragment('"a","b"')).toBe(true)
  })

  test('an emoji advert as the password is rejected, a passphrase and a single emoji are kept', () => {
    expect(parseLine('https://shop.example.test/:alice:🌟🌟[ Join Our Channel ]', src)).toEqual({ credential: null, reason: 'garbage' })
    expect(parseLine('https://shop.example.test/:alice:🎯🎯 daily logs', src)).toEqual({ credential: null, reason: 'garbage' })
    expect(parseLine('https://shop.example.test/:alice:correct horse battery', src).credential?.password).toBe('correct horse battery')
    expect(parseLine('https://shop.example.test/:alice:🌟Secret1', src).credential?.password).toBe('🌟Secret1')
    expect(parseLine('https://shop.example.test/:alice:🌟🌟Secret1', src).credential?.password).toBe('🌟🌟Secret1')
    expect(isEmojiAd('🌟 two words')).toBe(false)
  })

  test('hasFieldJunk is the union', () => {
    expect(hasFieldJunk('alice', 'Secret1')).toBe(false)
    expect(hasFieldJunk('alice', 'Decryption failed.')).toBe(true)
    expect(hasFieldJunk('""', 'Secret1')).toBe(true)
    expect(hasFieldJunk('{"a"', 'x')).toBe(true)
    expect(hasFieldJunk('alice', '🌟🌟 ad')).toBe(true)
  })

  test('the block-format path rejects them too', () => {
    const block = ['URL: https://shop.example.test/', 'Username: alice', 'Password: Decryption failed.', '', 'URL: https://shop.example.test/', 'Username: bob', 'Password: Secret1', ''].join('\n')
    expect(parseULPContent(block, src).credentials.map(c => c.email)).toEqual(['bob'])
  })

  test('hostile fields are tested in linear time', () => {
    const t0 = performance.now()
    for (const s of ['{'.repeat(20000), '"'.repeat(20000), `"${'a'.repeat(20000)}`, '🌟'.repeat(10000), ' '.repeat(20000) + 'x', `${'a '.repeat(10000)}`]) {
      for (let i = 0; i < 200; i++) { hasFieldJunk(s, s); isDecryptErrorText(s) }
    }
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('the differential classes of v6.7', () => {
  const cred = (url: string, email = 'alice', password = 'Secret1') => ({ credential: { url, email, password }, reason: null })
  const rejected = { credential: null, reason: 'garbage' }

  test('a scheme-pipe line the old parser split wrongly is explained by rule S', () => {
    const line = 'https|//shop.example.test/|alice|Secret1'
    expect(classifyChange(line, cred('https', '//shop.example.test/', 'alice|Secret1'), cred('https://shop.example.test/'), cred('https', '//shop.example.test/', 'alice|Secret1'))).toBe('scheme-pipe')
    expect(classifyChange('https://shop.example.test/|alice|Secret1', cred('https', '//x', 'y'), cred('https://shop.example.test/'), cred('https', '//x', 'y'))).not.toBe('scheme-pipe')
  })

  test('a row the old parser stored and the new one rejects as junk is explained', () => {
    expect(classifyChange('https://shop.example.test/:alice:Decryption failed.', cred('https://shop.example.test/', 'alice', 'Decryption failed.'), rejected, cred('https://shop.example.test/', 'alice', 'Decryption failed.'))).toBe('field-junk')
    expect(classifyChange('https://shop.example.test/:alice:Secret1', cred('https://shop.example.test/'), rejected, cred('https://shop.example.test/'))).toBe('unexplained')
  })

  test('the old-only rows of both rules are named', () => {
    expect(classifyOldOnlyRow({ url: 'https', email: '//shop.example.test/', password: 'alice|Secret1' })).toBe('scheme-pipe')
    expect(classifyOldOnlyRow({ url: 'https://shop.example.test/', email: 'alice', password: 'Decryption failed.' })).toBe('field-junk')
    expect(classifyOldOnlyRow({ url: 'https://shop.example.test/', email: 'alice', password: 'Secret1' })).not.toMatch(/scheme-pipe|field-junk/)
  })
})
