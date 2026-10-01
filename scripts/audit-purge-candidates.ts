/**
 * Reads ClickHouse TSV (email <TAB> url) on stdin -- the rows a purge is about to delete -- and
 * checks every one against the importer's own policy (INGEST_FILTER_* env, parsed by
 * lib/ingest-filter.ts). See lib/purge-audit.ts for why the stored tier label is not trusted.
 *
 *   docker exec ulpsuite_clickhouse clickhouse-client --query \
 *     "SELECT email, url FROM ulp.credentials WHERE country_tier = 'T3' FORMAT TSV" \
 *     | INGEST_FILTER_HARD_DROP_TIERS=T3 npx tsx scripts/audit-purge-candidates.ts
 *
 * Exit 0: the importer would have dropped every row. Exit 3: at least one it would have kept
 * (reading stops at the first 1,000). Prints counts only, never row content.
 */
import { createInterface } from 'node:readline'
import { parseIngestPolicy } from '@/lib/ingest-filter'
import { PurgeAudit, formatAuditReport, parseCandidateLine } from '@/lib/purge-audit'

async function main(): Promise<number> {
  const audit = new PurgeAudit(parseIngestPolicy(process.env))
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line === '') continue
    audit.add(parseCandidateLine(line))
    if (audit.done) break
  }
  lines.close()
  const summary = audit.summary()
  await new Promise<void>((resolve) => process.stdout.write(formatAuditReport(summary), () => resolve()))
  return summary.disagree === 0 ? 0 : 3
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(2)
  },
)
