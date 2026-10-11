/**
 * Telegram channels that repost combo lists append their own link, and sometimes an advert, to the credential lines. Before this the
 * parser either rejected such a line (the whole line, as "no_fields") or kept the tag inside the password. All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'
import { hasTelegramLink, stripTelegramTag } from '@/lib/ulp-telegram-tag'

const src = 'tags.txt'
const cred = (line: string) => parseLine(line, src).credential

async function streamParse(content: string) {
  const out: Array<{ url: string; email: string; password: string }> = []
  const body = new Response(content).body as ReadableStream<Uint8Array>
  for await (const batch of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) out.push(...batch.credentials)
  return out
}

describe('stripTelegramTag — what is cut', () => {
  test.each([
    ['a tag after a space', 'shop.example.test/:alice:Secret1 https://t.me/SomeChannel', 'shop.example.test/:alice:Secret1'],
    ['a tag after a tab', 'shop.example.test/:alice:Secret1\thttps://t.me/SomeChannel', 'shop.example.test/:alice:Secret1'],
    ['an invite link', 'https://shop.example.test/login:alice@mail.test:Secret1 https://t.me/+AbC123', 'https://shop.example.test/login:alice@mail.test:Secret1'],
    ['a tag glued on, no scheme', 'shop.example.test:alice@mail.test:Secret1t.me/SomeChannel', 'shop.example.test:alice@mail.test:Secret1'],
    ['a tag glued on, with scheme', 'shop.example.test:alice@mail.test:Secret1https://t.me/SomeChannel', 'shop.example.test:alice@mail.test:Secret1'],
    ['a glued tag followed by an advert', 'shop.example.test/:alice:Secret1t.me/SomeChannel  You can buy dm @SomeChannel', 'shop.example.test/:alice:Secret1'],
    ['a scheme broken up by spaces', 'shop.example.test/:alice:Secret1 : https : //t.me/SomeChannel', 'shop.example.test/:alice:Secret1'],
    ['a doubled scheme', 'shop.example.test/:alice:Secret1 https://https://t.me/+AbC123', 'shop.example.test/:alice:Secret1'],
    ['an advert after padding', 'shop.example.test/:alice:Secret1          @best_ulp - daily | https://t.me/+AbC123', 'shop.example.test/:alice:Secret1'],
    ['a two-field line', 'alice@mail.test:Secret1t.me/SomeChannel', 'alice@mail.test:Secret1'],
    ['upper case', 'shop.example.test/:alice:Secret1 HTTPS://T.ME/SomeChannel', 'shop.example.test/:alice:Secret1'],
    ['a password that is an e-mail address, tag glued on', 'alice@mail.test:bob@yahoo.comt.me/SomeChannel', 'alice@mail.test:bob@yahoo.com'],
    ['the same on a line with a url', 'https://shop.example.test/login:alice:bob@yahoo.comt.me/SomeChannel', 'https://shop.example.test/login:alice:bob@yahoo.com'],
    ['the same with a scheme glued on', 'alice@mail.test:bob@yahoo.comhttps://t.me/SomeChannel', 'alice@mail.test:bob@yahoo.com'],
    ['a line ending in CRLF', 'shop.example.test/:alice:Secret1 https://t.me/SomeChannel\r', 'shop.example.test/:alice:Secret1'],
    ['a scheme glued on and an advert with a second link', 'shop.example.test/login:alice@mail.test:Secret1://t.me/SomeChannel|NAME;@NAME|https://t.me/+AbC123', 'shop.example.test/login:alice@mail.test:Secret1'],
    ['the same on a line with a url', 'https://shop.example.test/login:alice:Secret1://t.me/SomeChannel|NAME;@NAME|https://t.me/+AbC123', 'https://shop.example.test/login:alice:Secret1'],
  ])('%s', (_label, input, expected) => {
    expect(stripTelegramTag(input)).toBe(expected)
  })
})

describe('stripTelegramTag — what is left alone', () => {
  test.each([
    ['the link is the url field of a real credential', 'https://t.me/SomeChannel:alice:Secret1'],
    ['a bare invite line', 'https://t.me/+AbC123'],
    ['a bare link without a scheme', 't.me/SomeChannel'],
    ['a URL with user info whose host name merely ends in t', 'https://alice:Secret1@payment.me/x'],
    ['a path that contains t.me/ with fields after it', 'shop.example.test/post.me/x:alice:Secret1'],
    ['the link is the url field and a password holds a url', 'https://t.me/SomeChannel:alice:https://other.example.test/x'],
    ['no tag', 'shop.example.test/:alice:Secret1'],
    ['an empty line', ''],
  ])('%s', (_label, input) => {
    expect(stripTelegramTag(input)).toBe(input)
  })
})

describe('hasTelegramLink', () => {
  test.each([
    ['https://t.me/SomeChannel', true],
    ['see t.me/SomeChannel', true],
    ['🔥 DAILY https://https://t.me/+AbC123 🔥', true],
    ['T.ME/x', true],
    ['mypost.me/page', false],
    ['Secret1', false],
    ['', false],
  ])('%j -> %s', (input, expected) => {
    expect(hasTelegramLink(input)).toBe(expected)
  })
})

describe('parseLine with a Telegram tag', () => {
  test('a tag after a space is not part of the password and does not reject the line', () => {
    expect(cred('shop.example.test/:alice:Secret1 https://t.me/SomeChannel')).toMatchObject({
      url: 'shop.example.test/', email: 'alice', password: 'Secret1', domain: 'shop.example.test',
    })
  })

  test('a tag glued onto the password', () => {
    expect(cred('https://shop.example.test/login:alice@mail.test:Secret1t.me/SomeChannel')).toMatchObject({
      url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1',
    })
  })

  test('an advert after padding, then a link', () => {
    expect(cred('shop.example.test/login:alice@mail.test:Secret1          @best_ulp - daily | https://t.me/+AbC123')).toMatchObject({
      email: 'alice@mail.test', password: 'Secret1',
    })
  })

  test('a password that is an e-mail address keeps the address and loses the glued tag', () => {
    expect(cred('alice@mail.test:bob@yahoo.comt.me/SomeChannel')).toMatchObject({ email: 'alice@mail.test', password: 'bob@yahoo.com' })
  })

  test('a two-field login:password line', () => {
    expect(cred('alice@mail.test:Secret1 https://t.me/SomeChannel')).toMatchObject({ url: '', email: 'alice@mail.test', password: 'Secret1' })
  })

  test('a real t.me url with credentials after it is kept as it was', () => {
    expect(cred('https://t.me/SomeChannel:alice:Secret1')).toMatchObject({ url: 'https://t.me/SomeChannel', email: 'alice', password: 'Secret1' })
  })

  test('a login or password that still holds a Telegram link is not a credential', () => {
    expect(cred('android://hash@com.example.app:🔥 DAILY https://https://t.me/+AbC123 🔥:Secret1')).toBeNull()
    expect(cred('shop.example.test/:https://t.me/+AbC123:https://t.me/+AbC123')).toBeNull()
  })

  test('a bare invite line is not a credential', () => {
    expect(cred('https://t.me/+AbC123')).toBeNull()
  })

  test('lines without a tag parse exactly as before', () => {
    expect(cred('https://shop.example.test/login:alice@mail.test:Secret1')).toMatchObject({ email: 'alice@mail.test', password: 'Secret1' })
    expect(cred('alice@mail.test:Secret1')).toMatchObject({ email: 'alice@mail.test', password: 'Secret1' })
  })
})

describe('a banner line that starts with http does not swallow the lines after it', () => {
  const content = ['https://t.me/+AbC123', 'shop.example.test/:alice:Secret1', 'shop.example.test/:bob:Secret2'].join('\n') + '\n'

  test('parseULPContent', () => {
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['alice', 'bob'])
  })

  test('parseULPStream', async () => {
    expect((await streamParse(content)).map(c => c.email)).toEqual(['alice', 'bob'])
  })

  test('a genuine bare url followed by login and password still works (positional format)', async () => {
    const positional = ['https://shop.example.test/login', 'alice@mail.test', 'Secret1'].join('\n') + '\n'
    expect(parseULPContent(positional, src).credentials).toHaveLength(1)
    expect(await streamParse(positional)).toHaveLength(1)
  })
})
