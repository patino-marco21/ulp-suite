import { describe, it, expect } from 'vitest'
import { startIngest, recordBatch, finishIngest, getIngestMetrics } from '@/lib/ingest-metrics'

describe('ingest-metrics', () => {
  it('startIngest sets filename and zeroes counters', () => {
    startIngest('a.txt')
    const m = getIngestMetrics()
    expect(m.filename).toBe('a.txt')
    expect(m.imported).toBe(0)
    expect(m.tierDropped).toBe(0)
    expect(m.bottleneck).toBeNull()
  })

  it('recordBatch computes rates, accumulates, and flags insert-bound', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 50, insertMs: 200, tierDropped: 10 })
    const m = getIngestMetrics()
    expect(m.insertRowsPerSec).toBe(500_000)   // 100k / 200ms * 1000
    expect(m.parserRowsPerSec).toBe(2_000_000) // 100k / 50ms  * 1000
    expect(m.bottleneck).toBe('insert')         // insert rate is lower
    expect(m.imported).toBe(100_000)
    expect(m.tierDropped).toBe(10)
    expect(m.batchSize).toBe(100_000)
    expect(m.lastBatchInsertMs).toBe(200)
  })

  it('treats ~0 parseMs as parser-hidden (insert-bound), never Infinity', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 0, insertMs: 200, tierDropped: 0 })
    const m = getIngestMetrics()
    expect(Number.isFinite(m.parserRowsPerSec)).toBe(true)
    expect(m.bottleneck).toBe('insert')
  })

  it('flags parse-bound when the parser is genuinely slower', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 500, insertMs: 50, tierDropped: 0 })
    expect(getIngestMetrics().bottleneck).toBe('parse')
  })

  it('finishIngest returns to idle', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 50, insertMs: 200, tierDropped: 0 })
    finishIngest()
    const m = getIngestMetrics()
    expect(m.filename).toBeNull()
    expect(m.bottleneck).toBeNull()
  })
})
