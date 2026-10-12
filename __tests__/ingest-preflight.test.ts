import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendManifest, archiveFile, openSource } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { preflightSource, sliceRanges, wholeLines } from '@/lib/ingest-preflight'

const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const wordsLine = (i: number) => `just some words number ${i} and nothing else`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
const CONFIG = { ...parseGateConfig({}), minLines: 100 }

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'preflight-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p }

describe('sliceRanges', () => {
  it('reads a small file whole, and nothing from an empty one', () => {
    expect(sliceRanges(1000, 5, 100, 8000)).toEqual([[0, 1000]])
    expect(sliceRanges(0, 5, 100, 8000)).toEqual([])
  })

  it('spreads slices evenly over a big file, the first at the start and the last ending at the end', () => {
    const r = sliceRanges(100_000, 5, 1000, 8000)
    expect(r).toHaveLength(5)
    expect(r[0]).toEqual([0, 1000])
    expect(r[4]).toEqual([99_000, 1000])
    expect(r.map(([o]) => o)).toEqual([0, 24_750, 49_500, 74_250, 99_000])
  })

  it('uses at least two slices', () => {
    expect(sliceRanges(100_000, 1, 1000, 8000)).toHaveLength(2)
  })
})

describe('wholeLines', () => {
  const buf = Buffer.from('partial\nwhole one\nwhole two\npartial')
  it('drops the partial line at the start and at the end of a slice from the middle of a file', () => {
    expect(wholeLines(buf, false, false).toString()).toBe('whole one\nwhole two\n')
  })

  it('keeps the start of a slice that starts the file and the end of one that ends it', () => {
    expect(wholeLines(buf, true, true).toString()).toBe(buf.toString())
    expect(wholeLines(buf, true, false).toString()).toBe('partial\nwhole one\nwhole two\n')
    expect(wholeLines(buf, false, true).toString()).toBe('whole one\nwhole two\npartial')
  })

  it('returns nothing when there is no newline to cut at', () => {
    expect(wholeLines(Buffer.from('no newline here'), false, false)).toHaveLength(0)
  })
})

describe('preflightSource', () => {
  it('passes a clean file and reads it whole', async () => {
    const r = await preflightSource(openSource(put('clean.txt', textOf(2_000, cleanLine))), { config: CONFIG })
    expect(r.whole).toBe(true)
    expect(r.verdict.level).toBe('pass')
    expect(r.counters).toMatchObject({ lines: 2_000, stored: 2_000, junk: 0 })
    expect(r.unsplitShapes).toEqual([])
  })

  it('holds a file whose rows break the rules, with the kinds and masked shapes, and no text', async () => {
    const r = await preflightSource(openSource(put('junk.txt', textOf(2_000, junkLine))), { config: CONFIG })
    expect(r.verdict.level).toBe('hold')
    expect(r.verdict.report.kinds).toEqual({ 'password-has-scheme': 2_000 })
    expect(JSON.stringify(r.verdict.report)).not.toContain('example.test')
  })

  it('holds a file most of whose lines cannot be split, and lists the masked shape of those lines', async () => {
    const r = await preflightSource(openSource(put('words.txt', textOf(2_000, wordsLine))), { config: CONFIG })
    expect(r.verdict.level).toBe('hold')
    expect(r.verdict.report.unsplitPct).toBeGreaterThan(90)
    expect(r.unsplitShapes[0]).toEqual({ shape: 'w w w w w w w w', count: 2_000 })
    expect(JSON.stringify(r)).not.toContain('nothing')
  })

  it('samples a big file instead of reading it, and still sees the rows', async () => {
    const big = textOf(20_000, cleanLine)
    const r = await preflightSource(openSource(put('big.txt', big)), { config: CONFIG, slices: 3, sliceBytes: 100_000, wholeFileMax: 200_000 })
    expect(r.whole).toBe(false)
    expect(r.sampledBytes).toBeLessThan(big.length)
    expect(r.counters.stored).toBeGreaterThan(1_000)
    expect(r.verdict.level).toBe('pass')
  })

  it('reads an archived name exactly like the file', async () => {
    const dir = mkdtempSync(join(root, 'arc-'))
    const p = put('archived.txt', textOf(2_000, junkLine))
    appendManifest(dir, archiveFile(p, { archiveDir: dir, frameBytes: 4096, searchBytes: 512 }))
    const fromFile = await preflightSource(openSource(p), { config: CONFIG })
    const fromArchive = await preflightSource(openSource('archived.txt', { archiveDir: dir }), { config: CONFIG })
    expect(fromArchive.counters).toEqual(fromFile.counters)
    expect(fromArchive.verdict.level).toBe(fromFile.verdict.level)
  })

  it('applies the production ingest policy: a T3 line is a policy drop, neither a stored row nor an unsplit line', async () => {
    const t3Line = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.com.br:Pw-${i}-Xy!` // a Brazilian address: T3, not on the keep-list
    const r = await preflightSource(openSource(put('t3.txt', textOf(500, t3Line))), { config: CONFIG })
    expect(r.counters).toMatchObject({ lines: 500, stored: 0, tierDropped: 500, noFields: 0, junk: 0 })
    expect(r.verdict.level).toBe('pass')
  })
})
