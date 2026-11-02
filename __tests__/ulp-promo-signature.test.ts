/**
 * stripPromoSignature (lib/ulp-promo-signature.ts, parser v6.3, rule N).
 *
 * Some Telegram channels end every record line with a promotional tail: "<url>:<login>:<password> ┃ @channel words / more". The field split cannot read such a line,
 * and the lines that did parse stored the tail inside the password. The cut is white space, a heavy vertical bar (U+2503), optional white space and an "@", to the end of
 * the line. It takes linear time: a quadratic regex on a long white-space run stalled an import once (ulp-telegram-tag-linear-time.test.ts). All fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest'
import { stripPromoSignature } from '@/lib/ulp-promo-signature'

const credential = 'https://shop.example.test:alice@mail.test:Secret1'

function* allStrings(alphabet: string[], maxLen: number): Generator<string> {
  let layer = ['']
  yield ''
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = []
    for (const s of layer) for (const c of alphabet) { next.push(s + c); yield s + c }
    layer = next
  }
}

describe('a signature at the end of a line', () => {
  it.each([
    [' ┃ @some_channel promo words / more'],
    ['  ┃  @some_channel promo words / more'],
    ['\t┃ @some_channel'],
    [' ┃@some_channel x'],
    [' ┃ @some_channel promo words / more\r'],
    [' ┃ @some_channel'],
  ])('is removed with the white space in front of it: %j', tail => {
    expect(stripPromoSignature(credential + tail)).toBe(credential)
  })

  it('is removed from the first bar that has white space in front and an @ behind it, to the end of the line', () => {
    expect(stripPromoSignature('a:b:pa ┃ ss ┃ @chan x')).toBe('a:b:pa ┃ ss')
    expect(stripPromoSignature('x ┃ @a ┃ @b')).toBe('x')
  })

  it('leaves the line alone when it has no such tail (the same string comes back)', () => {
    for (const line of [
      '',
      credential,
      '┃ @some_channel',                 // the bar opens the line: nothing in front of it
      'a:b:pass┃ @chan',                 // no white space in front of the bar
      'a:b:pass ┃ words',                // not followed by an @
      'a:b:pass ┃',
      'a:b:pass ┃   ',
      'a:b:pass @chan',                  // an @ handle without the bar
      'a:b:pa┃ss',
    ]) expect(stripPromoSignature(line)).toBe(line)
  })

  it('removes a line down to nothing when only white space and the signature are left', () => {
    expect(stripPromoSignature('   ┃ @some_channel')).toBe('')
  })
})

describe('the same cut as the regex it stands in for', () => {
  const reference = (s: string) => s.replace(/\s+┃\s*@[\s\S]*$/, '')

  it('agrees on every string of up to 8 characters over a space, a tab, the bar, an @ and a letter', () => {
    const bad: string[] = []
    let checked = 0
    for (const s of allStrings([' ', '\t', '┃', '@', 'a'], 8)) {
      checked++
      if (stripPromoSignature(s) !== reference(s) && bad.length < 5) bad.push(JSON.stringify(s))
    }
    expect(checked).toBeGreaterThan(400_000)
    expect(bad).toEqual([])
  }, 120_000)

  it('agrees on every string of up to 7 characters over a no-break space, a carriage return, the bar, an @ and a colon', () => {
    const bad: string[] = []
    for (const s of allStrings([' ', '\r', '┃', '@', ':'], 7)) {
      if (stripPromoSignature(s) !== reference(s) && bad.length < 5) bad.push(JSON.stringify(s))
    }
    expect(bad).toEqual([])
  }, 120_000)
})

describe('linear time', () => {
  const N = 1_000_000
  const timed = (s: string) => { const t = performance.now(); const out = stripPromoSignature(s); return { out, ms: performance.now() - t } }

  it('a million spaces with no bar', () => {
    const { out, ms } = timed('a:b:' + ' '.repeat(N))
    expect(out.length).toBe(N + 4)
    expect(ms).toBeLessThan(500)
  })

  it('a million spaces in front of a bar that no @ follows', () => {
    const { ms } = timed('a:b:p' + ' '.repeat(N) + '┃' + ' '.repeat(N))
    expect(ms).toBeLessThan(500)
  })

  it('a hundred thousand bars, each with white space around it and an @ only at the very end', () => {
    const { out, ms } = timed('a:b:p' + ' ┃'.repeat(100_000) + ' @end')
    expect(out).toBe('a:b:p' + ' ┃'.repeat(99_999))
    expect(ms).toBeLessThan(500)
  })

  it('a hundred thousand bars separated by long runs of white space and no @ at all', () => {
    const { ms } = timed(('┃' + ' '.repeat(100)).repeat(10_000))
    expect(ms).toBeLessThan(500)
  })
})
