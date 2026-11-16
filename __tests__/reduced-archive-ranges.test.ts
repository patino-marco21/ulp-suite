/**
 * The byte ranges of the reduced archive writer (docs/superpowers/plans/2026-11-15-reduced-archive.md, task 2): the union of the ranges the parser kept and the
 * ranges of the credentials the database says this file stored, and the copy of exactly those bytes out of a stream.
 */
import { describe, expect, test } from 'vitest'
import { androidFirstsToKeep, copyRanges, cutRanges, holesToCut, normalizeRanges } from '@/lib/reduced-archive'

const pairs = (flat: Float64Array) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]])

async function* chunksOf(text: string, size: number): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(text, 'latin1')
  for (let at = 0; at < bytes.length; at += size) yield Buffer.from(bytes.subarray(at, at + size))
}

describe('normalizeRanges', () => {
  test('sorts, and merges ranges that overlap or touch', () => {
    expect(pairs(normalizeRanges([[20, 30, 0, 5, 5, 8]]))).toEqual([[0, 8], [20, 30]])
    expect(pairs(normalizeRanges([[0, 10, 4, 6, 9, 12]]))).toEqual([[0, 12]])
  })

  test('drops empty ranges and takes several lists as one', () => {
    expect(pairs(normalizeRanges([[3, 3, 10, 12], [11, 15, 0, 1]]))).toEqual([[0, 1], [10, 15]])
    expect(normalizeRanges([]).length).toBe(0)
    expect(normalizeRanges([[], []]).length).toBe(0)
  })

  test('a list that is already sorted gives the same answer as a shuffled one', () => {
    let seed = 7
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const flat: number[] = []
    for (let i = 0; i < 500; i++) { const s = Math.floor(rnd() * 5000); flat.push(s, s + 1 + Math.floor(rnd() * 40)) }
    const sortedPairs = pairs(Float64Array.from(flat)).sort((a, b) => a[0] - b[0])
    const sortedFlat = sortedPairs.flat()
    expect(pairs(normalizeRanges([sortedFlat]))).toEqual(pairs(normalizeRanges([flat])))
    // the plain way: mark every byte
    const marked = new Uint8Array(6000)
    for (let i = 0; i < flat.length; i += 2) marked.fill(1, flat[i], flat[i + 1])
    const expected: number[][] = []
    for (let i = 0; i < marked.length; i++) if (marked[i] && (i === 0 || !marked[i - 1])) { let j = i; while (marked[j]) j++; expected.push([i, j]) }
    expect(pairs(normalizeRanges([flat]))).toEqual(expected)
  })
})

describe('androidFirstsToKeep', () => {
  const ranges = normalizeRanges([[100, 200, 300, 400]])

  test('a repeat inside a range asks for the first line of its pair; one outside every range asks for nothing', () => {
    // quadruples: repeat start, repeat end, first start, first end
    expect(androidFirstsToKeep(ranges, [[110, 150, 10, 40]])).toEqual([10, 40])
    expect(androidFirstsToKeep(ranges, [[210, 250, 10, 40]])).toEqual([])
    expect(androidFirstsToKeep(ranges, [[410, 450, 10, 40]])).toEqual([])
    expect(androidFirstsToKeep(ranges, [[50, 90, 10, 40]])).toEqual([])
  })

  test('a repeat must lie wholly inside a range, edges included', () => {
    expect(androidFirstsToKeep(ranges, [[100, 200, 1, 2]])).toEqual([1, 2])
    expect(androidFirstsToKeep(ranges, [[300, 400, 1, 2]])).toEqual([1, 2])
    expect(androidFirstsToKeep(ranges, [[190, 210, 1, 2]])).toEqual([])
    expect(androidFirstsToKeep(ranges, [[90, 110, 1, 2]])).toEqual([])
  })

  test('several lists and several repeats of one pair', () => {
    const out = androidFirstsToKeep(ranges, [[110, 120, 5, 9, 130, 140, 5, 9], [350, 360, 20, 30]])
    expect(out).toEqual([5, 9, 5, 9, 20, 30])
    expect(pairs(normalizeRanges([out]))).toEqual([[5, 9], [20, 30]])
  })

  test('no ranges or no repeats', () => {
    expect(androidFirstsToKeep(new Float64Array(0), [[1, 2, 3, 4]])).toEqual([])
    expect(androidFirstsToKeep(ranges, [])).toEqual([])
    expect(androidFirstsToKeep(ranges, [[]])).toEqual([])
  })
})

