/**
 * Reads ClickHouse TSV on stdin -- `stored <TAB> expected <TAB> email <TAB> url` -- and compares the stored
 * country_tier, the label the CURRENT column expression gives, and the importer's classifyTier(). See
 * lib/tier-parity.ts. Sample deterministically (never `rand()`: this table's set skip indexes fold it to a
 * constant, so a rand() sample silently returns almost nothing):
 *
 *   EXPR=$(npx tsx -e "import {buildCountryTierExpression as b} from './lib/country-tiers'; process.stdout.write(b())")
 *   docker exec ulpsuite_clickhouse clickhouse-client --query \
 *     "SELECT country_tier, ($EXPR), email, url FROM ulp.credentials WHERE cityHash64(email, url) % 1000 = 13 FORMAT TSV" \
 *     | npx tsx scripts/check-tier-parity.ts
 *
 * Exit 0: all three agree on every row read. Exit 3: they do not (PARITY_MAX_MISMATCHES stops the read early).
 * Prints counts and shapes only, never row content.
 */
import { createInterface } from 'node:readline'
import { TierParity, parseParityLine, formatParityReport } from '@/lib/tier-parity'

async function main(): Promise<number> {
  const cap = Number(process.env.PARITY_MAX_MISMATCHES)
  const parity = new TierParity(Number.isFinite(cap) && cap > 0 ? cap : undefined)
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line === '') continue
    parity.add(parseParityLine(line))
    if (parity.done) break
  }
  lines.close()
  const summary = parity.summary()
  await new Promise<void>((resolve) => process.stdout.write(formatParityReport(summary), () => resolve()))
  const clean = summary.storedVsImporter === 0 && summary.expressionVsImporter === 0 && summary.storedVsExpression === 0
  return clean ? 0 : 3
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(2)
  },
)
