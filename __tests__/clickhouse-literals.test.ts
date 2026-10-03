import { describe, test, expect } from 'vitest'
import {
  chStringLiteral, chStringArrayLiteral, chBytesLiteral, chReversedLiteral, chReversedArrayLiteral,
} from '@/lib/clickhouse-literals'

/** The inverse of the escaping, from ClickHouse's own rules for a quoted string: \\ \' \xHH, every other character literal. */
function unescapeToBytes(literal: string): Buffer {
  expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true)
  const body = literal.slice(1, -1)
  const out: Buffer[] = []
  for (let i = 0; i < body.length; ) {
    const ch = body[i]
    if (ch === '\\') {
      const next = body[i + 1]
      if (next === '\\' || next === "'") { out.push(Buffer.from(next)); i += 2; continue }
      if (next === 'x') { out.push(Buffer.from([parseInt(body.slice(i + 2, i + 4), 16)])); i += 4; continue }
      throw new Error(`unexpected escape \\${next}`)
    }
    expect(ch).not.toBe("'")
    const cp = body.codePointAt(i) as number
    const text = String.fromCodePoint(cp)
    out.push(Buffer.from(text, 'utf8'))
    i += text.length
  }
  return Buffer.concat(out)
}

const nasty = [
  'plain.com', "a'b.com", 'a\\b.com', "a\\'b.com", "'; DROP TABLE ulp.credentials; --", '\\\\\'', "x'] ) OR 1=1 --",
  'line\nbreak.com', 'tab\tchar.com', 'nul\u0000byte.com', 'bell\u0007.com', 'del\u007f.com', 'emoji-😀.com', 'rtl-‮evil.com',
  'percent%_underscore_.com', '', ' ', 'a'.repeat(4000), 'ünïcödé.例え.jp', 'back`tick"dq.com', '--comment', '/* c */', '\\x41', '\\0', '\\n',
]

describe('chStringLiteral', () => {
  test('wraps a plain value in single quotes', () => {
    expect(chStringLiteral('plain.com')).toBe("'plain.com'")
    expect(chStringLiteral('')).toBe("''")
  })

  test('escapes the two characters that can end or alter a literal: the quote and the backslash', () => {
    expect(chStringLiteral("a'b")).toBe("'a\\'b'")
    expect(chStringLiteral('a\\b')).toBe("'a\\\\b'")
    expect(chStringLiteral("a\\'b")).toBe("'a\\\\\\'b'")
  })

  test('an injection attempt stays inside the literal', () => {
    expect(chStringLiteral("'; DROP TABLE x; --")).toBe("'\\'; DROP TABLE x; --'")
  })

  test('writes control characters as \\xHH so no raw NUL or line break travels in the SQL text', () => {
    expect(chStringLiteral('a\u0000b')).toBe("'a\\x00b'")
    expect(chStringLiteral('a\nb')).toBe("'a\\x0ab'")
    expect(chStringLiteral('a\tb')).toBe("'a\\x09b'")
    expect(chStringLiteral('a\u007fb')).toBe("'a\\x7fb'")
  })

  test('leaves printable and non-ASCII text alone', () => {
    expect(chStringLiteral('emoji-😀.com')).toBe("'emoji-😀.com'")
    expect(chStringLiteral('ünïcödé.例え.jp')).toBe("'ünïcödé.例え.jp'")
  })

  test.each(nasty)('round-trips byte for byte: %j', value => {
    expect(unescapeToBytes(chStringLiteral(value)).equals(Buffer.from(value, 'utf8'))).toBe(true)
  })

  test('round-trips 300 pseudo-random strings built from the troublesome alphabet', () => {
    const alphabet = ["'", '\\', '"', '`', '\n', '\r', '\t', '\u0000', '\u001f', '\u007f', ' ', 'a', 'Z', '0', '.', '-', '_', '%', '😀', 'é', '例', '‮']
    let seed = 12345
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    for (let n = 0; n < 300; n++) {
      const len = next() % 40
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[next() % alphabet.length]
      expect(unescapeToBytes(chStringLiteral(s)).equals(Buffer.from(s, 'utf8')), JSON.stringify(s)).toBe(true)
    }
  })
})

describe('chBytesLiteral / chReversedLiteral', () => {
  test('writes every byte of 0x7f and above, every control byte, the quote and the backslash as an escape', () => {
    expect(chBytesLiteral(Uint8Array.from([0x6d, 0xa9, 0xc3, 0x27, 0x5c, 0x00]))).toBe("'m\\xa9\\xc3\\'\\\\\\x00'")
  })

  test('is the literal of reverse(value) as ClickHouse computes it: the UTF-8 bytes in reverse order', () => {
    expect(chReversedLiteral('ledger.com')).toBe("'moc.regdel'")
    // verified on the live server: reverse('é.com') = 'moc.\xA9\xC3', and it is NOT 'moc.é'
    expect(chReversedLiteral('é.com')).toBe("'moc.\\xa9\\xc3'")
  })

  test('a reversed literal unescapes to the reversed bytes', () => {
    for (const v of ['ledger.com', 'é.com', 'gma?°l.com', 'пример.рф', "o'neil.com"]) {
      expect(unescapeToBytes(chReversedLiteral(v)).equals(Buffer.from(Buffer.from(v, 'utf8')).reverse())).toBe(true)
    }
  })
})

describe('array literals', () => {
  test('comma-joined inside brackets, empty is []', () => {
    expect(chStringArrayLiteral(['a.com', "b'c.com"])).toBe("['a.com','b\\'c.com']")
    expect(chStringArrayLiteral([])).toBe('[]')
    expect(chReversedArrayLiteral(['ab.com', 'é.com'])).toBe("['moc.ba','moc.\\xa9\\xc3']")
    expect(chReversedArrayLiteral([])).toBe('[]')
  })
})
