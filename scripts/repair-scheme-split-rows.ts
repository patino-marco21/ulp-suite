/**
 * Reads ClickHouse TSV on stdin -- `url, email, password, source_file, breach_name, imported_at` of the scheme-split
 * legacy rows (lib/legacy-repair.ts) -- re-parses each with the current parser and the importer's hard-drop policy
 * (INGEST_FILTER_* env, parsed by lib/ingest-filter.ts), and writes the repaired rows as JSONEachRow to --out.
 *
 *   docker exec ulpsuite_clickhouse clickhouse-client --query \
 *     "SELECT url, email, password, source_file, breach_name, imported_at FROM ulp.credentials WHERE <predicate> FORMAT TSV" \
 *     | INGEST_FILTER_HARD_DROP_TIERS=T3 npx tsx scripts/repair-scheme-split-rows.ts --out /tmp/repaired.jsonl
 *
 * --count-only: report only, write no rows. The report (stdout) is counts only, never a row. Exit 0 ok, 2 on a
 * malformed line or an unwritable --out. scripts/repair-scheme-split-rows.sh is the supervised wrapper.
 */
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { makeHardDropPredicate, parseIngestPolicy, shouldDropAtIngest } from '@/lib/ingest-filter'
import { RepairStats, parseStoredRowLine, repairSchemeSplit } from '@/lib/legacy-repair'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main(): Promise<number> {
  const countOnly = process.argv.includes('--count-only')
  const outPath = argValue('--out')
  if (!countOnly && !outPath) {
    console.error('give --out <file> to write the repaired rows, or --count-only')
    return 2
  }

  const policy = parseIngestPolicy(process.env)
  const shouldHardDrop = makeHardDropPredicate(policy)
  const shouldDrop = (c: { email: string; url: string; domain: string }) => shouldDropAtIngest(c.email, c.url, c.domain, policy)
  const stats = new RepairStats()
  const out = countOnly ? null : createWriteStream(outPath!)

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line === '') continue
    const row = parseStoredRowLine(line)
    const outcome = repairSchemeSplit(row, { shouldHardDrop, shouldDrop })
    stats.add(outcome)
    if (out && outcome.kind === 'repaired') {
      const c = outcome.credential
      const json = JSON.stringify({
        url: c.url, email: c.email, password: c.password, domain: c.domain,
        source_file: c.source_file, breach_name: row.breach_name, imported_at: row.imported_at,
      })
      if (!out.write(json + '\n')) await once(out, 'drain')
    }
  }
  lines.close()
  if (out) {
    out.end()
    await once(out, 'finish')
  }

  const s = stats.summary()
  const rejected = Object.values(s.rejected).reduce((a, b) => a + b, 0)
  const reasons = Object.entries(s.rejected).sort((a, b) => b[1] - a[1])
  const report = [
    `candidates:  ${s.candidates.toLocaleString('en-US')}`,
    `repaired:    ${s.repaired.toLocaleString('en-US')}`,
    ...(reasons.length ? ['left as they are:', ...reasons.map(([why, n]) => `  ${why.padEnd(18)}${n.toLocaleString('en-US')}`)] : []),
    `repair-result: candidates=${s.candidates} repaired=${s.repaired} rejected=${rejected}`,
  ].join('\n') + '\n'
  await new Promise<void>((resolve) => process.stdout.write(report, () => resolve()))
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(2)
  },
)
