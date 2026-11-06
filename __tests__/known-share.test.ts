import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSource } from '@/lib/source-archive'
import {
  LOW_YIELD_PCT, escapeTsvField, isLowYield, knownShareLine, newSharePct, parseCountsTsv, sampleRows, sampleTsv,
} from '@/lib/known-share'

const lineOf = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const textOf = (n: number) => Array.from({ length: n }, (_, i) => lineOf(i)).join('\n') + '\n'

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'known-share-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p }

describe('escapeTsvField', () => {
  it('escapes the backslash first, then the tab, the newline and the carriage return', () => {
    expect(escapeTsvField('a\\b\tc\nd\re')).toBe('a\\\\b\\tc\\nd\\re')
  })

  it('leaves a plain value alone, and a literal \\N does not become a NULL', () => {
    expect(escapeTsvField('https://x.example.test/p?q=1')).toBe('https://x.example.test/p?q=1')
    expect(escapeTsvField('\\N')).toBe('\\\\N')
  })
})

describe('sampleTsv', () => {
  it('writes one escaped line per row: the file number, the name, then url, e-mail and password', () => {
    const tsv = sampleTsv(3, 'a\tb.txt', [{ url: 'https://h.test/', email: 'u@m.test', password: 'p\nq' }])
    expect(tsv).toBe('3\ta\\tb.txt\thttps://h.test/\tu@m.test\tp\\nq\n')
  })

  it('is empty for no rows', () => {
    expect(sampleTsv(0, 'x.txt', [])).toBe('')
  })
})

describe('sampleRows', () => {
  it('reads a small file whole and drops a repeated row', async () => {
    const text = textOf(40) + lineOf(7) + '\n' + lineOf(8) + '\n'
    const rows = await sampleRows(openSource(put('small.txt', text)), {})
    expect(rows).toHaveLength(40)
    expect(rows[0]).toEqual({ url: 'https://shop0.example.test/login', email: 'user0@mail.test', password: 'Pw-0-Xy!' })
  })

  it('reads only the slices of a big file: fewer rows than the file holds, all of them whole lines', async () => {
    const source = openSource(put('big.txt', textOf(3_000)))
    const rows = await sampleRows(source, { slices: 5, sliceBytes: 6_000, wholeFileMax: 10_000 })
    expect(rows.length).toBeGreaterThan(100)
    expect(rows.length).toBeLessThan(3_000 / 2)
    for (const r of rows) expect(r.password).toMatch(/^Pw-\d+-Xy!$/)
  })

  it('gives no rows for an empty file', async () => {
    expect(await sampleRows(openSource(put('empty.txt', '')), {})).toEqual([])
  })
})

describe('newSharePct and isLowYield', () => {
  it('is the share of the sample that is not known', () => {
    expect(newSharePct({ sampled: 200, known: 50 })).toBe(75)
    expect(newSharePct({ sampled: 200, known: 200 })).toBe(0)
    expect(newSharePct({ sampled: 200, known: 0 })).toBe(100)
  })

  it('has no share for an empty sample', () => {
    expect(newSharePct({ sampled: 0, known: 0 })).toBeNull()
  })

  it('flags under 5% new, and not 5% itself or a missing share', () => {
    expect(LOW_YIELD_PCT).toBe(5)
    expect(isLowYield({ sampled: 1000, known: 960 })).toBe(true)
    expect(isLowYield({ sampled: 1000, known: 950 })).toBe(false)
    expect(isLowYield({ sampled: 0, known: 0 })).toBe(false)
  })
})

describe('knownShareLine', () => {
  it('states the expected new share, the sample size and the known part', () => {
    expect(knownShareLine({ sampled: 63_412, known: 27_267 })).toBe('expected new share ~57% (sample 63412 rows, 43% of them already known)')
  })

  it('adds LOW YIELD under the threshold, and shows a fraction of a percent as such', () => {
    expect(knownShareLine({ sampled: 10_000, known: 9_990 })).toBe('expected new share ~0.1% (sample 10000 rows, 99.9% of them already known)  LOW YIELD')
  })

  it('says so when no row could be sampled', () => {
    expect(knownShareLine({ sampled: 0, known: 0 })).toBe('expected new share unknown (no row could be sampled)')
  })
})

describe('parseCountsTsv', () => {
  it('reads one line per file number: the number, the rows sampled, the rows known', () => {
    const m = parseCountsTsv('0\t1000\t400\n2\t50\t50\n')
    expect(m.get(0)).toEqual({ sampled: 1000, known: 400 })
    expect(m.get(2)).toEqual({ sampled: 50, known: 50 })
    expect(m.size).toBe(2)
  })

  it('ignores blank lines and fails on a line it cannot read', () => {
    expect(parseCountsTsv('\n').size).toBe(0)
    expect(() => parseCountsTsv('x\ty\tz\n')).toThrow(/cannot read/)
  })
})