describe('copyRanges', () => {
  test('copies exactly the ranges, across chunk boundaries of every size, with a blank line where lines were left out', async () => {
    const text = 'aaa\nbbb\nccc\nddd\neee\n'
    const ranges = normalizeRanges([[4, 8, 12, 16]])
    for (const size of [1, 2, 3, 5, 7, 100]) {
      const out: Buffer[] = []
      const r = await copyRanges(chunksOf(text, size), ranges, b => out.push(Buffer.from(b)))
      expect(Buffer.concat(out).toString('latin1')).toBe('bbb\n\nddd\n')
      expect(r).toEqual({ bytes: 9, lines: 3, placeholders: 0 })
    }
  })

  test('ranges that touch are one range: no blank line between them, none in front of the first or behind the last', async () => {
    const out: Buffer[] = []
    await copyRanges(chunksOf('aaa\nbbb\nccc\nddd\n', 4), normalizeRanges([[0, 4, 4, 8, 12, 16]]), b => out.push(Buffer.from(b)))
    expect(Buffer.concat(out).toString('latin1')).toBe('aaa\nbbb\n\nddd\n')
  })

  test('a kept range that ends the source without a newline gets one', async () => {
    const out: Buffer[] = []
    const r = await copyRanges(chunksOf('aaa\nbbb', 2), normalizeRanges([[4, 7]]), b => out.push(Buffer.from(b)))
    expect(Buffer.concat(out).toString('latin1')).toBe('bbb\n')
    expect(r).toEqual({ bytes: 4, lines: 1, placeholders: 0 })
  })

  test('a range that stops inside a line is closed with a newline, so the next range cannot glue onto it', async () => {
    const out: Buffer[] = []
    await copyRanges(chunksOf('abcdef\nghi\n', 4), normalizeRanges([[0, 3, 7, 11]]), b => out.push(Buffer.from(b)))
    expect(Buffer.concat(out).toString('latin1')).toBe('abc\n\nghi\n')
  })

  test('no ranges copies nothing', async () => {
    const out: Buffer[] = []
    const r = await copyRanges(chunksOf('aaa\n', 2), normalizeRanges([]), b => out.push(Buffer.from(b)))
    expect(out).toEqual([])
    expect(r).toEqual({ bytes: 0, lines: 0, placeholders: 0 })
  })

  test('a range past the end of the source is an error, not a short file', async () => {
    await expect(copyRanges(chunksOf('aaa\n', 2), normalizeRanges([[0, 99]]), () => {})).rejects.toThrow(/past the end/)
  })

  test('a piece that follows a hole inside its range gets a placeholder line, not a blank one; a piece that follows a gap between ranges still gets the blank line', async () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\neeee\nffff\n'
    for (const size of [1, 3, 7, 100]) {
      const out: Buffer[] = []
      // pieces: aaaa, cccc+dddd (after a hole), ffff (after a gap)
      const r = await copyRanges(chunksOf(text, size), Float64Array.from([0, 5, 10, 20, 25, 30]), b => out.push(Buffer.from(b)), Uint8Array.from([0, 1, 0]), '#')
      expect(Buffer.concat(out).toString('latin1')).toBe('aaaa\n#\ncccc\ndddd\n\nffff\n')
      expect(r).toEqual({ bytes: 23, lines: 6, placeholders: 1 })
    }
  })

  test('the placeholder follows a piece that stopped inside a line, after that line is closed', async () => {
    const out: Buffer[] = []
    await copyRanges(chunksOf('abcdef\nghi\n', 4), Float64Array.from([0, 3, 7, 11]), b => out.push(Buffer.from(b)), Uint8Array.from([0, 1]), '#')
    expect(Buffer.concat(out).toString('latin1')).toBe('abc\n#\nghi\n')
  })
})

