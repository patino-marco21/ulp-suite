/**
 * Preflight of the ingest quality gate: what would the importer do with these files? (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md)
 *
 *   tsx scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] <file | archived name>...
 *
 * Reads 5 slices of 2 MiB per file (the whole file when it is at most 8 MiB) through the importer's own parser and counters, and prints one line per file: lines,
 * share stored, share of rows that break a rule, share of unsplit lines, share of garbage, and the verdict (PASS / WARN / HOLD), then the reasons, the kinds and the
 * masked shapes for a file that is not a PASS. It never prints a line of a file. The gate's thresholds come from INGEST_QUALITY_GATE_* like the app's.
 *
 * An archived name is read from the archive (ULP_ARCHIVE_DIR, default ~/ulp-archive). Exit 0 when no file would be held, 1 when one would, 2 on a usage or read error.
 * --quiet prints at most one line per file and never the file's name (the feeder logs the name itself); --json prints one JSON object per file.
 */
import { setPriority } from 'node:os'
import { openSource } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { PREFLIGHT_SLICES, PREFLIGHT_SLICE_BYTES, preflightSource } from '@/lib/ingest-preflight'

const argv = process.argv.slice(2)
const has = (name: string) => argv.includes(`--${name}`)
const valueOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const valueFlags = new Set(['--slices', '--slice-mb'])
const targets = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''))

if (targets.length === 0) {
  console.error('usage: tsx scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] <file | archived name>...')
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

async function main(): Promise<number> {
  const config = parseGateConfig()
  let anyHold = false
  let failed = false
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

    if (has('json')) {
      console.log(JSON.stringify({ name: result.name, size: result.size, sampledBytes: result.sampledBytes, whole: result.whole, level: verdict.level, reasons: verdict.reasons, report: r, unsplitShapes: result.unsplitShapes }))
      continue
    }
    if (has('quiet')) {
      if (verdict.level !== 'pass') console.log(`${level} ${verdict.reasons.join('; ')}`)
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
  }
  return failed ? 2 : anyHold ? 1 : 0
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(2) })
