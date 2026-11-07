/**
 * Sets the parser revision of the ulp.sources rows that DDL v31 found at 0, by the time each row was written (lib/parser-version.ts, PARSER_REVISION_TIMELINE).
 *
 *   tsx scripts/ledger-backfill.ts status
 *   tsx scripts/ledger-backfill.ts revisions [--apply]
 *
 * `status` prints how many rows carry each revision. `revisions` prints what it would set and changes nothing; --apply runs the one mutation (a table of about a thousand rows,
 * a few seconds) and prints the result. A second run touches nothing: only rows still at 0 are set. Environment: CH_CONTAINER (ulpsuite_clickhouse).
 */
import { spawnSync } from 'node:child_process'
import { revisionBackfillSql, revisionExpression } from '@/lib/parser-version'

const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const argv = process.argv.slice(2)

function clickhouse(sql: string): string {
  const r = spawnSync('docker', ['exec', CH, 'clickhouse-client', '-q', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) { console.error(`clickhouse-client failed: ${(r.stderr ?? '').slice(0, 400)}`); process.exit(1) }
  return r.stdout
}

const table = (title: string, tsv: string) => console.log(`${title}\n${tsv.trim() === '' ? '  (no rows)' : tsv.trim().split('\n').map(l => `  ${l.replace('\t', '   rows: ')}`).join('\n')}`)

const cmd = argv[0]
if (cmd === 'status') {
  table('rows by parser revision (0 = not recorded):', clickhouse('SELECT parser_revision, count() FROM ulp.sources GROUP BY parser_revision ORDER BY parser_revision'))
} else if (cmd === 'revisions') {
  table('rows at revision 0 and the revision the timeline gives them:', clickhouse(`SELECT ${revisionExpression()} AS rev, count() FROM ulp.sources WHERE parser_revision = 0 GROUP BY rev ORDER BY rev`))
  if (argv.includes('--apply')) {
    clickhouse(revisionBackfillSql())
    table('applied. rows by parser revision now:', clickhouse('SELECT parser_revision, count() FROM ulp.sources GROUP BY parser_revision ORDER BY parser_revision'))
  } else {
    console.log('dry run: nothing changed (--apply sets them)')
  }
} else {
  console.error('usage: tsx scripts/ledger-backfill.ts status | revisions [--apply]')
  process.exit(2)
}
