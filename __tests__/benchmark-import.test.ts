import { describe, it, expect } from 'vitest'
import { mulberry32, makeSyntheticLine, assertBenchTable, parseArgs } from '../scripts/benchmark-import'
import { parseLine } from '@/lib/ulp-parser'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42), b = mulberry32(42)
    for (let i = 0; i < 10; i++) expect(a()).toBe(b())
  })
  it('differs across seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })
})

describe('makeSyntheticLine', () => {
  it('is deterministic for a given seed', () => {
    expect(makeSyntheticLine(mulberry32(7))).toBe(makeSyntheticLine(mulberry32(7)))
  })
  it('produces mostly parseable credential lines', () => {
    const rnd = mulberry32(123)
    let credentials = 0
    const total = 500
    for (let i = 0; i < total; i++) {
      const { credential } = parseLine(makeSyntheticLine(rnd), 'bench.txt')
      if (credential) credentials++
    }
    expect(credentials / total).toBeGreaterThan(0.5)
  })
})

describe('assertBenchTable', () => {
  it('accepts ulp.bench_* names', () => {
    expect(() => assertBenchTable('ulp.bench_1719_123')).not.toThrow()
  })
  it('rejects any non-benchmark table', () => {
    expect(() => assertBenchTable('ulp.credentials')).toThrow()
    expect(() => assertBenchTable('ulp.sources')).toThrow()
    expect(() => assertBenchTable('bench_1')).toThrow()
  })
})

describe('parseArgs', () => {
  it('applies defaults', () => {
    const a = parseArgs([])
    expect(a.rows).toBe(200000)
    expect(a.batch).toBe(100000)
    expect(a.pipeline).toBe(true)
    expect(a.concurrency).toBe(1)
    expect(a.sweep).toBe(false)
  })
  it('parses overrides', () => {
    const a = parseArgs(['--rows', '50000', '--batch', '250000', '--pipeline', 'off', '--concurrency', '2', '--sweep'])
    expect(a.rows).toBe(50000)
    expect(a.batch).toBe(250000)
    expect(a.pipeline).toBe(false)
    expect(a.concurrency).toBe(2)
    expect(a.sweep).toBe(true)
  })
})
