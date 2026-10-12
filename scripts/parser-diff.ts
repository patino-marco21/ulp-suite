/**
 * Differential of a baseline parser (a git ref) and the working tree over slices of real files: every line whose result changed must belong to a named
 * class (lib/parser-diff.ts); exit code 1 when any does not. Counts are extrapolated by file size; examples are MASKED (never a raw line).
 * Run it from the repository root.
 *
 *   npx tsx scripts/parser-diff.ts --baseline-ref 624b845 --dir "$HOME/Downloads/AyuGram Desktop" --every 17
 *   npx tsx scripts/parser-diff.ts --baseline-ref 624b845 --files "/abs/a.txt" "/abs/b.txt" --stream
 *
 * --slices K (default 4) x --slice-mb M (default 2) per file, whole file when it is at most 8 MiB. --stream also compares whole files (at most
 * --stream-max-mb, default 150) through parseULPStream and reports the rows only the baseline produces (expected: only double-encoded text).
 */
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { CHANGE_CLASSES, classifyChange, classifyOldOnlyRow, type ChangeClass, type Outcome } from '@/lib/parser-diff'
import { DEFAULT_HARD_KEEP_COUNTRIES, makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'
import { parseInlineLine, parseULPStream } from '@/lib/ulp-parser'
import { repairUtf8Line } from '@/lib/ulp-utf8'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1] }
const ref = flag('baseline-ref')
if (!ref) { console.error('usage: parser-diff.ts --baseline-ref <git ref> (--dir <dir> --every N | --files <abs path>...) [--slices K] [--slice-mb M] [--stream]'); process.exit(2) }
const repo = process.cwd()

