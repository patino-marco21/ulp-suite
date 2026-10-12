/**
 * Independent recount of imported pile files. For each file it re-runs the app's OWN parser + policy offline (no ClickHouse writes,
 * no app involvement), hashes every importable row with the table's own content-key expression inside ClickHouse, and compares
 * with (a) the job record in SQLite and (b) what ulp.credentials / ulp.sources hold now.
 *
 *   npx tsx scripts/pile/verify-file.ts <dir with a COPY of ulp.db(+wal,shm)> <since 'YYYY-MM-DD HH:MM:SS' UTC> <file> [<file> ...]
 *
 * Env: PILE_DIR (default "$HOME/Downloads/AyuGram Desktop"; a file name without a slash is looked up there), CH_CONTAINER (ulpsuite_clickhouse),
 *      PARTITION (202610, the partition the run filled), REIMPORT=1 (the checks for a re-import over rows of an earlier parser),
 *      INGEST_FILTER_HARD_DROP_TIERS / INGEST_FILTER_HARD_KEEP_COUNTRIES (the container's policy: T3 and the 15-country keep-list by default),
 *      VERIFY_BATCH_ROWS (1000000: rows per insert into the scratch table; any file size works, the rows are never held in one string).
 * The file's content hashes are staged in a Memory table `ulp.zz_verify_<pid>` (dropped when the file is done) instead of being passed as one external table, which a
 * file of tens of millions of credentials cannot ("Invalid string length").
 *
 * Invariants checked per file (S = importable rows the parser yields, D = distinct content hashes among them):
 *   skipped      offline rejected lines  == job.skipped
 *   split        D                       == job.new + job.known
 *   complete     hashes present in ulp.credentials == D           (nothing was lost)
 *   own          distinct hashes written under this source_file == job.new   (only new rows were written, attributed to this file)
 *   known        hashes present under OTHER source_files        == job.known (the rest already existed)
 *   rows         rows of this source_file in the table          == job.new   (no duplicates written)
 *   source       ulp.sources.line_count                         == job.new
 */
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { parseULPStream } from '@/lib/ulp-parser'
import { DEFAULT_HARD_KEEP_COUNTRIES, parseIngestPolicy, makeHardDropPredicate } from '@/lib/ingest-filter'

const PILE = process.env.PILE_DIR ?? `${process.env.HOME}/Downloads/AyuGram Desktop`
const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const PARTITION = process.env.PARTITION ?? '202610'
const [dir, since, ...files] = process.argv.slice(2)
if (!dir || !since || files.length === 0) {
  console.error('usage: verify-file.ts <sqlite copy dir> <since UTC> <file> [<file> ...]')
  process.exit(2)
}

// The container's effective policy: INGEST_FILTER_HARD_DROP_TIERS=T3 and the keep-list (compare with `docker exec ulpsuite_app printenv | grep INGEST_FILTER`).
const policy = parseIngestPolicy({
  INGEST_FILTER_HARD_DROP_TIERS: process.env.INGEST_FILTER_HARD_DROP_TIERS ?? 'T3',
  INGEST_FILTER_HARD_KEEP_COUNTRIES: process.env.INGEST_FILTER_HARD_KEEP_COUNTRIES ?? DEFAULT_HARD_KEEP_COUNTRIES,
} as unknown as NodeJS.ProcessEnv)
const shouldHardDrop = makeHardDropPredicate(policy)

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')
const sqlStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const CONTENT_KEY = `cityHash64(replaceRegexpOne(replaceRegexpOne(unhex(u), '^(?i:https?://)', ''), '/$', ''), unhex(e), unhex(p))`
const BATCH_ROWS = Number(process.env.VERIFY_BATCH_ROWS ?? 1_000_000)
const SCRATCH = `ulp.zz_verify_${process.pid}`

function clickhouse(query: string): string {
  const args = ['exec', '-i', CH, 'clickhouse-client', '--max_memory_usage=6000000000', '--max_execution_time=180', '-q', query]
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`clickhouse-client failed: ${r.stderr.slice(0, 400)}`)
  return r.stdout.trim()
}

/** Streams `input` (tab-separated hex triples) into the scratch table: the content hash is computed by ClickHouse's own expression while the rows come in. */
function stageRows(input: string): void {
  const args = ['exec', '-i', CH, 'clickhouse-client', '--max_memory_usage=6000000000', '--max_execution_time=180',
    '-q', `INSERT INTO ${SCRATCH} SELECT ${CONTENT_KEY} FROM input('u String, e String, p String') FORMAT TSV`]
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`staging failed: ${r.stderr.slice(0, 400)}`)
}

const db = new Database(`${dir}/ulp.db`, { readonly: true })
const jobOf = (filename: string) =>
  db.prepare("SELECT status, imported, known, skipped FROM processing_jobs WHERE filename = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1").get(filename, since) as
    | { status: string; imported: number; known: number; skipped: number } | undefined

