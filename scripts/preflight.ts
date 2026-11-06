/**
 * Preflight of the ingest quality gate: what would the importer do with these files? (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md)
 *
 *   tsx scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] [--known] <file | archived name>...
 *
 * Reads 5 slices of 2 MiB per file (the whole file when it is at most 8 MiB) through the importer's own parser and counters, and prints one line per file: lines,
 * share stored, share of rows that break a rule, share of unsplit lines, share of garbage, and the verdict (PASS / WARN / HOLD), then the reasons, the kinds and the
 * masked shapes for a file that is not a PASS. It never prints a line of a file. The gate's thresholds come from INGEST_QUALITY_GATE_* like the app's.
 *
 * An archived name is read from the archive (ULP_ARCHIVE_DIR, default ~/ulp-archive). Exit 0 when no file would be held, 1 when one would, 2 on a usage or read error.
 * --quiet prints at most one line per file and never the file's name (the feeder logs the name itself); --json prints one JSON object per file.
 *
 * --known adds, after each verdict, how much of the file is expected to be new to the database (docs/superpowers/specs/2026-11-05-known-share-preflight-design.md):
 * 5 slices of 1 MiB go through the importer's parser, and one scan of ulp.credentials (CH_CONTAINER, default ulpsuite_clickhouse; scratch tables, dropped again)
 * says how many of the sampled rows it already holds. A file under 5% new is marked LOW YIELD. Advisory: it changes no exit code except 2 when ClickHouse does not
 * answer, and with --quiet it prints only the files that are marked (joined to the verdict line of a file that is not a PASS).
 */
import { setPriority } from 'node:os'
import { openSource } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { PREFLIGHT_SLICES, PREFLIGHT_SLICE_BYTES, preflightSource } from '@/lib/ingest-preflight'
import { isLowYield, knownShareCounts, knownShareLine, newSharePct, sampleRows, type KnownCounts } from '@/lib/known-share'

const argv = process.argv.slice(2)
const has = (name: string) => argv.includes(`--${name}`)
const valueOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const valueFlags = new Set(['--slices', '--slice-mb'])
const targets = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''))

if (targets.length === 0) {
  console.error('usage: tsx scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] [--known] <file | archived name>...')
  process.exit(2)
}

try { setPriority(19) } catch { /* best effort: a background job */ }

const slices = Number(valueOf('slices') ?? PREFLIGHT_SLICES)
const sliceBytes = Math.round(Number(valueOf('slice-mb') ?? PREFLIGHT_SLICE_BYTES / 1048576) * 1048576)
if (!Number.isFinite(slices) || slices < 1 || !Number.isFinite(sliceBytes) || sliceBytes < 1024) {
  console.error('--slices must be at least 1 and --slice-mb a positive number')
  process.exit(2)
}

const pct = (x: number) => `${x.toFixed(2)}%`.padStart(7)

/** The expected new share of each target that can be read, by its position in `targets`. A ClickHouse that does not answer is reported once and leaves the map empty. */
async function expectedShares(): Promise<{ shares: Map<number, KnownCounts>; failed: boolean }> {
  const shares = new Map<number, KnownCounts>()
  const sampled: Array<{ index: number; name: string; rows: Awaited<ReturnType<typeof sampleRows>> }> = []
  for (const [index, target] of targets.entries()) {
    try {
      const source = openSource(target)
      sampled.push({ index, name: source.name, rows: await sampleRows(source) })
    } catch { /* the verdict loop reports a file that cannot be read */ }
  }
  if (sampled.length === 0) return { shares, failed: false }
  try {
    const counts = knownShareCounts(sampled, { container: process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse' })
    sampled.forEach((s, i) => shares.set(s.index, counts.get(i) ?? { sampled: 0, known: 0 }))
    return { shares, failed: false }
  } catch (err) {
    console.error(`cannot compute the expected new share: ${err instanceof Error ? err.message : String(err)}`)
    return { shares, failed: true }
  }
}

async function main(): Promise<number> {
  const config = parseGateConfig()
  let anyHold = false
  let failed = false
  const known = has('known') ? await expectedShares() : { shares: new Map<number, KnownCounts>(), failed: false }
  if (known.failed) failed = true
  for (const [index, target] of targets.entries()) {
    let result
    try {
      result = await preflightSource(openSource(target), { slices, sliceBytes, config })
    } catch (err) {
      console.error(`cannot read ${has('quiet') ? 'the file' : target}: ${err instanceof Error ? err.message : String(err)}`)
      failed = true
      continue
    }
    const { verdict, counters } = result
    const level = verdict.level.toUpperCase()
    if (verdict.level === 'hold') anyHold = true
    const r = verdict.report

    const share = known.shares.get(index)
    if (has('json')) {
      const knownJson = share ? { ...share, newSharePct: newSharePct(share), lowYield: isLowYield(share) } : undefined
      console.log(JSON.stringify({ name: result.name, size: result.size, sampledBytes: result.sampledBytes, whole: result.whole, level: verdict.level, reasons: verdict.reasons, report: r, unsplitShapes: result.unsplitShapes, known: knownJson }))
      continue
    }
    if (has('quiet')) {
      const parts = []
      if (verdict.level !== 'pass') parts.push(`${level} ${verdict.reasons.join('; ')}`)
      if (share && isLowYield(share)) parts.push(knownShareLine(share))
      if (parts.length > 0) console.log(parts.join(' | '))
      continue
    }

    const storedPct = counters.lines > 0 ? (counters.stored / counters.lines) * 100 : 0
    console.log(
      `${String(index + 1).padStart(3)}  ${String(counters.lines).padStart(10)} lines  stored${pct(storedPct)}  junk${pct(r.junkPct)}  unsplit${pct(r.unsplitPct)}  garbage${pct(r.garbagePct)}  ${level.padEnd(4)}  ${result.name}${result.whole ? '' : '  (sampled)'}`,
    )
    if (verdict.level !== 'pass') {
      for (const reason of verdict.reasons) console.log(`       ${reason}`)
      const kinds = Object.entries(r.kinds)
      if (kinds.length > 0) console.log(`       kinds: ${kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`)
      for (const s of r.shapes.slice(0, 5)) console.log(`       row shape x${s.count}: ${s.shape}`)
      for (const s of result.unsplitShapes.slice(0, 5)) console.log(`       unsplit line shape x${s.count}: ${s.shape}`)
    }
    if (share) console.log(`       ${knownShareLine(share)}`)
  }
  return failed ? 2 : anyHold ? 1 : 0
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(2) })
