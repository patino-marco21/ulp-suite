/**
 * splitSpacePaddedColons ("host : login : password") must take linear time, and must read every line exactly as it did before it was made linear.
 *
 * The first version searched for /\s+:\s+/: inside a run of n white-space characters every position is a possible start, so a run that is not followed by a colon
 * costs n*n steps. One line of about 400,000 spaces held the importer's single thread for minutes (inserts timed out, the web UI did not answer), whether or not
 * the line held a colon at all.
 */
import { describe, expect, it } from 'vitest'
import { splitSpacePaddedColons } from '@/lib/ulp-recover'

/** The function as it was before: the same body with the original, quadratic regex. It is the reference of the differential. */
const OLD_PADDED_COLON = /\s+:\s+/
const EMAIL_SHAPE = /^[^\s/:@]+@[^\s/:@]+\.[^\s/:@]+$/
function oldSplitSpacePaddedColons(line: string): [string, string, string] | null {
  if (line.includes('://')) return null
  const first = OLD_PADDED_COLON.exec(line)
  if (!first) return null
  const head = line.slice(0, first.index)
  const afterFirst = line.slice(first.index + first[0].length)
  if (EMAIL_SHAPE.test(head)) {
    if (afterFirst === '' || OLD_PADDED_COLON.test(afterFirst)) return null
    return ['', head, afterFirst]
  }
  const second = OLD_PADDED_COLON.exec(afterFirst)
  if (!second) return null
  const login = afterFirst.slice(0, second.index)
  const password = afterFirst.slice(second.index + second[0].length)
  if (!/[./]/.test(head) || head.includes(':') || /\s/.test(head) || /\s/.test(login) || login === '' || password === '' || OLD_PADDED_COLON.test(password)) return null
  return [head, login, password]
}

function* allStrings(alphabet: string[], maxLen: number): Generator<string> {
  let layer = ['']
  yield ''
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = []
    for (const s of layer) for (const c of alphabet) { next.push(s + c); yield s + c }
    layer = next
  }
}

type Fields = [string, string, string] | null
const same = (a: Fields, b: Fields): boolean => a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2])

/** The strings on which the new function and the old one disagree (at most 5 are kept, for the message). */
function disagreements(strings: Iterable<string>): { checked: number; bad: string[] } {
  let checked = 0
  const bad: string[] = []
  for (const s of strings) {
    checked++
    if (!same(splitSpacePaddedColons(s), oldSplitSpacePaddedColons(s)) && bad.length < 5) bad.push(JSON.stringify(s))
  }
  return { checked, bad }
}

describe('splitSpacePaddedColons: same answers as before', () => {
  it('agrees with the original on every string of up to 8 characters over space, tab, colon, a letter and a dot', () => {
    const r = disagreements(allStrings([' ', '\t', ':', 'a', '.'], 8))
    expect(r.checked).toBeGreaterThan(400_000)
    expect(r.bad).toEqual([])
  }, 120_000)

  it('agrees with the original on every string of up to 6 characters over space, colon, at, a letter, a dot and a no-break space', () => {
    const r = disagreements(allStrings([' ', ':', '@', 'a', '.', '\u00a0'], 6))
    expect(r.checked).toBeGreaterThan(50_000)
    expect(r.bad).toEqual([])
  }, 120_000)

  it('agrees with the original on a few thousand random longer lines built from credential-like pieces', () => {
    let seed = 20261012
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 }
    const pieces = ['shop.example.test', 'alice@mail.test', 'bob', 'Secret1', ' : ', ' :', ': ', ':', '  ', '\t', ' ', '/', 'x.y', '@', '://', '\u00a0:\u00a0']
    const lines: string[] = []
    for (let i = 0; i < 5000; i++) {
      let s = ''
      for (let k = 0, n = 1 + Math.floor(rnd() * 9); k < n; k++) s += pieces[Math.floor(rnd() * pieces.length)]
      lines.push(s)
    }
    expect(disagreements(lines).bad).toEqual([])
  })

  it('still reads the documented shapes', () => {
    expect(splitSpacePaddedColons('shop.example.test : alice : Secret1')).toEqual(['shop.example.test', 'alice', 'Secret1'])
    expect(splitSpacePaddedColons('alice@mail.test : Secret1')).toEqual(['', 'alice@mail.test', 'Secret1'])
    expect(splitSpacePaddedColons('Join us : alice : Secret1')).toBeNull()
  })
})

describe('splitSpacePaddedColons: linear time', () => {
  const RUN = Number(process.env.LINEAR_RUN ?? 400_000) // LINEAR_RUN=40000 shows the failure of the old regex in seconds instead of minutes
  const limitMs = 1000 // the quadratic version needs minutes at this size; the linear one a few milliseconds
  const time = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t }

  it.each([
    ['a run of spaces and nothing else', ' '.repeat(RUN)],
    ['a run of spaces between two words, no colon at all', 'head' + ' '.repeat(RUN) + 'tail'],
    ['a run of spaces with a colon in the head and in the tail but never next to white space', 'a.test/x:y' + ' '.repeat(RUN) + 'z@w:v'],
    ['a run of tabs', 'a.test\t'.repeat(1) + '\t'.repeat(RUN) + 'x'],
    ['a run of no-break spaces', 'a' + '\u00a0'.repeat(RUN) + 'b'],
    ['two long runs with a word between them', ' '.repeat(RUN / 2) + 'word' + ' '.repeat(RUN / 2) + '/p'],
    ['a long run followed by a real padded colon', 'a.test' + ' '.repeat(RUN) + 'x' + ' : ' + 'y'],
  ])('%s', (_label, line) => {
    expect(time(() => splitSpacePaddedColons(line))).toBeLessThan(limitMs)
  })

  it('still finds the fields of a line that has a long run in its password', () => {
    const line = 'host.test : alice : ' + 'p'.repeat(10) + ' '.repeat(RUN) + 'x'
    expect(splitSpacePaddedColons(line)).toEqual(['host.test', 'alice', 'p'.repeat(10) + ' '.repeat(RUN) + 'x'])
  })
})
