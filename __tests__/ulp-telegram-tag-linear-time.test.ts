/**
 * stripTelegramTag must take linear time, and must cut every line exactly as before.
 *
 * Three of its regexes restarted at every position of a run: the removal of "scheme://" from the text behind the link (a long token of letters, digits, '+', '.', '-' there
 * cost n*n steps), the cut of trailing white space and colons (a run in the middle of the text in front of the link), and the loop that strips repeated "https://" re-scanned
 * the whole text once per repetition.
 */
import { describe, expect, it } from 'vitest'
import { hasColonOutsideSchemes, stripTelegramTag, stripTrailingSpaceAndColons } from '@/lib/ulp-telegram-tag'

function* allStrings(alphabet: string[], maxLen: number): Generator<string> {
  let layer = ['']
  yield ''
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = []
    for (const s of layer) for (const c of alphabet) { next.push(s + c); yield s + c }
    layer = next
  }
}

describe('hasColonOutsideSchemes: the same answer as the regex it replaces', () => {
  it('agrees with tail.replace(/[A-Za-z][A-Za-z0-9+.-]*:\\/\\//g, "").includes(":") on every string of up to 8 characters over a letter, a digit, a dot, a colon and a slash', () => {
    const bad: string[] = []
    let checked = 0
    for (const s of allStrings(['a', '1', '.', ':', '/'], 8)) {
      checked++
      const expected = s.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\//g, '').includes(':')
      if (hasColonOutsideSchemes(s) !== expected && bad.length < 5) bad.push(JSON.stringify(s))
    }
    expect(checked).toBeGreaterThan(400_000)
    expect(bad).toEqual([])
  }, 120_000)

  it('agrees on every string of up to 7 characters over a letter, a plus, a dash, a colon, a slash and a space', () => {
    const bad: string[] = []
    for (const s of allStrings(['b', '+', '-', ':', '/', ' '], 7)) {
      const expected = s.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\//g, '').includes(':')
      if (hasColonOutsideSchemes(s) !== expected && bad.length < 5) bad.push(JSON.stringify(s))
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('reads the documented shapes', () => {
    expect(hasColonOutsideSchemes('Chan|NAME;@NAME|https://t.me/+AbC123')).toBe(false) // the colon of a scheme is not a field separator
    expect(hasColonOutsideSchemes('Chan:more')).toBe(true)
    expect(hasColonOutsideSchemes('12://x')).toBe(true) // no letter: not a scheme
  })
})

describe('stripTrailingSpaceAndColons: the same cut as the regex it replaces', () => {
  it('agrees with s.replace(/[\\s:]+$/, "") on every string of up to 8 characters over space, tab, colon, a letter and a no-break space', () => {
    const bad: string[] = []
    let checked = 0
    for (const s of allStrings([' ', '\t', ':', 'a', ' '], 8)) {
      checked++
      if (stripTrailingSpaceAndColons(s) !== s.replace(/[\s:]+$/, '') && bad.length < 5) bad.push(JSON.stringify(s))
    }
    expect(checked).toBeGreaterThan(400_000)
    expect(bad).toEqual([])
  }, 120_000)
})

describe('stripTelegramTag: linear time and the same cuts', () => {
  const RUN = Number(process.env.LINEAR_RUN ?? 400_000)
  const time = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t }

  it.each([
    ['a long token of letters and digits behind the link', 'login:pass t.me/' + 'a1'.repeat(RUN / 2)],
    ['a long run of white space and colons in the middle of the text in front of the link', 'login:pass' + ' : '.repeat(RUN / 3) + 'word' + ' : '.repeat(RUN / 3) + ' t.me/Chan'],
    ['a long run of spaces in front of the link', 'login:pass' + ' '.repeat(RUN) + 'word' + ' '.repeat(RUN) + ' t.me/Chan'],
    ['thousands of repeated schemes in front of the link', 'https://a.test/x:' + 'https://'.repeat(RUN / 8) + ' t.me/Chan'],
    ['thousands of repeated slashes in front of the link', 'host.test/x:' + '//'.repeat(RUN / 2) + ' t.me/Chan'],
  ])('%s', (_label, line) => {
    expect(time(() => stripTelegramTag(line))).toBeLessThan(1000)
  })

  it('still cuts the tags of the documented shapes', () => {
    expect(stripTelegramTag('shop.example.test/:alice:Secret1 https://t.me/SomeChannel')).toBe('shop.example.test/:alice:Secret1')
    expect(stripTelegramTag('shop.example.test/login:alice@mail.test:Secret1          @best_ulp - daily | https://t.me/+AbC123')).toBe('shop.example.test/login:alice@mail.test:Secret1')
    expect(stripTelegramTag('login:pass https://https://t.me/Chan')).toBe('login:pass')
  })
})
