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
