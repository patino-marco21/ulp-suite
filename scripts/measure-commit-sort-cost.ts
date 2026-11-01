/**
 * The cost gate of docs/superpowers/specs/2026-11-01-near-duplicates-design.md ("Which twin is kept"): the commit statement on the normalised key sorts the
 * new rows by (url, email). On an all-new slab of the size an import really uses on that key (NORM_KEY_MAX_SLAB_ROWS, 10,000,000 rows) it may take at most
 * 1.25 times the time and 1.10 times the peak memory of the statement it replaces. The first run of this gate, at 20,000,000 rows, passed on time (0.91) and
 * failed on memory (10.6 GiB against 8.0 GiB; a server capped at 9 GiB killed it), which is why a slab on this key is capped: at 10,000,000 rows the peak is 7.1 GiB.
 *
 * Runs on the ISOLATED rehearsal stack only (docker-compose.rehearsal.yml). It writes 4 x ROWS rows into that stack's ulp.credentials (one slab per timed run;
 * the known table stays empty, so every row is new each time, the worst case for the sort; about 8 GiB at 20,000,000), so take the stack down afterwards.
 * A stage of ROWS all-new rows, then four timed runs in the order old, new, new, old, so that a drift in the machine's speed over the run cancels out of the
 * two means. The peak memory of each run is the server's own figure (system.query_log); the larger of the two runs of a statement is compared.
 *
 * The rehearsal ClickHouse is capped at 4 GiB (3.6 GiB usable), which today's statement alone exceeds at 20,000,000 rows (production has a 14 GiB ceiling and
 * today's statement peaks at 8 GiB there). For COST_ROWS above about 8,000,000 raise the throwaway container first, and restart it so that ClickHouse reads
 * the new limit:
 *   docker update --memory 10g --memory-swap 10g ulprehearsal_clickhouse && docker restart ulprehearsal_clickhouse
 *
 *   REHEARSAL_APP_IMAGE=<tag> npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/measure-commit-sort-cost.ts                                 # about 4 minutes at 10,000,000 rows
 *
 * Env: COST_ROWS (10000000), COST_LIMIT (1.25, time), COST_MEMORY_LIMIT (1.10, peak memory). Exit 0 when both ratios are within their limits, 1 when not.
 */
import { execFileSync } from 'node:child_process'
import { commitInsertSql } from '../lib/ingest-novelty'
import { NORM_KEY_MAX_SLAB_ROWS } from '../lib/ingest-novelty-config'
import { knownDdl, stageDdl, stageTables } from '../lib/ingest-stage'

const CH = 'ulprehearsal_clickhouse'
if (!CH.startsWith('ulprehearsal_')) throw new Error('refusing to run: this script only drives the isolated rehearsal stack')

const ROWS = Math.floor(Number(process.env.COST_ROWS ?? NORM_KEY_MAX_SLAB_ROWS))
const LIMIT = Number(process.env.COST_LIMIT ?? 1.25)
const MEMORY_LIMIT = Number(process.env.COST_MEMORY_LIMIT ?? 1.1)
const t = stageTables('c05700000000')
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`

function ch(sql: string, queryId?: string): string {
  return execFileSync(
    'docker',
    [
      'exec', CH, 'clickhouse-client', '--async_insert=0', '--insert_deduplicate=0', '--max_execution_time=3300', '--max_insert_threads=4',
      '--max_bytes_before_external_sort=1073741824', ...(queryId ? [`--query_id=${queryId}`] : []), '--query', sql,
    ],
    { encoding: 'utf8', maxBuffer: 64 << 20 },
  ).trim()
}

interface Run { seconds: number; id: string }
let counter = 0

function timed(label: string, sql: string): Run {
  const id = `cost-gate-${process.pid}-${++counter}`
  const started = Date.now()
  ch(sql, id)
  const seconds = (Date.now() - started) / 1000
  console.log(`  ${label}: ${seconds.toFixed(1)} s`)
  return { seconds, id }
}

/** The server's own peak memory of each run, from system.query_log (flushed first: the log is written every few seconds). */
function peaks(runs: Run[]): number[] {
  ch('SYSTEM FLUSH LOGS')
  const ids = runs.map(r => `'${r.id}'`).join(', ')
  const rows = ch(`SELECT query_id, memory_usage FROM system.query_log WHERE type = 'QueryFinish' AND query_id IN (${ids}) FORMAT TSV`)
  const byId = new Map(rows.split('\n').filter(Boolean).map(l => l.split('\t') as [string, string]).map(([id, mem]) => [id, Number(mem)] as const))
  return runs.map(r => {
    const mem = byId.get(r.id)
    if (mem === undefined || !Number.isFinite(mem)) throw new Error(`no memory figure for ${r.id} in system.query_log`)
    return mem
  })
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
    const [oldMem1, newMem1, newMem2, oldMem2] = peaks([old1, new1, new2, old2])

    const oldMean = (old1.seconds + old2.seconds) / 2
    const newMean = (new1.seconds + new2.seconds) / 2
    const ratio = newMean / oldMean
    const oldPeak = Math.max(oldMem1, oldMem2)
    const newPeak = Math.max(newMem1, newMem2)
    const memoryRatio = newPeak / oldPeak
    console.log(`  time:   mean old ${oldMean.toFixed(1)} s, mean new ${newMean.toFixed(1)} s, ratio ${ratio.toFixed(2)} (limit ${LIMIT})`)
    console.log(`  memory: peak old ${gib(oldPeak)}, peak new ${gib(newPeak)}, ratio ${memoryRatio.toFixed(2)} (limit ${MEMORY_LIMIT})`)
    return ratio <= LIMIT && memoryRatio <= MEMORY_LIMIT ? 0 : 1
  } finally {
    ch(`DROP TABLE IF EXISTS ${t.stage} SYNC`)
    ch(`DROP TABLE IF EXISTS ${t.known} SYNC`)
  }
}

process.exit(main())