describe('cutRanges', () => {
  test('cuts the holes out of the ranges and marks the pieces that follow a hole inside the same range', () => {
    const { pieces, holeBefore } = cutRanges(normalizeRanges([[0, 100, 200, 300]]), normalizeRanges([[10, 20, 30, 40, 250, 260]]))
    expect(pairs(pieces)).toEqual([[0, 10], [20, 30], [40, 100], [200, 250], [260, 300]])
    expect([...holeBefore]).toEqual([0, 1, 1, 0, 1])
  })

  test('a hole at the edge of a range only shortens it; a hole over a whole range removes it; a hole across a gap leaves a gap', () => {
    const ranges = normalizeRanges([[0, 100, 200, 300, 400, 500]])
    const { pieces, holeBefore } = cutRanges(ranges, normalizeRanges([[0, 10, 90, 100, 200, 300, 450, 460]]))
    expect(pairs(pieces)).toEqual([[10, 90], [400, 450], [460, 500]])
    expect([...holeBefore]).toEqual([0, 0, 1])
    const across = cutRanges(normalizeRanges([[0, 100, 200, 300]]), normalizeRanges([[90, 210]]))
    expect(pairs(across.pieces)).toEqual([[0, 90], [210, 300]])
    expect([...across.holeBefore]).toEqual([0, 0])
  })

  test('no holes gives the ranges back; no ranges gives nothing', () => {
    const ranges = normalizeRanges([[0, 100, 200, 300]])
    expect(pairs(cutRanges(ranges, new Float64Array(0)).pieces)).toEqual([[0, 100], [200, 300]])
    expect([...cutRanges(ranges, new Float64Array(0)).holeBefore]).toEqual([0, 0])
    expect(cutRanges(new Float64Array(0), normalizeRanges([[1, 2]])).pieces.length).toBe(0)
  })
})

describe('holesToCut', () => {
  // The spans come in the order the parser emits them: a record is emitted after the credentials nested in it. Every byte belongs to the innermost credential that covers it.
  test('a dropped credential is a hole, a kept one is not; touching holes are one hole', () => {
    expect(pairs(holesToCut([[0, 10, 10, 20, 20, 30]], [0, 10], []))).toEqual([[10, 30]])
    expect(pairs(holesToCut([[0, 10]], [0, 10], []))).toEqual([])
    expect(pairs(holesToCut([], [0, 10], []))).toEqual([])
  })

  test('a dropped credential inside a kept record is a hole: the record keeps its own lines and loses what was nested in it', () => {
    // 10-20 and 20-30 are dropped credentials; 0-100 is a kept record that holds them (it is emitted last)
    expect(pairs(holesToCut([[10, 20, 20, 30, 0, 100]], [0, 100], []))).toEqual([[10, 30]])
    // one level deeper: a dropped credential in a dropped one in a kept one
    expect(pairs(holesToCut([[20, 30, 10, 40, 0, 100]], [0, 100], []))).toEqual([[10, 40]])
  })

  test('a kept credential inside a dropped record stays; the rest of the dropped record is a hole', () => {
    expect(pairs(holesToCut([[45, 50, 40, 60]], [45, 50], []))).toEqual([[40, 45], [50, 60]])
    expect(pairs(holesToCut([[0, 10, 45, 50, 40, 60]], [0, 10, 45, 50], []))).toEqual([[40, 45], [50, 60]])
  })

  test('an android first stays whatever it is nested in; so does a credential that shares its span with a kept one', () => {
    expect(pairs(holesToCut([[10, 20, 30, 40, 0, 100]], [0, 100], [30, 40]))).toEqual([[10, 20]])
    expect(pairs(holesToCut([[0, 10, 0, 10]], [0, 10], []))).toEqual([])
    expect(pairs(holesToCut([[0, 10, 0, 10]], [], []))).toEqual([[0, 10]])
  })

  test('lists come one per batch, and a record can be emitted in a later batch than what is nested in it', () => {
    expect(pairs(holesToCut([[10, 20], [20, 30], [0, 100, 200, 210]], [0, 100], []))).toEqual([[10, 30], [200, 210]])
  })

  test('spans that overlap without nesting, or arrive out of file order, are not understood: nothing is cut', () => {
    expect(holesToCut([[0, 10, 5, 15]], [], []).length).toBe(0)
    expect(holesToCut([[10, 20, 0, 5]], [], []).length).toBe(0)
  })
})
