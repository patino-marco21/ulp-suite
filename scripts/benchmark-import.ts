/**
 * Import throughput benchmark.
 *
 * Drives the REAL streamCredentialsToTable core against a throwaway
 * ulp.bench_<ts> table (cloned from ulp.credentials but forced to a plain local
 * MergeTree — never the production Replicated table). Never writes ulp.sources.
 *
 * Run (requires local ClickHouse — `npm run docker:infra`):
 *   npx tsx scripts/benchmark-import.ts --rows 200000
 *   npx tsx scripts/benchmark-import.ts --sweep --rows 200000 --json bench.json
 *   npx tsx scripts/benchmark-import.ts --file ./sample.txt --batch 250000
 */

import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { getClient, executeQuery } from '@/lib/clickhouse'
import { streamCredentialsToTable } from '@/lib/upload-processor'

/** Seeded PRNG (deterministic synthetic data). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TLDS = ['com', 'net', 'org', 'co.uk', 'de', 'ru', 'com.br']
const WORDS = ['shop', 'mail', 'login', 'portal', 'acme', 'globex', 'umbrella', 'initech']

/** One synthetic ULP line exercising the parser's main single-line branches. */
export function makeSyntheticLine(rnd: () => number): string {
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]
  const user = `user${Math.floor(rnd() * 100000)}`
  const dom = `${pick(WORDS)}.${pick(TLDS)}`
  const pass = `Pa55_${Math.floor(rnd() * 1e8).toString(36)}`
  const r = rnd()
  if (r < 0.45) return `https://${dom}/account:${user}:${pass}`       // url:login:pass
  if (r < 0.75) return `${user}@${dom}:${pass}`                       // email:pass
  if (r < 0.9) return `https://${dom}/x\t${user}\t${pass}`            // tab-separated
  return `# ${pick(WORDS)} note ${Math.floor(rnd() * 1000)}`          // junk (dropped)
}

