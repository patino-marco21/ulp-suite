/**
 * A line that starts with "http" and that the field split rejects ("no_fields") opens a positional record: URL line, login line, password line.
 * That is right for a bare URL in a stealer log and wrong for a credential line the split could not take (a "/" in the password, a missing
 * login): the two well-formed lines after it were taken for its login and password, which merged three real lines into one junk row and lost two.
 * The record only opens when the line after the URL can be a lone login. All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseLine, parseULPContent, parseULPStream } from '@/lib/ulp-parser'

const src = 'positional.txt'

async function streamParse(content: string) {
  const out: Array<{ url: string; email: string; password: string }> = []
  let rejected = 0
  let noFields = 0
  const body = new Response(content).body as ReadableStream<Uint8Array>
  for await (const batch of parseULPStream(body, src, 1000, undefined, { dedupInFile: false })) {
    out.push(...batch.credentials)
    rejected += batch.rejected
    noFields += batch.breakdown.no_fields
  }
  return { credentials: out, rejected, noFields }
}

const lines = (...l: string[]) => l.join('\n') + '\n'

// each of these is rejected by parseLine as no_fields and starts with "http"
const REJECTED_URL_LINES: Array<[string, string]> = [
  ['a "/" in the password', 'https://shop.example.test:alice:Pass/word1'],
  ['an e-mail login, no url, and a "/" in the password', 'https://alice@mail.test:Pass/word1'],
  ['an e-mail login and a "/" in the password', 'https://shop.example.test:alice@mail.test:Pass/word1'],
]

describe.each(REJECTED_URL_LINES)('a rejected credential line (%s) does not swallow the lines after it', (_label, rejectedLine) => {
  const content = lines(rejectedLine, 'https://one.example.test:carol:Secret1', 'https://two.example.test:dave:Secret2')

  test('parseLine rejects it as no_fields (the precondition)', () => {
    expect(parseLine(rejectedLine, src)).toEqual({ credential: null, reason: 'no_fields' })
  })

  test('parseULPContent keeps both of the next lines and counts the rejected one', () => {
    const r = parseULPContent(content, src)
    expect(r.credentials.map(c => c.email)).toEqual(['carol', 'dave'])
    expect(r.rejection_breakdown.no_fields).toBe(1)
    expect(r.skipped).toBe(1 + r.rejection_breakdown.blank) // the rejected line, and the empty string after the last newline
  })

  test('parseULPStream keeps both of the next lines and counts the rejected one', async () => {
    const r = await streamParse(content)
    expect(r.credentials.map(c => c.email)).toEqual(['carol', 'dave'])
    expect(r.rejected).toBe(1)
    expect(r.noFields).toBe(1)
  })
})

describe('what can follow a rejected URL line', () => {
  const rejected = 'https://shop.example.test:alice:Pass/word1'

  test.each([
    ['a two-field line', 'carol:Secret1'],
    ['a pipe-separated line', 'carol|Secret1'],
    ['a line without a url', 'shop.example.test:carol:Secret1'],
  ])('%s is read as its own credential', async (_label, next) => {
    const content = lines(rejected, next, 'https://two.example.test:dave:Secret2')
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['carol', 'dave'])
    expect((await streamParse(content)).credentials.map(c => c.email)).toEqual(['carol', 'dave'])
  })

  test('an app id with a scheme is not a login: the credential after it is kept', async () => {
    // "android://hash@com.example.app/..." is rejected as no_fields and has no colon-separated fields of its own, but it is not a login either
    const content = lines(rejected, 'android://AbC-dEf==@com.example.app/', 'https://one.example.test:carol:Secret1', 'https://two.example.test:dave:Secret2')
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['carol', 'dave'])
    expect((await streamParse(content)).credentials.map(c => c.email)).toEqual(['carol', 'dave'])
  })

  test('another rejected URL line starts a record of its own: nothing is merged', async () => {
    // both "URL" lines are rejected; the e-mail and password after the second one are its login and password
    const second = 'https://alice@mail.test:Pass/word2'
    const content = lines(rejected, second, 'bob@mail.test', 'Secret9')
    for (const credentials of [parseULPContent(content, src).credentials, (await streamParse(content)).credentials]) {
      expect(credentials).toHaveLength(1)
      expect(credentials[0]).toMatchObject({ url: second, email: 'bob@mail.test', password: 'Secret9' })
    }
  })

  test('a rejected URL line at the end of the file is still counted once', async () => {
    const content = lines('https://one.example.test:carol:Secret1', rejected)
    expect(parseULPContent(content, src).credentials).toHaveLength(1)
    expect((await streamParse(content)).credentials).toHaveLength(1)
  })
})

describe('genuine positional records still work', () => {
  const block = lines('https://shop.example.test/login', 'alice@mail.test', 'Secret1')

  test('a bare URL, a lone login and a password', async () => {
    expect(parseULPContent(block, src).credentials).toMatchObject([{ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1' }])
    expect((await streamParse(block)).credentials).toMatchObject([{ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Secret1' }])
  })

  test('a bare URL with a colon in the query string', async () => {
    const content = lines('https://shop.example.test/login?next=a:b', 'alice', 'Secret1')
    expect(parseULPContent(content, src).credentials).toMatchObject([{ email: 'alice', password: 'Secret1' }])
    expect((await streamParse(content)).credentials).toMatchObject([{ email: 'alice', password: 'Secret1' }])
  })

  test('records separated by blank lines, with metadata lines around them', async () => {
    const content = lines('United States', '192.168.1.100', 'https://a.example.test/login', 'alice', 'Secret1', '', 'https://b.example.test/login', 'bob', 'Secret2', '')
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['alice', 'bob'])
    expect((await streamParse(content)).credentials.map(c => c.email)).toEqual(['alice', 'bob'])
  })

  test('a block record followed by ordinary credential lines', async () => {
    const content = lines('https://shop.example.test/login', 'alice@mail.test', 'Secret1', 'https://one.example.test:carol:Secret1')
    expect(parseULPContent(content, src).credentials.map(c => c.email)).toEqual(['alice@mail.test', 'carol'])
    expect((await streamParse(content)).credentials.map(c => c.email)).toEqual(['alice@mail.test', 'carol'])
  })
})