let failures = 0
const check = (label: string, got: number | string, want: number | string): string => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  return `${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`
}

async function main(): Promise<void> {
  for (const file of files) {
    const filename = basename(file)
    const path = file.startsWith('/') ? file : `${PILE}/${file}`
    const job = jobOf(filename)
    console.log(`\n=== ${filename}`)
    if (!job) { failures++; console.log('FAIL no job row since', since); continue }
    if (job.status !== 'done') { failures++; console.log('FAIL job status is', job.status); continue }

    // 1. offline parse with the same options the staged import uses (dedupInFile off, hard-drop predicate for T3); the hashes of its rows are staged in ClickHouse in batches
    clickhouse(`DROP TABLE IF EXISTS ${SCRATCH}`)
    clickhouse(`CREATE TABLE ${SCRATCH} (h UInt64) ENGINE = Memory`)
    let S: number, D: number, present: number, own: number
    let staged = 0, skipped = 0
    try {
      const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
      let batch: string[] = []
      const flush = () => { if (batch.length) { stageRows(batch.join('\n') + '\n'); batch = [] } }
      const breakdown: Record<string, number> = {}
      for await (const b of parseULPStream(stream, filename, 100_000, shouldHardDrop, { dedupInFile: false })) {
        staged += b.credentials.length
        skipped += b.rejected
        for (const [k, v] of Object.entries(b.breakdown)) breakdown[k] = (breakdown[k] ?? 0) + v
        for (const c of b.credentials) {
          batch.push(`${hex(c.url)}\t${hex(c.email)}\t${hex(c.password)}`)
          if (batch.length >= BATCH_ROWS) flush()
        }
      }
      flush()
      const reasons = Object.entries(breakdown).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ')
      console.log(`offline parse: importable=${staged} rejected=${skipped} (${reasons || 'none'})  job: new=${job.imported} known=${job.known} skipped=${job.skipped}`)

      // 2. probe inside ClickHouse: the big column is scanned once, filtered by the small set (never the other way round)
      const q = `
        SELECT
          (SELECT count() FROM ${SCRATCH}) AS staged_rows,
          (SELECT uniqExact(h) FROM ${SCRATCH}) AS distinct_hashes,
          p.present, p.own
        FROM (
          SELECT uniqExact(content_key_hash) AS present, uniqExactIf(content_key_hash, source_file = ${sqlStr(filename)}) AS own
          FROM ulp.credentials WHERE content_key_hash IN (SELECT h FROM ${SCRATCH})
        ) AS p
        FORMAT TSV`
      ;[S, D, present, own] = clickhouse(q).split('\t').map(Number)
    } finally {
      clickhouse(`DROP TABLE IF EXISTS ${SCRATCH}`)
    }
    const rows = Number(clickhouse(`SELECT count() FROM ulp.credentials WHERE _partition_id = '${PARTITION}' AND source_file = ${sqlStr(filename)}`))
    const src = clickhouse(`SELECT line_count FROM ulp.sources WHERE filename = ${sqlStr(filename)}`)

    const reimport = process.env.REIMPORT === '1'
    console.log(check('importable rows (offline vs ClickHouse hashing)', S, staged))
    console.log(check('skipped   (offline == job)', skipped, job.skipped))
    console.log(check('split     distinct hashes == new + known', D, job.imported + job.known))
    console.log(check('complete  every distinct hash is in the table', present, D))
    if (!reimport) {
      console.log(check('own       hashes written under this file == job.new', own, job.imported))
      console.log(check('known     hashes held under other files == job.known', present - own, job.known))
      console.log(check('rows      rows of this file in the table == job.new (no duplicates written)', rows, job.imported))
      console.log(check('source    ulp.sources.line_count == job.new', src === '' ? 'missing' : Number(src), job.imported))
    } else {
      // a RE-IMPORT: the rows the first import wrote and the new parser still produces stay (and count as "known" for this file)
      console.log(check('own       distinct hashes under this file >= job.new', own >= job.imported ? 'yes' : `no (${own} < ${job.imported})`, 'yes'))
      console.log(check('rows      rows of this file in the table == its distinct hashes (no duplicates)', rows, own))
      const linked = Number(clickhouse(`SELECT count() FROM ulp.credentials WHERE _partition_id = '${PARTITION}' AND source_file = ${sqlStr(filename)} AND (position(password, 't.me/') > 0 OR position(email, 't.me/') > 0)`))
      console.log(check('clean     no stored email or password of this file holds a Telegram link', linked, 0))
      console.log(check('source    ulp.sources.line_count == job.new (the delta)', src === '' ? 'missing' : Number(src), job.imported))
      console.log(`info: rows of this file now ${rows}; the delta the re-import added ${job.imported}`)
    }
    console.log(`info: in-file repeats = ${staged - D}`)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