/** Guard: refuse to operate on anything but a ulp.bench_* table. */
export function assertBenchTable(name: string): void {
  if (!/^ulp\.bench_[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to use non-benchmark table: ${name}`)
  }
}

export interface BenchArgs {
  rows: number
  batch: number
  pipeline: boolean
  concurrency: number
  file?: string
  seed: number
  sweep: boolean
  json?: string
}

export function parseArgs(argv: string[]): BenchArgs {
  const val = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (k: string): boolean => argv.includes(`--${k}`)
  return {
    rows: Number(val('rows') ?? 200000),
    batch: Number(val('batch') ?? 100000),
    pipeline: (val('pipeline') ?? 'on') !== 'off',
    concurrency: Number(val('concurrency') ?? 1),
    file: val('file'),
    seed: Number(val('seed') ?? 1),
    sweep: has('sweep'),
    json: val('json'),
  }
}

interface BenchConfig {
  rows: number
  batch: number
  pipeline: boolean
  concurrency: number
  file?: string
  seed: number
}

interface BenchResult extends BenchConfig {
  imported: number
  wallMs: number
  rowsPerSec: number
  peakRssMb: number
  parseMs: number
  insertMs: number
  activeParts: number
  activeMerges: number
}

/** A finite ReadableStream of `rows` synthetic lines. */
function syntheticStream(rows: number, seed: number): ReadableStream<Uint8Array> {
  const rnd = mulberry32(seed)
  let produced = 0
  const node = new Readable({
    read() {
      if (produced >= rows) { this.push(null); return }
      let chunk = ''
      for (let i = 0; i < 2000 && produced < rows; i++, produced++) {
        chunk += makeSyntheticLine(rnd) + '\n'
      }
      this.push(Buffer.from(chunk, 'utf8'))
    },
  })
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>
}

function makeStream(cfg: BenchConfig): ReadableStream<Uint8Array> {
  if (cfg.file) {
    return Readable.toWeb(fs.createReadStream(cfg.file)) as unknown as ReadableStream<Uint8Array>
  }
  return syntheticStream(cfg.rows, cfg.seed)
}

async function snapshot(tableNames: string[]): Promise<{ activeParts: number; activeMerges: number }> {
  const bare = tableNames.map(t => t.split('.')[1])
  const parts = await executeQuery(
    `SELECT count() AS c FROM system.parts WHERE database = 'ulp' AND table IN {t:Array(String)} AND active`,
    { t: bare },
  ) as Array<{ c: number | string }>
  const merges = await executeQuery(
    `SELECT count() AS c FROM system.merges WHERE database = 'ulp' AND table IN {t:Array(String)}`,
    { t: bare },
  ) as Array<{ c: number | string }>
  return { activeParts: Number(parts[0]?.c ?? 0), activeMerges: Number(merges[0]?.c ?? 0) }
}

export async function runBenchmark(cfg: BenchConfig): Promise<BenchResult> {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const tables = Array.from({ length: cfg.concurrency }, (_, i) => `ulp.bench_${stamp}_${i}`)
  tables.forEach(assertBenchTable)

  for (const t of tables) {
    await executeQuery(
      `CREATE TABLE ${t} AS ulp.credentials ` +
      `ENGINE = MergeTree PARTITION BY toYYYYMM(imported_at) ORDER BY (domain, email, imported_at)`,
    )
  }

  let peakRss = 0
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 250)
  const timings = { parseMs: 0, insertMs: 0 }
  const t0 = performance.now()

  try {
    const runs = tables.map(t =>
      streamCredentialsToTable(makeStream(cfg), cfg.file ?? `bench-${cfg.rows}.txt`, {
        table: t,
        batchSize: cfg.batch,
        pipeline: cfg.pipeline,
        timings,
      }),
    )
    const results = await Promise.all(runs)
    const imported = results.reduce((s, r) => s + r.imported, 0)
    const wallMs = performance.now() - t0
    const snap = await snapshot(tables)
    return {
      ...cfg,
      imported,
      wallMs: Math.round(wallMs),
      rowsPerSec: Math.round(imported / (wallMs / 1000)),
      peakRssMb: Math.round(peakRss / 2 ** 20),
      parseMs: Math.round(timings.parseMs),
      insertMs: Math.round(timings.insertMs),
      ...snap,
    }
  } finally {
    clearInterval(sampler)
    for (const t of tables) {
      await executeQuery(`DROP TABLE IF EXISTS ${t}`).catch(() => {})
    }
  }
}

function sweepConfigs(a: BenchArgs): BenchConfig[] {
  const out: BenchConfig[] = []
  for (const batch of [100000, 250000, 500000]) {
    for (const pipeline of [true, false]) {
      out.push({ rows: a.rows, batch, pipeline, concurrency: 1, file: a.file, seed: a.seed })
    }
  }
  return out
}

function printReport(results: BenchResult[]): void {
  console.table(results.map(r => ({
    batch: r.batch,
    pipeline: r.pipeline ? 'on' : 'off',
    conc: r.concurrency,
    imported: r.imported,
    'rows/s': r.rowsPerSec,
    'wall(ms)': r.wallMs,
    'peakRSS(MB)': r.peakRssMb,
    'parse(ms)': r.parseMs,
    'insert(ms)': r.insertMs,
    parts: r.activeParts,
    merges: r.activeMerges,
  })))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configs: BenchConfig[] = args.sweep
    ? sweepConfigs(args)
    : [{ rows: args.rows, batch: args.batch, pipeline: args.pipeline, concurrency: args.concurrency, file: args.file, seed: args.seed }]

  const results: BenchResult[] = []
  for (const cfg of configs) {
    console.log(`▶ batch=${cfg.batch} pipeline=${cfg.pipeline ? 'on' : 'off'} concurrency=${cfg.concurrency} rows=${cfg.rows}${cfg.file ? ` file=${cfg.file}` : ''}`)
    results.push(await runBenchmark(cfg))
  }

  printReport(results)
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(results, null, 2))
    console.log(`Wrote ${args.json}`)
  }
  await getClient().close()
}

// Run main() only when executed directly (`npx tsx scripts/benchmark-import.ts`),
// not when imported by the test suite.
if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1) })
}
