/**
 * Parser v6.3 (docs/superpowers/specs/2026-11-02-promo-signature-and-uncounted-lines-design.md). Two defects that a line count of a real batch found; every fixture is synthetic.
 *
 * N: a promotional signature at the end of a line ("<url>:<login>:<password> ┃ @channel words / more") is cut before the line is read (lib/ulp-promo-signature.ts). Before, the
 *    field split refused such a line, and the few that parsed stored the tail inside the password.
 * The lines of a record that was opened and never finished: a line that starts with "http" and that the split rejects waits for a login line (positional record). When a blank line,
 *    a labeled line or the end of the file closed that wait, the waiting line was dropped without a count: not stored, not rejected, and invisible to the quality gate, which counts what the
 *    parser reports. Now it is a rejected line like any other.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parseULPContent, parseULPStream } from '@/lib/ulp-parser'
import { openSource } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { preflightSource } from '@/lib/ingest-preflight'

const SRC = 'v6-3.txt'
const SIG = ' ┃ @some_channel promo words / more'

async function streamParse(content: string, batchSize = 1000) {
  const credentials: Array<{ url: string; email: string; password: string }> = []
  let rejected = 0
  let noCredential = 0
  const breakdown: Record<string, number> = {}
  const body = new Response(content).body as ReadableStream<Uint8Array>
  for await (const b of parseULPStream(body, SRC, batchSize, undefined, { dedupInFile: false })) {
    credentials.push(...b.credentials)
    rejected += b.rejected
    noCredential += b.noCredential ?? 0
    for (const [k, v] of Object.entries(b.breakdown)) breakdown[k] = (breakdown[k] ?? 0) + v
  }
  return { credentials, rejected, noCredential, breakdown }
}

const plain = (i: number) => `https://s${i}.example.test:user${i}@mail.test:Secret${i}`
const joinLines = (lines: string[], sep = '\n') => lines.join(sep) + sep

describe('rule N: the signature is not part of the password', () => {
  const signed = plain(1) + SIG

  test('parseULPStream stores the credential an unsigned line gives', async () => {
    const r = await streamParse(joinLines([signed]))
    const expected = await streamParse(joinLines([plain(1)]))
    expect(r.credentials).toEqual(expected.credentials)
    expect(r.credentials).toHaveLength(1)
    expect(r.credentials[0].password).toBe('Secret1')
    expect(r.rejected).toBe(0)
  })

  // Two kinds of signed line met in the data: one the split could not read (dropped, uncounted) and one with a path in the url that parsed with the tail inside the password.
  test.each([
    ['a url with a path', 'https://shop.example.test/login:alice@mail.test:Secret1'],
    ['a url with a port', 'https://shop.example.test:8443:alice@mail.test:Secret1'],
    ['a login that is not an e-mail address', 'https://shop.example.test:alice:Secret1'],
    ['no scheme', 'shop.example.test:alice@mail.test:Secret1'],
  ])('%s: the signed line gives the credential the unsigned line gives, with no tail in the password', async (_label, line) => {
    const expected = await streamParse(joinLines([line]))
    const r = await streamParse(joinLines([line + SIG]))
    expect(expected.credentials).toHaveLength(1)
    expect(r.credentials).toEqual(expected.credentials)
    expect(r.credentials[0].password).toBe('Secret1')
  })

  test('parseULPContent stores the same credential', () => {
    const r = parseULPContent(plain(1) + SIG, SRC)
    expect(r.credentials.map(c => c.password)).toEqual(['Secret1'])
    expect(r.skipped).toBe(0)
  })

  test('a CRLF file with a blank line after every record gives one credential per record and counts only the blank lines', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => plain(i) + SIG)
    const r = await streamParse(lines.join('\r\n\r\n') + '\r\n\r\n')
    expect(r.credentials).toHaveLength(50)
    expect(r.credentials.every(c => !c.password.includes('┃') && !c.password.includes('@'))).toBe(true)
    expect(r.breakdown.no_fields).toBe(0)
    expect(r.breakdown.blank).toBe(50)
    expect(r.rejected).toBe(50)
  })

  test('the signature is cut from a labeled password too', async () => {
    const r = await streamParse(joinLines(['URL: https://shop.example.test/login', 'Login: alice', 'Password: Secret1' + SIG, '']))
    expect(r.credentials.map(c => c.password)).toEqual(['Secret1'])
  })

  test('a bar inside a password, with no white space in front of it or no @ behind it, stays', async () => {
    const r = await streamParse(joinLines(['https://a.example.test:alice@mail.test:pa┃ss', 'https://b.example.test:bob@mail.test:pa ┃ ss']))
    expect(r.credentials.map(c => c.password)).toEqual(['pa┃ss', 'pa ┃ ss'])
  })
})

describe('a record that was opened and never finished is counted', () => {
  const bareUrl = 'https://shop.example.test/login'

  test.each([
    ['a blank line', joinLines([bareUrl, ''])],
    ['the end of the file with a newline', joinLines([bareUrl])],
    ['the end of the file without a newline', bareUrl],
  ])('a bare url closed by %s is one rejected no_fields line, and it cannot hold a credential', async (_label, content) => {
    const r = await streamParse(content)
    expect(r.credentials).toEqual([])
    expect(r.breakdown.no_fields).toBe(1)
    expect(r.noCredential).toBe(1)
    expect(r.rejected).toBe(1 + (r.breakdown.blank ?? 0))
  })

  test('a url and a login closed by a blank line are one rejected no_password record', async () => {
    const r = await streamParse(joinLines([bareUrl, 'alice@mail.test', '']))
    expect(r.credentials).toEqual([])
    expect(r.breakdown.no_password).toBe(1)
    expect(r.breakdown.no_fields).toBe(0)
    expect(r.breakdown.blank).toBe(1)
    expect(r.rejected).toBe(2)
  })

  test('a url and a login at the end of the file are one rejected no_password record', async () => {
    const r = await streamParse(joinLines([bareUrl, 'alice@mail.test']))
    expect(r.breakdown.no_password).toBe(1)
    expect(r.rejected).toBe(1)
  })

  test('a bare url followed by a labeled line is counted before the labeled block starts', async () => {
    const r = await streamParse(joinLines([bareUrl, 'Login: alice', 'Password: Secret1', '']))
    expect(r.breakdown.no_fields).toBe(1)
    expect(r.noCredential).toBe(1)
  })

  test('a finished url, login, password record is untouched: one credential, nothing rejected but the blank line', async () => {
    const r = await streamParse(joinLines([bareUrl, 'alice@mail.test', 'Secret1', '']))
    expect(r.credentials).toHaveLength(1)
    expect(r.credentials[0]).toMatchObject({ url: bareUrl, email: 'alice@mail.test', password: 'Secret1' })
    expect(r.breakdown.no_fields).toBe(0)
    expect(r.breakdown.no_password).toBe(0)
    expect(r.rejected).toBe(1)
  })

  test.each([
    ['a blank line', [bareUrl, '', plain(1)].join('\n'), 'no_fields'],
    ['the end of the file', [plain(1), bareUrl].join('\n'), 'no_fields'],
    ['a blank line (url and login)', [bareUrl, 'alice@mail.test', '', plain(1)].join('\n'), 'no_password'],
    ['the end of the file (url and login)', [plain(1), bareUrl, 'alice@mail.test'].join('\n'), 'no_password'],
  ])('parseULPContent counts the record closed by %s', (_label, content, reason) => {
    const r = parseULPContent(content, SRC)
    expect(r.rejection_breakdown[reason]).toBe(1)
    expect(r.credentials.map(c => c.email)).toEqual(['user1@mail.test'])
  })
})

describe('no line vanishes: credentials + rejected equals the number of lines', () => {
  // The vocabulary holds only lines that cannot become the login line of a positional record (each has "://", or is blank), so every line is either stored or rejected.
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const kinds: Array<(i: number) => string> = [
    i => plain(i),
    i => plain(i) + SIG,
    i => `https://s${i}.example.test/login`,
    i => `https://a${i}.example.test:https://b${i}.example.test/x`,
    () => '',
    () => '',
  ]

  test('parseULPStream, 300 random files of up to 60 lines with either line ending', async () => {
    const rnd = mulberry32(20261102)
    const failures: string[] = []
    for (let f = 0; f < 300; f++) {
      const n = 1 + Math.floor(rnd() * 60)
      const lines = Array.from({ length: n }, (_, i) => kinds[Math.floor(rnd() * kinds.length)](f * 100 + i))
      const sep = rnd() < 0.5 ? '\n' : '\r\n'
      const r = await streamParse(lines.join(sep) + sep)
      if (r.credentials.length + r.rejected !== n) failures.push(`file ${f}: ${n} lines, ${r.credentials.length} stored + ${r.rejected} rejected`)
      if (r.credentials.some(c => c.password.includes('┃'))) failures.push(`file ${f}: a password kept the signature`)
      if ((r.breakdown.blank ?? 0) !== lines.filter(l => l === '').length) failures.push(`file ${f}: blank lines miscounted`)
    }
    expect(failures).toEqual([])
  })

  test('parseULPContent, the same files without a closing newline', () => {
    const rnd = mulberry32(20261103)
    const failures: string[] = []
    for (let f = 0; f < 300; f++) {
      const n = 1 + Math.floor(rnd() * 60)
      const lines = Array.from({ length: n }, (_, i) => kinds[Math.floor(rnd() * kinds.length)](f * 100 + i))
      const r = parseULPContent(lines.join('\n'), SRC)
      if (r.credentials.length + r.skipped !== n) failures.push(`file ${f}: ${n} lines, ${r.credentials.length} stored + ${r.skipped} skipped`)
    }
    expect(failures).toEqual([])
  })
})

describe('lines built to be slow around the signature', () => {
  const N = 200_000
  const cases: Array<[string, string]> = [
    ['a long white-space run in front of the bar', 'https://a.example.test:u@mail.test:p' + ' '.repeat(N) + SIG.trim()],
    ['a long white-space run behind the bar and no @', 'https://a.example.test:u@mail.test:p ┃' + ' '.repeat(N) + 'x'],
    ['a long run of bars, each with white space around it', 'https://a.example.test:u@mail.test:p' + ' ┃'.repeat(N) + ' @end'],
    ['a long bare url and a long run of spaces after it', 'https://' + 'a'.repeat(N) + '.example.test/' + ' '.repeat(N)],
  ]

  test.each(cases)('%s: read in bounded time, and nothing throws', async (_label, line) => {
    const t0 = performance.now()
    const r = await streamParse(joinLines([line, '', plain(1), '']))
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(r.credentials.map(c => c.email)).toContain('user1@mail.test')
  })
})

describe('what the quality gate sees', () => {
  let root: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'v6-3-')) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const CONFIG = { ...parseGateConfig({}), minLines: 100 }
  const put = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p }

  test('a file of signed records with a blank line after each is read in full and passes', async () => {
    const text = Array.from({ length: 400 }, (_, i) => plain(i) + SIG).join('\r\n\r\n') + '\r\n\r\n'
    const r = await preflightSource(openSource(put('signed.txt', text)), { config: CONFIG })
    expect(r.counters.lines).toBe(400)
    expect(r.counters.stored).toBe(400)
    expect(r.counters.noFields).toBe(0)
    expect(r.unsplitShapes).toEqual([]) // the second look at the unreadable lines cuts the signature too
    expect(r.verdict.level).toBe('pass')
  })

  test('a file of credential lines the split cannot read, a blank line after each, is held: its lines used to vanish before the gate counted them', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `https://s${i}.example.test:alice${i}:Pass/wor/d1/x`).join('\n\n') + '\n\n'
    const r = await preflightSource(openSource(put('unreadable.txt', text)), { config: CONFIG })
    expect(r.counters.noFields).toBe(400)
    expect(r.counters.noCredential).toBe(0)
    expect(r.verdict.level).toBe('hold')
  })

  test('a file of bare urls with a blank line after each is not held: a bare url cannot hold a credential', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `https://s${i}.example.test/login`).join('\n\n') + '\n\n'
    const r = await preflightSource(openSource(put('urls.txt', text)), { config: CONFIG })
    expect(r.counters.noFields).toBe(400)
    expect(r.counters.noCredential).toBe(400)
    expect(r.verdict.level).not.toBe('hold')
  })
})
