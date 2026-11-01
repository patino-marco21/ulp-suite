/**
 * The cost gate of docs/superpowers/specs/2026-11-01-near-duplicates-design.md ("Which twin is kept"): the commit statement on the normalised key sorts the
 * new rows by (url, email); on a 20,000,000-row, all-new slab it may take at most 1.25 times the statement it replaces.
 *
 * Runs on the ISOLATED rehearsal stack only (docker-compose.rehearsal.yml). It writes 4 x ROWS rows into that stack's ulp.credentials (one slab per timed
 * run, the known table stays empty so every row is new each time; about 8 GiB at 20,000,000), so take the stack down afterwards. A stage of ROWS all-new rows (the known table is empty: every row is new, the worst case for the sort), then four timed runs in the order
 * old, new, new, old, so that a drift in the machine's speed over the run cancels out of the two means.
 *
 *   REHEARSAL_APP_IMAGE=<tag> npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/measure-commit-sort-cost.ts                                 # about 10 minutes at 20,000,000 rows
 *
 * Env: COST_ROWS (20000000), COST_LIMIT (1.25). Exit 0 when the ratio is within the limit, 1 when it is not.
 */
import { execFileSync } from 'node:child_process'
import { commitInsertSql } from '../lib/ingest-novelty'
import { knownDdl, stageDdl, stageTables } from '../lib/ingest-stage'

const CH = 'ulprehearsal_clickhouse'
if (!CH.startsWith('ulprehearsal_')) throw new Error('refusing to run: this script only drives the isolated rehearsal stack')

const ROWS = Math.floor(Number(process.env.COST_ROWS ?? 20_000_000))
const LIMIT = Number(process.env.COST_LIMIT ?? 1.25)
const t = stageTables('c05700000000')

function ch(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CH, 'clickhouse-client', '--async_insert=0', '--insert_deduplicate=0', '--max_execution_time=3300', '--max_insert_threads=4', '--max_bytes_before_external_sort=1073741824', '--query', sql],
    { encoding: 'utf8', maxBuffer: 64 << 20 },
  ).trim()
}

function timed(label: string, sql: string): number {
  const started = Date.now()
  ch(sql)
  const seconds = (Date.now() - started) / 1000
  console.log(`  ${label}: ${seconds.toFixed(1)} s`)
  return seconds
}

function main(): number {
  if (!Number.isFinite(ROWS) || ROWS < 1) throw new Error(`bad COST_ROWS: ${process.env.COST_ROWS}`)
  console.log(`commit statement cost, ${ROWS.toLocaleString('en-US')} all-new rows, on the rehearsal stack`)
  ch(`DROP TABLE IF EXISTS ${t.stage} SYNC`)
  ch(`DROP TABLE IF EXISTS ${t.known} SYNC`)
  ch(stageDdl(t))
  ch(knownDdl(t))
  try {
    ch(`INSERT INTO ${t.stage} (url, email, password, domain, source_file, breach_name)
        SELECT concat('https://shop', toString(number % 5000), '.example-store.test/login'), concat('user', toString(number), '@probe-mail.test'),
               concat('Pw-', toString(number), '-Xy!'), concat('shop', toString(number % 5000), '.example-store.test'), 'cost.txt', ''
        FROM numbers(${ROWS})`)
    const staged = Number(ch(`SELECT count() FROM ${t.stage}`))
    if (staged !== ROWS) throw new Error(`the stage holds ${staged} rows, expected ${ROWS}`)

    const oldSql = commitInsertSql(t, 'ulp.credentials', 1, 0, 'content_key_hash')
    const newSql = commitInsertSql(t, 'ulp.credentials', 1, 0, 'norm_key_hash')
    const old1 = timed('old statement (exact key, no sort), run 1', oldSql)
    const new1 = timed('new statement (normalised key, sorted by url, email), run 1', newSql)
    const new2 = timed('new statement, run 2', newSql)
    const old2 = timed('old statement, run 2', oldSql)
    const oldMean = (old1 + old2) / 2
    const newMean = (new1 + new2) / 2
    const ratio = newMean / oldMean
    console.log(`  mean old ${oldMean.toFixed(1)} s, mean new ${newMean.toFixed(1)} s, ratio ${ratio.toFixed(2)} (limit ${LIMIT})`)
    return ratio <= LIMIT ? 0 : 1
  } finally {
    ch(`DROP TABLE IF EXISTS ${t.stage} SYNC`)
    ch(`DROP TABLE IF EXISTS ${t.known} SYNC`)
  }
}

process.exit(main())
