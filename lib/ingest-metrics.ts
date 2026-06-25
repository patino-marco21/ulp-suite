/**
 * Live ingest metrics — single-process, in-memory (same pattern as
 * getCurrentJob in lib/upload-queue.ts). Updated per batch by the import core
 * and read by GET /api/monitoring/ingest-health. Holds the CURRENT import's
 * rolling parser/insert rates so the UI can show the bottleneck live.
 */

const EMA_ALPHA = 0.3          // smoothing for the rolling rates
const RATE_CAP = 1e9           // guard so a ~0 ms batch can't yield Infinity
const PARSE_HIDDEN_MS = 2      // below this, the parse was hidden under the insert

export interface IngestMetrics {
  filename: string | null
  batchSize: number
  parserRowsPerSec: number
  insertRowsPerSec: number
  lastBatchInsertMs: number
  imported: number
  tierDropped: number
  bottleneck: 'parse' | 'insert' | null
  updatedAt: number
}

function idle(): IngestMetrics {
  return {
    filename: null, batchSize: 0, parserRowsPerSec: 0, insertRowsPerSec: 0,
    lastBatchInsertMs: 0, imported: 0, tierDropped: 0, bottleneck: null, updatedAt: 0,
  }
}

let state: IngestMetrics = idle()

function rate(rows: number, ms: number): number {
  return Math.min(RATE_CAP, Math.round((rows / Math.max(ms, 1)) * 1000))
}

export function startIngest(filename: string): void {
  state = { ...idle(), filename, updatedAt: Date.now() }
}

export function recordBatch(m: {
  rows: number; parseMs: number; insertMs: number; tierDropped: number
}): void {
  const pInst = rate(m.rows, m.parseMs)
  const iInst = rate(m.rows, m.insertMs)
  // First batch (rate still 0) seeds the EMA with the instantaneous value.
  const prevP = state.parserRowsPerSec || pInst
  const prevI = state.insertRowsPerSec || iInst
  const parserRowsPerSec = Math.round(EMA_ALPHA * pInst + (1 - EMA_ALPHA) * prevP)
  const insertRowsPerSec = Math.round(EMA_ALPHA * iInst + (1 - EMA_ALPHA) * prevI)
  // The parser only "limits" when its per-batch time is non-trivial; under
  // pipelining parseMs≈0 means parsing was hidden under the insert → insert-bound.
  const parserLimiting = m.parseMs >= PARSE_HIDDEN_MS
  const bottleneck: 'parse' | 'insert' =
    parserLimiting && parserRowsPerSec < insertRowsPerSec ? 'parse' : 'insert'
  state = {
    filename: state.filename,
    batchSize: m.rows,
    parserRowsPerSec,
    insertRowsPerSec,
    lastBatchInsertMs: Math.round(m.insertMs),
    imported: state.imported + m.rows,
    tierDropped: state.tierDropped + m.tierDropped,
    bottleneck,
    updatedAt: Date.now(),
  }
}

export function finishIngest(): void {
  state = { ...state, filename: null, bottleneck: null, updatedAt: Date.now() }
}

export function getIngestMetrics(): IngestMetrics {
  return { ...state }
}
