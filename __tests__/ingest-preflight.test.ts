import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { appendManifest, archiveFile, openSource, type Source } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { SAMPLE_HOLD_MARGIN, preflightSource, sampleHold, sliceRanges, wholeLines } from '@/lib/ingest-preflight'

const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const wordsLine = (i: number) => `just some words number ${i} and nothing else`
// A banner and a divider cannot hold a credential: a file that carries many of them is not badly split.
const bannerLine = '\u{1F4B8} Premium access \u279C $50 \u{1F4B0}'
const dividerLine = '\u2588'.repeat(20)
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

  const noisy =(every: number, other: (i: number) => string) => (i: number) =>
    i % every !== every - 1 ? cleanLine(i) : i % (2 * every) === every - 1 ? bannerLine : other(i)

  it('leaves the lines that cannot hold a credential out of the unsplit share and out of the unsplit shapes', async () => {
    const r = await preflightSource(openSource(put('noise.txt', textOf(2_000, noisy(4, () => dividerLine)))), { config: CONFIG })
    expect(r.counters).toMatchObject({ lines: 2_000, stored: 1_500, noFields: 500, noCredential: 500 })
    expect(r.verdict.level).toBe('pass')
    expect(r.verdict.report).toMatchObject({ unsplitPct: 0, noFields: 500, noCredential: 500 })
    expect(r.unsplitShapes).toEqual([])
  })

  it('still lists, and still counts, the unsplit lines that could have been a credential', async () => {
    const r = await preflightSource(openSource(put('noise-and-words.txt', textOf(2_000, noisy(4, wordsLine)))), { config: CONFIG })
    expect(r.counters).toMatchObject({ lines: 2_000, noFields: 500, noCredential: 250 })
    expect(r.verdict.report.unsplitPct).toBe(12.5)
    expect(r.verdict.level).toBe('hold')
    expect(r.unsplitShapes).toEqual([{ shape: 'w w w w w w w w', count: 250 }])
  })

  it('can skip the second look at the unsplit lines', async () => {
    const r = await preflightSource(openSource(put('words-noview.txt', textOf(2_000, wordsLine))), { config: CONFIG, unsplitShapes: false })
    expect(r.unsplitShapes).toEqual([])
    expect(r.verdict.level).toBe('hold') // the verdict comes from the importer's own counters, not from that view
  })
})

describe('sampleHold: the check that stops a bad big file before the import starts', () => {
  // A "big" file for these tests is one past 200 kB, read in 3 slices of 100 kB.
  const OPTS = { slices: 3, sliceBytes: 100_000, wholeFileMax: 200_000 }
  const mixed = (every: number, bad: (i: number) => string) => (i: number) => (i % every === 0 ? bad(i) : cleanLine(i))

  it('does not look at a file that is small enough to be read whole: the importer sees all of it anyway', async () => {
    expect(await sampleHold(openSource(put('small-junk.txt', textOf(2_000, junkLine))), CONFIG)).toBeNull()
  })

  it('holds a big file whose slices are far past the limits, with the real limits in the reasons and no text', async () => {
    const report = await sampleHold(openSource(put('big-junk.txt', textOf(30_000, junkLine))), CONFIG, OPTS)
    expect(report).toMatchObject({ v: 1, phase: 'sample', level: 'hold', junkPct: 100 })
    expect(report?.reasons).toEqual(['100.00% of the stored rows break a rule (limit 2%)'])
    expect(report?.kinds).toEqual({ 'password-has-scheme': report?.junk })
    expect(report?.lines).toBeLessThan(10_000) // the numbers are the sample's, not the file's
    expect(JSON.stringify(report)).not.toContain('example.test')
  })

  it('lets a big clean file go', async () => {
    expect(await sampleHold(openSource(put('big-clean.txt', textOf(30_000, cleanLine))), CONFIG, OPTS)).toBeNull()
  })

  it('holds only when the sample is past the limit by the margin: a file just over a limit is left to the check at the end', async () => {
    expect(SAMPLE_HOLD_MARGIN).toBe(1.5)
    // 2.5% of the rows break a rule: over the 2% limit, under 2% x 1.5 = 3%
    expect(await sampleHold(openSource(put('big-2-5.txt', textOf(30_000, mixed(40, junkLine)))), CONFIG, OPTS)).toBeNull()
    // 4% is over the margin
    expect(await sampleHold(openSource(put('big-4.txt', textOf(30_000, mixed(25, junkLine)))), CONFIG, OPTS)).toMatchObject({ phase: 'sample', level: 'hold' })
  })

  it('holds a big file most of whose lines cannot be split', async () => {
    const report = await sampleHold(openSource(put('big-words.txt', textOf(30_000, wordsLine))), CONFIG, OPTS)
    expect(report).toMatchObject({ phase: 'sample', level: 'hold', unsplitPct: 100 })
    expect(report?.reasons).toEqual(['100.00% of the lines could not be split into a login and a password (limit 5%)'])
  })

  it('does not hold a big file for its banners, dividers and bare urls', async () => {
    // A bare url that is followed by a line that could be a login would open a three-line record, so each one is followed by a clean line.
    const withNoise = (i: number) => (i % 4 === 0 ? `https://shop${i}.example.test/` : i % 4 === 2 ? bannerLine : cleanLine(i))
    expect(await sampleHold(openSource(put('big-noise.txt', textOf(30_000, withNoise))), CONFIG, OPTS)).toBeNull()
  })

  it('does nothing unless the gate is in hold mode: a warn or off setting never stops a file', async () => {
    const source = openSource(put('big-junk-modes.txt', textOf(30_000, junkLine)))
    expect(await sampleHold(source, { ...CONFIG, mode: 'warn' }, OPTS)).toBeNull()
    expect(await sampleHold(source, { ...CONFIG, mode: 'off' }, OPTS)).toBeNull()
  })

  it('never throws: a source that cannot be read is no reason to hold or to fail a file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken: Source = {
      name: 'broken.txt', size: 50_000_000, origin: { kind: 'file', path: '/nowhere/broken.txt' },
      stream: () => { throw new Error('no stream') },
      readSlice: async () => { throw new Error('no slice') },
      readAll: async () => { throw new Error('no file') },
    }
    expect(await sampleHold(broken, CONFIG)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[quality-gate] sample check of broken.txt failed'))
    warn.mockRestore()
  })
})
