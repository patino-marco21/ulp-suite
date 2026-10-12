/**
 * The stream parsers read a file's bytes as Latin-1 (so that nothing can throw) and the insert later writes the string as UTF-8, so every UTF-8
 * multi-byte character used to turn into mojibake ("café" -> "cafÃ©") and a non-Latin login was rejected by the mojibake gate. Every line of the pile
 * that holds a byte of 0x80 or more is valid UTF-8, so a line is now read as UTF-8 when it is valid UTF-8 and stays Latin-1 text when it is not.
 * All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { repairUtf8Line } from '@/lib/ulp-utf8'
import { parseULPStream } from '@/lib/ulp-parser'

/** What the stream parsers see: the file's bytes read as Latin-1. */
const asRead = (bytes: number[] | string): string => (typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)).toString('latin1')

describe('repairUtf8Line', () => {
  test('a line of plain ASCII is returned as it is', () => {
    const line = 'https://shop.example.test/login:alice@mail.test:Secret1'
    expect(repairUtf8Line(line)).toBe(line)
  })

  test('UTF-8 text that was read as Latin-1 is read as UTF-8', () => {
    expect(repairUtf8Line(asRead('alice@mail.test:café123'))).toBe('alice@mail.test:café123')
    expect(repairUtf8Line(asRead('логин@mail.test:Пароль1'))).toBe('логин@mail.test:Пароль1')
    expect(repairUtf8Line(asRead('alice@mail.test:pass😀word'))).toBe('alice@mail.test:pass😀word')
  })

  test('bytes that are not valid UTF-8 stay Latin-1 text', () => {
    const line = asRead([0x61, 0x6c, 0x69, 0x63, 0x65, 0x3a, 0x63, 0x61, 0x66, 0xe9]) // "alice:caf" and a lone 0xE9
    expect(repairUtf8Line(line)).toBe(line)
  })

  test('a byte-order mark at the start is dropped', () => {
    expect(repairUtf8Line(asRead([0xef, 0xbb, 0xbf, 0x61, 0x3a, 0x62]))).toBe('a:b')
  })

  test('a non-breaking space at the end is one character that trim() removes (no stray "Â" is left)', () => {
    const repaired = repairUtf8Line(asRead('a@b.test:Secret1\u00a0'))
    expect(repaired).toBe('a@b.test:Secret1\u00a0')
    expect(repaired.trim()).toBe('a@b.test:Secret1')
  })

  test('a string that holds a character above U+00FF is not a Latin-1 line and is left alone', () => {
    expect(repairUtf8Line('alice:пароль')).toBe('alice:пароль')
  })

  test('a real U+FFFD in the source stays a U+FFFD, which the binary check still catches', () => {
    expect(repairUtf8Line(asRead([0x61, 0x3a, 0xef, 0xbf, 0xbd, 0x62]))).toBe('a:\ufffdb')
  })
})

async function parseBytes(bytes: Buffer) {
  const credentials: Array<{ url: string; email: string; password: string }> = []
  let rejected = 0
  const body = new Response(bytes).body as ReadableStream<Uint8Array>
  for await (const batch of parseULPStream(body, 'utf8.txt', 1000, undefined, { dedupInFile: false })) {
    credentials.push(...batch.credentials)
    rejected += batch.rejected
  }
  return { credentials, rejected }
}

describe('parseULPStream reads UTF-8 files as UTF-8', () => {
  test('a UTF-8 password is stored as typed, not as mojibake', async () => {
    const r = await parseBytes(Buffer.from('https://shop.example.test/login:alice@mail.test:café123\n', 'utf8'))
    expect(r.credentials.map(c => c.password)).toEqual(['café123'])
  })

  test('a non-Latin login is stored (it used to be rejected as mojibake)', async () => {
    const r = await parseBytes(Buffer.from('https://shop.example.test/login:Иван_Петров:Secret1\n', 'utf8'))
    expect(r.credentials.map(c => c.email)).toEqual(['Иван_Петров'])
    expect(r.rejected).toBe(0)
  })

  test('a Latin-1 file keeps its Latin-1 characters', async () => {
    const bytes = Buffer.from([...Buffer.from('https://shop.example.test/login:alice@mail.test:caf'), 0xe9, ...Buffer.from('123\n')])
    const r = await parseBytes(bytes)
    expect(r.credentials.map(c => c.password)).toEqual(['café123'])
  })

  test('a byte-order mark does not garble the first line', async () => {
    const r = await parseBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('https://shop.example.test/login:alice@mail.test:Secret1\n')]))
    expect(r.credentials.map(c => c.url)).toEqual(['https://shop.example.test/login'])
  })

  test('a real replacement character in the source is still rejected as garbage', async () => {
    const r = await parseBytes(Buffer.concat([Buffer.from('https://shop.example.test/login:alice@mail.test:pa'), Buffer.from([0xef, 0xbf, 0xbd]), Buffer.from('ss\n')]))
    expect(r.credentials).toHaveLength(0)
    expect(r.rejected).toBe(1)
  })
})
