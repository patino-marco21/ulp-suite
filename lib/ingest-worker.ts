/**
 * A parse worker: stages ONE plain file on its own thread (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step C). The importer (lib/ingest-pool.ts) starts it
 * with a StageJob as workerData and hears back through lib/ingest-worker-protocol.ts. It runs the very staging loop the importer runs in-process
 * (lib/ingest-stream.ts), with its own ClickHouse client, so the rows, the counts and the gate's counters are the ones the in-process path produces.
 *
 * Bundled to dist/ingest-worker.cjs by scripts/build-ingest-worker.mjs. It must not reach Next, SQLite or the job store (__tests__/ingest-stream-boundary.test.ts).
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { parentPort, workerData } from 'node:worker_threads'
import { makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'
import { IngestHeldError, evaluateGate, isIngestHeldError, newGateCounters, parseGateConfig } from '@/lib/ingest-quality-gate'
import { streamCredentialsToTable } from '@/lib/ingest-stream'
import type { ParentMessage, StageJob, StageTimings, WorkerMessage } from '@/lib/ingest-worker-protocol'

const port = parentPort
if (!port) throw new Error('lib/ingest-worker.ts must run as a worker thread')
const post = (m: WorkerMessage) => port.postMessage(m)

const job = workerData as StageJob
const controller = new AbortController()
port.on('message', (m: ParentMessage) => {
  if (m.type === 'abort') controller.abort(new DOMException('The operation was aborted', 'AbortError'))
})

async function run(): Promise<void> {
  // The same environment as the importer's, so the same policy and the same gate settings.
  const policy = parseIngestPolicy()
  const shouldHardDrop = makeHardDropPredicate(policy)
  const softPolicy = { ...policy, hardTiers: new Set<string>() }
  const gateConfig = parseGateConfig()
  const gate = gateConfig.mode === 'off' ? undefined : newGateCounters()
  const timings: StageTimings = { parseMs: 0, insertMs: 0 }

  const nodeStream = fs.createReadStream(job.path)
  try {
    const result = await streamCredentialsToTable(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, job.filename, {
      table:          job.table,
      batchSize:      job.batchSize,
      pipeline:       job.pipeline,
      filterOn:       job.filterOn,
      dropPolicy:     softPolicy,
      breachName:     job.breachName,
      shouldHardDrop,
      dedupInFile:    false,
      signal:         controller.signal,
      onBeat:         () => post({ type: 'beat' }),
      onProgress:     (staged, skipped) => post({ type: 'progress', staged, skipped, bytes: nodeStream.bytesRead }),
      onBatchMetrics: m => post({ type: 'metrics', ...m }),
      timings,
      gate,
      // The early check of the importer's own path: a hold ends the job before the batch that crossed the line is written. A released file is reported, not held.
      gateCheckpoint: gate
        ? { atLines: gateConfig.earlyLines, check: () => {
            const verdict = evaluateGate(gate, gateConfig, 'early')
            if (verdict.level === 'hold' && !job.gateOverride) throw new IngestHeldError(verdict.report)
          } }
        : undefined,
    })
    post({ type: 'done', result, gate: gate ?? null, timings })
  } catch (err) {
    if (isIngestHeldError(err)) post({ type: 'held', report: err.report })
    else post({ type: 'error', name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    nodeStream.destroy()
  }
}

run().catch(err => post({ type: 'error', name: 'Error', message: err instanceof Error ? err.message : String(err) }))
