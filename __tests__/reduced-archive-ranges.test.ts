/**
 * The byte ranges of the reduced archive writer (docs/superpowers/plans/2026-11-15-reduced-archive.md, task 2): the union of the ranges the parser kept and the
 * ranges of the credentials the database says this file stored, and the copy of exactly those bytes out of a stream.
 */
import { describe, expect, test } from 'vitest'
import { androidFirstsToKeep, copyRanges, normalizeRanges } from '@/lib/reduced-archive'

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
      expect(r).toEqual({ bytes: 9, lines: 3 })
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
    expect(r).toEqual({ bytes: 4, lines: 1 })
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
    expect(r).toEqual({ bytes: 0, lines: 0 })
  })

  test('a range past the end of the source is an error, not a short file', async () => {
    await expect(copyRanges(chunksOf('aaa\n', 2), normalizeRanges([[0, 99]]), () => {})).rejects.toThrow(/past the end/)
  })
})
