import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isIngestHeldError } from '@/lib/ingest-quality-gate'
import { MAX_PARSE_WORKERS, WorkerUnavailableError, parseWorkers, stageInWorker, workerAvailable, workerFile, type StageJob } from '@/lib/ingest-pool'

/**
 * The pool is tested against a fake worker, so the protocol, abort, a dead worker and a worker out of memory are proven without ClickHouse. The real worker
 * (lib/ingest-worker.ts) is proven by the `workers` scenario of scripts/e2e-novelty-ingest.ts. The fake picks its behaviour from the job's file name.
 */
const FAKE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const mode = workerData.filename
const done = (extra = {}) => parentPort.postMessage({ type: 'done', result: { imported: 10, skipped: 2, tierDropped: 1, rejection_breakdown: { no_fields: 2 }, ...extra }, gate: null, timings: { parseMs: 5, insertMs: 7 } })
parentPort.on('message', m => { if (m.type === 'abort' && mode !== 'hang') process.exit(0) })
if (mode === 'ok') {
  parentPort.postMessage({ type: 'beat' })
  parentPort.postMessage({ type: 'progress', staged: 10, skipped: 2, bytes: 123 })
  parentPort.postMessage({ type: 'metrics', rows: 10, parseMs: 1, insertMs: 2, tierDropped: 1 })
  done()
} else if (mode === 'gate') {
  parentPort.postMessage({ type: 'done', result: { imported: 1, skipped: 0, tierDropped: 0, rejection_breakdown: {} }, gate: { lines: 5, shapes: new Map([['w://w', 3]]) }, timings: { parseMs: 0, insertMs: 0 } })
} else if (mode === 'held') {
  parentPort.postMessage({ type: 'held', report: { v: 1, phase: 'early', level: 'hold', reasons: ['too many rows break a rule'], lines: 9 } })
} else if (mode === 'error') {
  parentPort.postMessage({ type: 'error', name: 'TypeError', message: 'boom' })
} else if (mode === 'exit3') {
  process.exit(3)
} else if (mode === 'hang' || mode === 'wait') {
  setInterval(() => parentPort.postMessage({ type: 'beat' }), 20)
} else if (mode === 'slow') {
  const start = Date.now()
  setTimeout(() => done({ rejection_breakdown: { start, end: Date.now() } }), 250)
} else if (mode === 'oom') {
  const keep = []
  for (;;) keep.push(new Array(1_000_000).fill(Math.random()))
} else {
  parentPort.postMessage({ type: 'error', name: 'Error', message: 'unknown mode ' + mode })
}
`

let root: string
let fake: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ingest-pool-'))
  fake = join(root, 'fake-worker.cjs')
  writeFileSync(fake, FAKE_WORKER)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const job = (filename: string): StageJob => ({
  path: '/nonexistent/' + filename, filename, table: 'ulp.stage_x', breachName: 'b', filterOn: false, gateOverride: false, batchSize: 1000, pipeline: true,
})
const noop = { onBeat: () => {}, onProgress: () => {}, onMetrics: () => {} }
const opts = (extra: object = {}) => ({ workerFile: fake, slots: 4, ...extra })

describe('parseWorkers', () => {
  it('is off unless INGEST_PARSE_WORKERS is a positive number, and at most 12', () => {
    expect(parseWorkers({})).toBe(0)
    expect(parseWorkers({ INGEST_PARSE_WORKERS: '' })).toBe(0)
    expect(parseWorkers({ INGEST_PARSE_WORKERS: 'many' })).toBe(0)
    expect(parseWorkers({ INGEST_PARSE_WORKERS: '-3' })).toBe(0)
    expect(parseWorkers({ INGEST_PARSE_WORKERS: '4' })).toBe(4)
    expect(parseWorkers({ INGEST_PARSE_WORKERS: '99' })).toBe(MAX_PARSE_WORKERS)
    expect(MAX_PARSE_WORKERS).toBe(12)
  })
})

describe('workerFile and workerAvailable', () => {
  it('default to dist/ingest-worker.cjs under the working directory, or to INGEST_WORKER_FILE', () => {
    expect(workerFile({})).toBe(join(process.cwd(), 'dist', 'ingest-worker.cjs'))
    expect(workerFile({ INGEST_WORKER_FILE: '/x/y.cjs' })).toBe('/x/y.cjs')
  })

  it('tell whether the bundle exists', () => {
    expect(workerAvailable({ INGEST_WORKER_FILE: fake })).toBe(true)
    expect(workerAvailable({ INGEST_WORKER_FILE: join(root, 'missing.cjs') })).toBe(false)
  })
})

describe('stageInWorker', () => {
  it('returns the worker\'s result and timings, and forwards its beats, progress and batch metrics', async () => {
    const seen: unknown[] = []
    const out = await stageInWorker(job('ok'), {
      onBeat: () => seen.push('beat'),
      onProgress: (staged, skipped, bytes) => seen.push(['progress', staged, skipped, bytes]),
      onMetrics: m => seen.push(['metrics', m.rows, m.tierDropped]),
    }, opts())
    expect(out.result).toEqual({ imported: 10, skipped: 2, tierDropped: 1, rejection_breakdown: { no_fields: 2 } })
    expect(out.timings).toEqual({ parseMs: 5, insertMs: 7 })
    expect(out.gate).toBeNull()
    expect(seen).toEqual(['beat', ['progress', 10, 2, 123], ['metrics', 10, 1]])
  })

  it('returns the gate counters with their Map intact', async () => {
    const out = await stageInWorker(job('gate'), noop, opts())
    expect(out.gate?.lines).toBe(5)
    expect(out.gate?.shapes).toBeInstanceOf(Map)
    expect(out.gate?.shapes.get('w://w')).toBe(3)
  })

  it('turns a hold into an IngestHeldError with the worker\'s report', async () => {
    const err = await stageInWorker(job('held'), noop, opts()).catch(e => e)
    expect(isIngestHeldError(err)).toBe(true)
    expect(err.report.reasons).toEqual(['too many rows break a rule'])
  })

  it('rejects with the worker\'s error message and name', async () => {
    const err = await stageInWorker(job('error'), noop, opts()).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('boom')
    expect(err.name).toBe('TypeError')
  })

  it('rejects when the worker dies before it is done, and says how', async () => {
    await expect(stageInWorker(job('exit3'), noop, opts())).rejects.toThrow(/exited with code 3/)
  })

  it('rejects with the abort reason when the signal is aborted, after the worker stopped on its own', async () => {
    const controller = new AbortController()
    const run = stageInWorker(job('wait'), noop, opts({ signal: controller.signal }))
    setTimeout(() => controller.abort(new Error('cancelled by test')), 100)
    await expect(run).rejects.toThrow('cancelled by test')
  })

  it('terminates a worker that ignores the abort message after the grace period', async () => {
    const controller = new AbortController()
    const t0 = Date.now()
    const run = stageInWorker(job('hang'), noop, opts({ signal: controller.signal, terminateGraceMs: 150 }))
    setTimeout(() => controller.abort(new Error('stall')), 50)
    await expect(run).rejects.toThrow('stall')
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('does not start a worker for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('before'))
    await expect(stageInWorker(job('ok'), noop, opts({ signal: controller.signal }))).rejects.toThrow('before')
  })

  it('fails one file when its worker runs out of memory', async () => {
    const err = await stageInWorker(job('oom'), noop, opts({ maxOldGenerationSizeMb: 24 })).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toMatch(/memory/i)
  }, 60_000)

  it('throws WorkerUnavailableError when the bundle is missing, so the importer can fall back', async () => {
    const err = await stageInWorker(job('ok'), noop, { workerFile: join(root, 'missing.cjs'), slots: 1 }).catch(e => e)
    expect(err).toBeInstanceOf(WorkerUnavailableError)
  })

  it('runs at most `slots` workers at a time and lets the others wait their turn', async () => {
    const runs = await Promise.all([1, 2, 3, 4].map(() => stageInWorker(job('slow'), noop, opts({ slots: 2, limiterKey: 'concurrency-test' }))))
    const spans = runs.map(r => r.result.rejection_breakdown as unknown as { start: number; end: number })
    let maxOverlap = 0
    for (const a of spans) maxOverlap = Math.max(maxOverlap, spans.filter(b => b.start < a.end && b.end > a.start).length)
    expect(maxOverlap).toBe(2)
  })
})