async function main(): Promise<void> {
  // The baseline parser: the file at <ref>, imported from a git-ignored directory so that its `@/lib/...` imports resolve like the real one's.
  mkdirSync(join(repo, '.parser-baseline'), { recursive: true })
  const baselinePath = join(repo, '.parser-baseline', 'ulp-parser-baseline.ts')
  writeFileSync(baselinePath, execFileSync('git', ['show', `${ref}:lib/ulp-parser.ts`], { cwd: repo, maxBuffer: 64 << 20 }))
  const baseline = await import(pathToFileURL(baselinePath).href) as {
    parseLine: (line: string, file: string, hard?: (e: string, u: string) => boolean) => Outcome
    parseULPStream: typeof parseULPStream
  }

  const baselineHard = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' }))
  const newHard = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3', INGEST_FILTER_HARD_KEEP_COUNTRIES: DEFAULT_HARD_KEEP_COUNTRIES }))

  let files: string[]
  if (flag('dir')) {
    const dir = flag('dir') as string
    const every = Number(flag('every') ?? '1')
    files = readdirSync(dir).filter(n => n.toLowerCase().endsWith('.txt')).sort().filter((_, i) => i % every === 0).map(n => join(dir, n))
  } else {
    files = args.slice(args.indexOf('--files') + 1).filter(a => !a.startsWith('--'))
  }

  const SLICE = Number(flag('slice-mb') ?? '2') * 1048576
  const K = Number(flag('slices') ?? '4')
  const mask = (s: string) => s.replace(/[A-Za-z0-9]+/g, w => (w.length <= 3 || /^(https?|www|t|me|com|android)$/i.test(w) ? w : w.slice(0, 2) + '*'.repeat(Math.min(w.length - 2, 6)))).slice(0, 110)
  const toOutcome = (r: { credential: { url: string; email: string; password: string } | null; reason: string | null }): Outcome => ({ credential: r.credential && { url: r.credential.url, email: r.credential.email, password: r.credential.password }, reason: r.reason })

  const counts = new Map<ChangeClass, number>()
  const raw = new Map<ChangeClass, number>()
  const examples = new Map<ChangeClass, string[]>()
  let totalLines = 0

  function* sampleLines(path: string, size: number): Generator<{ line: string; weight: number }> {
    const whole = size <= 8 * 1048576
    const offsets = whole ? [0] : Array.from({ length: K }, (_, i) => Math.floor(i * (size - SLICE) / Math.max(1, K - 1)))
    const weight = whole ? 1 : size / (K * SLICE)
    if (whole) { for (const line of readFileSync(path).toString('latin1').split('\n')) yield { line, weight }; return }
    const fd = openSync(path, 'r')
    try {
      for (const off of offsets) {
        const len = Math.min(SLICE, size - off)
        const buf = Buffer.allocUnsafe(len); readSync(fd, buf, 0, len, off)
        let text = buf.toString('latin1')
        if (off > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1) }
        if (off + len < size) { const nl = text.lastIndexOf('\n'); text = nl === -1 ? '' : text.slice(0, nl) }
        for (const line of text.split('\n')) yield { line, weight }
      }
    } finally { closeSync(fd) }
  }

  for (const path of files) {
    for (const { line, weight } of sampleLines(path, statSync(path).size)) {
      if (!line.trim()) continue
      totalLines += weight
      const o = toOutcome(baseline.parseLine(line, 'f.txt', baselineHard))
      const repaired = repairUtf8Line(line)
      const n = toOutcome(parseInlineLine(repaired, 'f.txt', newHard))
      const oR = repaired === line ? o : toOutcome(baseline.parseLine(repaired, 'f.txt', baselineHard))
      const cls = classifyChange(line, o, n, oR)
      if (cls === 'same') continue
      counts.set(cls, (counts.get(cls) ?? 0) + weight)
      raw.set(cls, (raw.get(cls) ?? 0) + 1)
      const ex = examples.get(cls) ?? []
      if (ex.length < (cls === 'unexplained' ? 25 : 4)) { ex.push(`${mask(line.trim())}   =>  ${n.credential ? `${mask(n.credential.email)} | ${mask(n.credential.password)}` : o.credential ? 'LOST' : 'rejected'}`); examples.set(cls, ex) }
    }
  }

  console.log(`baseline ${ref} vs working tree, ${files.length} files, ~${(totalLines / 1e6).toFixed(1)}M lines (extrapolated)`)
  for (const cls of CHANGE_CLASSES) {
    const w = counts.get(cls) ?? 0
    if (w === 0 && cls !== 'unexplained') continue
    console.log(`  ${cls.padEnd(22)} ${(w / 1e6).toFixed(3).padStart(9)}M   (${raw.get(cls) ?? 0} sampled lines)`)
    for (const e of examples.get(cls) ?? []) console.log(`      ${e}`)
  }

  let streamUnexplained = 0
  if (args.includes('--stream')) {
    const maxMb = Number(flag('stream-max-mb') ?? '150')
    for (const path of files.filter(f => statSync(f).size <= maxMb * 1048576)) {
      const rows = async (gen: AsyncGenerator<{ credentials: Array<{ url: string; email: string; password: string }> }>) => {
        const m = new Map<string, number>()
        for await (const b of gen) for (const c of b.credentials) { const k = `${c.url}\u0000${c.email}\u0000${c.password}`; m.set(k, (m.get(k) ?? 0) + 1) }
        return m
      }
      const bytes = readFileSync(path)
      const body = () => Readable.toWeb(Readable.from(bytes)) as unknown as ReadableStream<Uint8Array>
      const oldRows = await rows(baseline.parseULPStream(body(), 'f.txt', 100000, baselineHard, { dedupInFile: false }))
      const newRows = await rows(parseULPStream(body(), 'f.txt', 100000, newHard, { dedupInFile: false }))
      let onlyOld = 0, onlyNew = 0
      const oldOnly = new Map<string, number>()
      const exUnexplained: string[] = []
      for (const [k, v] of oldRows) {
        const d = v - (newRows.get(k) ?? 0)
        if (d <= 0) continue
        onlyOld += d
        const [url, email, password] = k.split('\u0000')
        const cls = classifyOldOnlyRow({ url, email, password })
        oldOnly.set(cls, (oldOnly.get(cls) ?? 0) + d)
        if (cls === 'unexplained' && exUnexplained.length < 6) exUnexplained.push(`${mask(url).slice(0, 40)} | ${mask(email)} | ${mask(password)}`)
      }
      for (const [k, v] of newRows) { const d = v - (oldRows.get(k) ?? 0); if (d > 0) onlyNew += d }
      streamUnexplained += oldOnly.get('unexplained') ?? 0
      console.log(`  stream ${mask(path.split('/').pop() ?? '')}: old ${[...oldRows.values()].reduce((a, b) => a + b, 0)} rows, new ${[...newRows.values()].reduce((a, b) => a + b, 0)}; only in old ${onlyOld} (${[...oldOnly].map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}); only in new ${onlyNew}`)
      for (const e of exUnexplained) console.log(`      UNEXPLAINED old-only row: ${e}`)
    }
  }

  const unexplained = raw.get('unexplained') ?? 0
  console.log(unexplained === 0 && streamUnexplained === 0 ? 'OK: every changed line belongs to a class' : `FAIL: ${unexplained} changed lines and ${streamUnexplained} stream rows have no class`)
  process.exit(unexplained === 0 && streamUnexplained === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
