/**
 * The known-share preflight (docs/superpowers/specs/2026-11-05-known-share-preflight-design.md, Step A): from a small sample of a file, how much of it is new to the
 * database? The sample goes through the importer's own parser and policy, every distinct sampled row gets the normalised key the importer matches on, and
 * `ulp.credentials` says which keys it already holds. Advisory only: nothing here changes what an import does, and no line of the file is kept in the result.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREFLIGHT_WHOLE_FILE_MAX, preflightHardDrop, sliceRanges, wholeLines } from '@/lib/ingest-preflight'
import { parseULPStream } from '@/lib/ulp-parser'
import { normKeySql } from '@/lib/url-content-key'
import type { Source } from '@/lib/source-archive'

export const KNOWN_SLICES = 5
export const KNOWN_SLICE_BYTES = 1024 * 1024
/** A file whose sample is under this share new is flagged. In the spec's test it caught 21 of the 21 files that really added under 5%. */
export const LOW_YIELD_PCT = 5

export interface SampleRow { url: string; email: string; password: string }
export interface KnownCounts { sampled: number; known: number }

export interface SampleOptions {
  slices?: number
  sliceBytes?: number
  wholeFileMax?: number
  env?: NodeJS.Dict<string>
}

/** One value as ClickHouse's TabSeparated input reads it back: backslash first, so the escapes added after it are not doubled. */
export function escapeTsvField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

/** The rows of one file as TabSeparated lines for the scratch table: file number, file name, url, e-mail, password. */
export function sampleTsv(fileNumber: number, name: string, rows: SampleRow[]): string {
  const head = `${fileNumber}\t${escapeTsvField(name)}\t`
  return rows.map(r => `${head}${escapeTsvField(r.url)}\t${escapeTsvField(r.email)}\t${escapeTsvField(r.password)}\n`).join('')
}

