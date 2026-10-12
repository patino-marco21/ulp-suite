/**
 * Differential of a baseline parser (a git ref) and the working tree over slices of real files: every line whose result changed must belong to a named
 * class (lib/parser-diff.ts); exit code 1 when any does not. Counts are extrapolated by file size; examples are MASKED (never a raw line).
 * Run it from the repository root.
 *
 *   npx tsx scripts/parser-diff.ts --baseline-ref 624b845 --dir "$HOME/Downloads/AyuGram Desktop" --every 17
 *   npx tsx scripts/parser-diff.ts --baseline-ref 624b845 --files "/abs/a.txt" "/abs/b.txt" --stream
 *   npx tsx scripts/parser-diff.ts --baseline-ref HEAD --same-policy ...      (parser rules only: both sides use the T3 keep-list)
 *   npx tsx scripts/parser-diff.ts --baseline-ref 624b845 --from-archive --every 17   (the names come from the source archive manifest, ULP_ARCHIVE_DIR; no originals needed)
 *
 * --whole reads EVERY line of every file (exact counts, no extrapolation); --lines-with '|;' then examines only the lines that hold one of those characters, which
 * is exact for a rule that needs one of them (the pile-wide proof of the pipe and semicolon rules of parser v6.1 ran this way: --baseline-ref HEAD --same-policy --whole
 * --lines-with '|;'). Without --whole: --slices K (default 4) x --slice-mb M (default 2) per file, whole file when it is at most 8 MiB. --stream also compares whole files (at most
 * --stream-max-mb, default 150) through parseULPStream and reports the rows only the baseline produces (expected: only double-encoded text).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { CHANGE_CLASSES, classifyChange, classifyOldOnlyRow, inertSemicolons, restoreSemicolons, type ChangeClass, type Outcome } from '@/lib/parser-diff'
import { DEFAULT_HARD_KEEP_COUNTRIES, makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'
import { parseInlineLine, parseULPStream } from '@/lib/ulp-parser'
import { pipeJoinAll } from '@/lib/ulp-recover'
import { repairUtf8Line } from '@/lib/ulp-utf8'
import { defaultArchiveDir, latestByName, openSource, readManifest, type Source } from '@/lib/source-archive'

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
    parseInlineLine?: (line: string, file: string, hard?: (e: string, u: string) => boolean) => Outcome   // parser v6 and later
    parseULPStream: typeof parseULPStream
  }
  // A baseline from v6 on reads a line like the new parser does (UTF-8 repair, Android app ids), so only the rules that differ show up; an older one is read as before.
  const baselineParse = (line: string, hard: (e: string, u: string) => boolean): Outcome => (baseline.parseInlineLine ?? baseline.parseLine)(line, 'f.txt', hard)

  const newHard = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3', INGEST_FILTER_HARD_KEEP_COUNTRIES: DEFAULT_HARD_KEEP_COUNTRIES }))
  // --same-policy compares two parsers under the SAME T3 policy (the keep-list), so that only parser rules differ; without it the baseline keeps the old policy (no keep-list)
  const baselineHard = args.includes('--same-policy') ? newHard : makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' }))

  let files: string[]
  if (flag('dir')) {
    const dir = flag('dir') as string
    const every = Number(flag('every') ?? '1')
    files = readdirSync(dir).filter(n => n.toLowerCase().endsWith('.txt')).sort().filter((_, i) => i % every === 0).map(n => join(dir, n))
  } else if (args.includes('--from-archive')) {
    const every = Number(flag('every') ?? '1')
    files = [...latestByName(readManifest(defaultArchiveDir())).keys()].filter(n => n.toLowerCase().endsWith('.txt')).sort().filter((_, i) => i % every === 0)
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

  const everyLine = args.includes('--whole')
  const linesWith = flag('lines-with')
  async function* sampleLines(source: Source): AsyncGenerator<{ line: string; weight: number }> {
    const size = source.size
    if (everyLine) {
      const rl = createInterface({ input: source.stream().setEncoding('latin1'), crlfDelay: Infinity })
      for await (const line of rl) yield { line, weight: 1 }
      return
    }
    const whole = size <= 8 * 1048576
    const offsets = whole ? [0] : Array.from({ length: K }, (_, i) => Math.floor(i * (size - SLICE) / Math.max(1, K - 1)))
    const weight = whole ? 1 : size / (K * SLICE)
    if (whole) { for (const line of (await source.readAll()).toString('latin1').split('\n')) yield { line, weight }; return }
    for (const off of offsets) {
      const len = Math.min(SLICE, size - off)
      let text = (await source.readSlice(off, len)).toString('latin1')
      if (off > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1) }
      if (off + len < size) { const nl = text.lastIndexOf('\n'); text = nl === -1 ? '' : text.slice(0, nl) }
      for (const line of text.split('\n')) yield { line, weight }
    }
  }

  for (const path of files) {
    for await (const { line, weight } of sampleLines(openSource(path))) {
      if (!line.trim()) continue
      if (linesWith && ![...linesWith].some(c => line.includes(c))) continue
      totalLines += weight
      const repaired = repairUtf8Line(line)
      const o = toOutcome(baselineParse(baseline.parseInlineLine ? repaired : line, baselineHard))
      const n = toOutcome(parseInlineLine(repaired, 'f.txt', newHard))
      const oR = repaired === line || baseline.parseInlineLine ? o : toOutcome(baselineParse(repaired, baselineHard))
      const join = pipeJoinAll(repaired.trim())
      const oJ = join ? toOutcome(baselineParse(join.line, baselineHard)) : undefined
      const inert = inertSemicolons(repaired.trim())
      const oS = inert ? restoreSemicolons(toOutcome(baselineParse(inert.line, baselineHard))) : undefined
      const cls = classifyChange(line, o, n, oR, oJ, oS)
      if (cls === 'same') continue
      counts.set(cls, (counts.get(cls) ?? 0) + weight)
      raw.set(cls, (raw.get(cls) ?? 0) + 1)
      const ex = examples.get(cls) ?? []
      if (ex.length < (cls === 'unexplained' ? 25 : 4)) { ex.push(`${mask(line.trim())}   =>  ${n.credential ? `${mask(n.credential.email)} | ${mask(n.credential.password)}` : o.credential ? 'LOST' : 'rejected'}`); examples.set(cls, ex) }
    }
  }

  console.log(`baseline ${ref} vs working tree, ${files.length} files, ${everyLine ? '' : '~'}${(totalLines / 1e6).toFixed(1)}M lines ${everyLine ? `(exact${linesWith ? `, only lines with one of ${JSON.stringify(linesWith)}` : ''})` : '(extrapolated)'}`)
  for (const cls of CHANGE_CLASSES) {
    const w = counts.get(cls) ?? 0
    if (w === 0 && cls !== 'unexplained') continue
    console.log(`  ${cls.padEnd(22)} ${(w / 1e6).toFixed(3).padStart(9)}M   (${raw.get(cls) ?? 0} sampled lines)`)
    for (const e of examples.get(cls) ?? []) console.log(`      ${e}`)
  }

  let streamUnexplained = 0
  if (args.includes('--stream')) {
    const maxMb = Number(flag('stream-max-mb') ?? '150')
    for (const path of files.filter(f => openSource(f).size <= maxMb * 1048576)) {
      const rows = async (gen: AsyncGenerator<{ credentials: Array<{ url: string; email: string; password: string }> }>) => {
        const m = new Map<string, number>()
        for await (const b of gen) for (const c of b.credentials) { const k = `${c.url}\u0000${c.email}\u0000${c.password}`; m.set(k, (m.get(k) ?? 0) + 1) }
        return m
      }
      const bytes = await openSource(path).readAll()
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
