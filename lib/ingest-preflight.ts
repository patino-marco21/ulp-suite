/**
 * The offline preflight of the ingest quality gate (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, "The offline preflight").
 *
 * Reads a few slices of a source (a file, or an archived name), runs them through the SAME parser and the SAME counters as the importer, and says what the gate
 * would do with the whole file. Nothing is written anywhere. No line of the file is kept: the result holds counts and masked shapes. The two worst parser defects
 * of the pile import were visible in a two-minute sample, which is what this reads.
 */
import { parseInlineLine, parseULPStream } from '@/lib/ulp-parser'
import { DEFAULT_HARD_KEEP_COUNTRIES, makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'
import { repairUtf8Line } from '@/lib/ulp-utf8'
import {
  SHAPE_CAP, evaluateGate, maskText, newGateCounters, recordGateBatch, type GateConfig, type GateCounters, type GateVerdict,
} from '@/lib/ingest-quality-gate'
import type { Source } from '@/lib/source-archive'

export const PREFLIGHT_SLICES = 5
export const PREFLIGHT_SLICE_BYTES = 2 * 1024 * 1024
export const PREFLIGHT_WHOLE_FILE_MAX = 8 * 1024 * 1024
const TOP_UNSPLIT_SHAPES = 20

export interface PreflightOptions {
  slices?: number
  sliceBytes?: number
  wholeFileMax?: number
  config: GateConfig
  env?: NodeJS.ProcessEnv
}

export interface PreflightResult {
  name: string
  size: number
  sampledBytes: number
  /** True when the whole file was read (it is at most `wholeFileMax` bytes). */
  whole: boolean
  counters: GateCounters
  verdict: GateVerdict
  /** The most frequent masked shapes of the lines no field split could read (a single-line view; see preflightSource). */
  unsplitShapes: Array<{ shape: string; count: number }>
}

/** The ingest policy as the production app runs it: T3 dropped, with the keep-list of countries. `undefined` when INGEST_FILTER_HARD_DROP_TIERS is set empty (nothing is hard-dropped). */
export function preflightHardDrop(env: NodeJS.ProcessEnv = process.env): ((email: string, url: string) => boolean) | undefined {
  const policy = parseIngestPolicy({
    INGEST_FILTER_HARD_DROP_TIERS: env.INGEST_FILTER_HARD_DROP_TIERS ?? 'T3',
    INGEST_FILTER_HARD_KEEP_COUNTRIES: env.INGEST_FILTER_HARD_KEEP_COUNTRIES ?? DEFAULT_HARD_KEEP_COUNTRIES,
  } as unknown as NodeJS.ProcessEnv)
  return makeHardDropPredicate(policy)
}

/** The byte ranges to read: the whole file when it is small, else `slices` (at least 2) evenly spaced ones, the first at the start and the last ending at the end. */
export function sliceRanges(size: number, slices: number, sliceBytes: number, wholeFileMax: number): Array<[number, number]> {
  if (size === 0) return []
  if (size <= wholeFileMax) return [[0, size]]
  const n = Math.max(2, slices)
  return Array.from({ length: n }, (_, i) => {
    const offset = Math.floor((i * (size - sliceBytes)) / (n - 1))
    return [offset, Math.min(sliceBytes, size - offset)] as [number, number]
  })
}

/** The part of a slice that holds whole lines: the partial line at the start is dropped (unless the slice starts the file), and so is the one at the end (unless it ends the file). */
export function wholeLines(buf: Buffer, startsFile: boolean, endsFile: boolean): Buffer {
  let from = 0
  let to = buf.length
  if (!startsFile) {
    const nl = buf.indexOf(10)
    if (nl === -1) return Buffer.alloc(0)
    from = nl + 1
  }
  if (!endsFile) {
    const nl = buf.lastIndexOf(10)
    if (nl < from) return Buffer.alloc(0)
    to = nl + 1
  }
  return buf.subarray(from, to)
}

export async function preflightSource(source: Source, opts: PreflightOptions): Promise<PreflightResult> {
  const hard = preflightHardDrop(opts.env)
  const counters = newGateCounters()
  const unsplit = new Map<string, number>()
  const wholeFileMax = opts.wholeFileMax ?? PREFLIGHT_WHOLE_FILE_MAX
  let sampled = 0

  for (const [offset, length] of sliceRanges(source.size, opts.slices ?? PREFLIGHT_SLICES, opts.sliceBytes ?? PREFLIGHT_SLICE_BYTES, wholeFileMax)) {
    const raw = await source.readSlice(offset, length)
    const buf = wholeLines(raw, offset === 0, offset + length >= source.size)
    if (buf.length === 0) continue
    sampled += buf.length

    // The importer's own parser and counters.
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    for await (const batch of parseULPStream(stream, source.name, 100_000, hard, { dedupInFile: false })) recordGateBatch(counters, batch)

    // parseULPStream hands out counts, not the lines it rejected, and it must not change. So the lines no field split could read are looked at again, one by one,
    // the way the design probe did: this view is exact for single-line records and an upper bound for labelled or positional blocks.
    for (const line of buf.toString('latin1').split('\n')) {
      if (line.trim() === '') continue
      const r = parseInlineLine(repairUtf8Line(line), source.name, hard)
      if (r.credential || r.reason !== 'no_fields') continue
      const shape = maskText(line.trim(), 70)
      const key = unsplit.has(shape) || unsplit.size < SHAPE_CAP ? shape : '(other shapes)'
      unsplit.set(key, (unsplit.get(key) ?? 0) + 1)
    }
  }

  const unsplitShapes = [...unsplit.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_UNSPLIT_SHAPES)
    .map(([shape, count]) => ({ shape, count }))
  return {
    name: source.name, size: source.size, sampledBytes: sampled, whole: source.size <= wholeFileMax,
    counters, verdict: evaluateGate(counters, opts.config, 'final'), unsplitShapes,
  }
}