/** The distinct rows of a few slices of a source (the whole file when it is small), as the importer's parser and ingest policy read them. */
export async function sampleRows(source: Source, opts: SampleOptions = {}): Promise<SampleRow[]> {
  const hard = preflightHardDrop(opts.env)
  const wholeFileMax = opts.wholeFileMax ?? PREFLIGHT_WHOLE_FILE_MAX
  const seen = new Set<string>()
  const rows: SampleRow[] = []
  for (const [offset, length] of sliceRanges(source.size, opts.slices ?? KNOWN_SLICES, opts.sliceBytes ?? KNOWN_SLICE_BYTES, wholeFileMax)) {
    const raw = await source.readSlice(offset, length)
    const buf = wholeLines(raw, offset === 0, offset + length >= source.size)
    if (buf.length === 0) continue
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    for await (const batch of parseULPStream(stream, source.name, 100_000, hard, { dedupInFile: false })) {
      for (const c of batch.credentials) {
        const key = `${c.url}\t${c.email}\t${c.password}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ url: c.url, email: c.email, password: c.password })
      }
    }
  }
  return rows
}

/** The share of the sample that is new to the database, in percent; null when nothing could be sampled. */
export function newSharePct(c: KnownCounts): number | null {
  return c.sampled > 0 ? (100 * (c.sampled - c.known)) / c.sampled : null
}

export function isLowYield(c: KnownCounts, thresholdPct = LOW_YIELD_PCT): boolean {
  const share = newSharePct(c)
  return share !== null && share < thresholdPct
}

/** Whole percent in the middle of the range, one decimal at the ends where a whole percent would hide the point. */
function fmtPct(p: number): string {
  return p < 1 || p > 99 ? String(Number(p.toFixed(1))) : p.toFixed(0)
}

export function knownShareLine(c: KnownCounts, thresholdPct = LOW_YIELD_PCT): string {
  const share = newSharePct(c)
  if (share === null) return 'expected new share unknown (no row could be sampled)'
  const flag = isLowYield(c, thresholdPct) ? '  LOW YIELD' : ''
  return `expected new share ~${fmtPct(share)}% (sample ${c.sampled} rows, ${fmtPct(100 - share)}% of them already known)${flag}`
}

/** The answer of the counting query: one line per file number, `<number>\t<rows sampled>\t<rows known>`. */
export function parseCountsTsv(out: string): Map<number, KnownCounts> {
  const counts = new Map<number, KnownCounts>()
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const m = /^(\d+)\t(\d+)\t(\d+)$/.exec(line)
    if (!m) throw new Error(`cannot read the ClickHouse answer: ${line.slice(0, 80)}`)
    counts.set(Number(m[1]), { sampled: Number(m[2]), known: Number(m[3]) })
  }
  return counts
}

export interface KnownShareOptions {
  /** The ClickHouse container the scratch tables are made in (`docker exec`). */
  container: string
  /** Seconds the counting query may run. Default 600. */
  maxSeconds?: number
}

/**
 * Counts, for every sampled file, how many of its distinct sampled rows the database already holds under ANOTHER source. A key held only by the file's own name
 * was new when the file was imported (an import read again); a key the table does not hold at all is new. The answer is keyed by the file's position in `files`.
 *
 * One scan of `norm_key_hash` for all files together. The sample goes into two scratch tables in the container's `default` database (named with a random
 * suffix) that are dropped again whatever happens; nothing is written to `ulp`. Throws when ClickHouse does not answer.
 */
export function knownShareCounts(files: Array<{ name: string; rows: SampleRow[] }>, opts: KnownShareOptions): Map<number, KnownCounts> {
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`
  const samples = `default.zz_known_${suffix}_sample`
  const keys = `default.zz_known_${suffix}_keys`
  const work = mkdtempSync(join(tmpdir(), 'known-share-'))
  const made: string[] = []   // the scratch tables that exist, so a ClickHouse that never answered gets no drop attempts
  const clickhouse = (query: string, inputFile?: string): string => {
    const fd = inputFile ? openSync(inputFile, 'r') : undefined
    try {
      const r = spawnSync(
        'docker', ['exec', '-i', opts.container, 'clickhouse-client', `--max_execution_time=${opts.maxSeconds ?? 600}`, '--max_memory_usage=4000000000', '--query', query],
        { stdio: [fd ?? 'ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 },
      )
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error(`clickhouse-client in ${opts.container} failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
      return r.stdout
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  try {
    const tsv = join(work, 'sample.tsv')
    writeFileSync(tsv, files.map((f, i) => sampleTsv(i, f.name, f.rows)).join(''))
    clickhouse(`CREATE TABLE ${samples} (fid UInt32, file String, url String, email String, password String) ENGINE = Memory`)
    made.push(samples)
    clickhouse(`INSERT INTO ${samples} FORMAT TSV`, tsv)
    clickhouse(`CREATE TABLE ${keys} ENGINE = Memory AS SELECT fid, file, ${normKeySql()} AS k FROM ${samples}`)
    made.push(keys)
    const out = clickhouse(`
      SELECT fid, count() AS sampled, countIf(present AND NOT owned) AS known
      FROM (
        SELECT s.fid AS fid, has(m.srcs, s.file) AS owned, notEmpty(m.srcs) AS present
        FROM ${keys} AS s
        LEFT JOIN (
          SELECT norm_key_hash AS k, groupUniqArray(source_file) AS srcs FROM ulp.credentials WHERE norm_key_hash IN (SELECT k FROM ${keys}) GROUP BY norm_key_hash
        ) AS m ON s.k = m.k
      ) GROUP BY fid ORDER BY fid FORMAT TSV`)
    const counts = parseCountsTsv(out)
    // A file with no sampled row has no line in the answer.
    files.forEach((_, i) => { if (!counts.has(i)) counts.set(i, { sampled: 0, known: 0 }) })
    return counts
  } finally {
    for (const table of made.reverse()) {
      try { clickhouse(`DROP TABLE IF EXISTS ${table}`) } catch (err) { console.warn(`[known-share] could not drop ${table}: ${err instanceof Error ? err.message : String(err)}`) }
    }
    rmSync(work, { recursive: true, force: true })
  }
}
