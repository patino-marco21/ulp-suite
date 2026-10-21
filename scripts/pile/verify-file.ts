/**
 * Independent recount of imported pile files. For each file it re-runs the app's OWN parser + policy offline (no ClickHouse writes,
 * no app involvement), hashes every importable row with the table's own content-key expression inside ClickHouse, and compares
 * with (a) the job record in SQLite and (b) what ulp.credentials / ulp.sources hold now.
 *
 *   npx tsx scripts/pile/verify-file.ts [--jobs N] <dir with a COPY of ulp.db(+wal,shm)> <since 'YYYY-MM-DD HH:MM:SS' UTC> <file> [<file> ...]
 *
 * Env: PILE_DIR (default "$HOME/Downloads/AyuGram Desktop"; a file name without a slash is looked up there), CH_CONTAINER (ulpsuite_clickhouse),
 *      PARTITION (202610, the partition the run filled), REIMPORT=1 (the checks for a re-import over rows of an earlier parser),
 *      INGEST_FILTER_HARD_DROP_TIERS / INGEST_FILTER_HARD_KEEP_COUNTRIES (the container's policy: T3 and the 15-country keep-list by default),
 *      VERIFY_BATCH_ROWS (1000000: rows per insert into the scratch table; any file size works, the rows are never held in one string),
 *      VERIFY_BUCKET_HASHES (16000000: the table is probed in buckets of the content hash, each holding at most this many of the file's rows, so the sets of one
 *      probe stay far under the memory cap; a file of 74 million rows takes 5 passes over the table instead of one probe that needs more than the cap),
 *      VERIFY_MAX_MEMORY (6000000000: bytes one ClickHouse query may use), VERIFY_MAX_SECONDS (300: how long one query may run),
 *      VERIFY_JOBS or --jobs N (1: files recounted at the same time, each in its own process with its own scratch table; the parse is one core per file and
 *      most of the time of a big file, so 4 files at once take about as long as the slowest one. Each file is printed as one block when it is done).
 * The file's content hashes are staged in a Memory table `ulp.zz_verify_<pid>` (dropped when the file is done) instead of being passed as one external table, which a
 * file of tens of millions of credentials cannot ("Invalid string length").
 *
 * Invariants checked per file (S = importable rows the parser yields, D = distinct content hashes among them):
 *   skipped      offline rejected lines  == job.skipped
 *   repeats      S - D                   == job.repeats          (only when the job recorded them: jobs since processing_jobs.repeats)
 *   split        D                       == job.new + job.known
 *   complete     hashes present in ulp.credentials == D           (nothing was lost)
 *   own          distinct hashes written under this source_file == job.new   (only new rows were written, attributed to this file)
 *   known        hashes present under OTHER source_files        == job.known (the rest already existed)
 *   rows         rows of this source_file in the table          == job.new   (no duplicates written)
 *   source       ulp.sources.line_count                         == job.new
 * A job the same-name check skipped (processing_jobs.note = 'already-imported') imported nothing, so it is reported and not recounted.
 */
import { fork, spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { parseULPStream } from '@/lib/ulp-parser'
import { DEFAULT_HARD_KEEP_COUNTRIES, parseIngestPolicy, makeHardDropPredicate } from '@/lib/ingest-filter'
import { openSource } from '@/lib/source-archive'

const PILE = process.env.PILE_DIR ?? `${process.env.HOME}/Downloads/AyuGram Desktop`
const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const PARTITION = process.env.PARTITION ?? '202610'
const positional: string[] = []
let jobsFlag: number | undefined
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--jobs') jobsFlag = Number(process.argv[++i])
  else positional.push(process.argv[i])
}
const [dir, since, ...files] = positional
if (!dir || !since || files.length === 0) {
  console.error('usage: verify-file.ts [--jobs N] <sqlite copy dir> <since UTC> <file> [<file> ...]')
  process.exit(2)
}
const JOBS = Math.max(1, Math.floor(jobsFlag ?? Number(process.env.VERIFY_JOBS ?? 1)) || 1)

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
const BUCKET_HASHES = Math.max(1, Number(process.env.VERIFY_BUCKET_HASHES ?? 16_000_000))
const MAX_MEMORY = process.env.VERIFY_MAX_MEMORY ?? '6000000000'
const MAX_SECONDS = process.env.VERIFY_MAX_SECONDS ?? '300'
const SCRATCH = `ulp.zz_verify_${process.pid}`

function clickhouse(query: string): string {
  const args = ['exec', '-i', CH, 'clickhouse-client', `--max_memory_usage=${MAX_MEMORY}`, `--max_execution_time=${MAX_SECONDS}`, '-q', query]
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`clickhouse-client failed: ${r.stderr.slice(0, 400)}`)
  return r.stdout.trim()
}

/** Streams `input` (tab-separated hex triples) into the scratch table: the content hash is computed by ClickHouse's own expression while the rows come in. */
function stageRows(input: string): void {
  const args = ['exec', '-i', CH, 'clickhouse-client', `--max_memory_usage=${MAX_MEMORY}`, `--max_execution_time=${MAX_SECONDS}`,
    '-q', `INSERT INTO ${SCRATCH} SELECT ${CONTENT_KEY} FROM input('u String, e String, p String') FORMAT TSV`]
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`staging failed: ${r.stderr.slice(0, 400)}`)
}

const db = new Database(`${dir}/ulp.db`, { readonly: true })
// repeats and note exist on a database from the release that recorded them; a copy from before has neither, and those checks are then left out.
const jobColumns = new Set((db.prepare('PRAGMA table_info(processing_jobs)').all() as Array<{ name: string }>).map(c => c.name))
const optional = ['repeats', 'note'].filter(c => jobColumns.has(c)).map(c => `, ${c}`).join('')
interface JobRow { status: string; imported: number; known: number; skipped: number; repeats?: number | null; note?: string | null }
const jobOf = (filename: string) =>
  db.prepare(`SELECT status, imported, known, skipped${optional} FROM processing_jobs WHERE filename = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(filename, since) as JobRow | undefined

interface Probe { staged: number; distinct: number; present: number; own: number }

/** One pass over the table for the bucket k of `buckets` (all of the file's hashes when there is one bucket). */
function probeBucket(filename: string, buckets: number, k: number): Probe {
  const only = buckets > 1 ? ` WHERE h % ${buckets} = ${k}` : ''
  const q = `
    SELECT
      (SELECT count() FROM ${SCRATCH}${only}) AS staged_rows,
      (SELECT uniqExact(h) FROM ${SCRATCH}${only}) AS distinct_hashes,
      p.present, p.own
    FROM (
      SELECT uniqExact(content_key_hash) AS present, uniqExactIf(content_key_hash, source_file = ${sqlStr(filename)}) AS own
      FROM ulp.credentials WHERE content_key_hash IN (SELECT h FROM ${SCRATCH}${only})
    ) AS p
    FORMAT TSV`
  const [staged, distinct, present, own] = clickhouse(q).split('\t').map(Number)
  if ([staged, distinct, present, own].some(n => !Number.isFinite(n))) throw new Error(`the probe of bucket ${k} of ${buckets} answered something else than four numbers`)
  return { staged, distinct, present, own }
}

let failures = 0
const check = (label: string, got: number | string, want: number | string): string => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  return `${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`
}

/** Several files at once: one child process per file (its own parser, its own scratch table), each printed as one block when it is done. */
async function runParallel(): Promise<void> {
  let next = 0
  let failed = 0
  let broken = 0
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]
      const { code, out } = await new Promise<{ code: number | null; out: string }>(resolve => {
        const child = fork(process.argv[1], [dir, since, file], { execArgv: process.execArgv, env: { ...process.env, VERIFY_JOBS: '1' }, silent: true })
        let out = ''
        child.stdout?.on('data', d => { out += d })
        child.stderr?.on('data', d => { out += d })
        child.on('exit', c => resolve({ code: c, out }))
      })
      process.stdout.write(out)
      if (code === 1) failed++
      else if (code !== 0) broken++
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker))
  if (failed === 0 && broken === 0) console.log(`\nALL CHECKS PASSED (${files.length} files)`)
  else console.log(`\n${failed + broken} OF ${files.length} FILES ${broken > 0 ? 'FAILED OR COULD NOT BE CHECKED' : 'FAILED'}`)
  process.exit(broken > 0 ? 2 : failed > 0 ? 1 : 0)
}

async function main(): Promise<void> {
  if (JOBS > 1 && files.length > 1) return runParallel()
  for (const file of files) {
    const filename = basename(file)
    const path = file.startsWith('/') ? file : `${PILE}/${file}`
    const job = jobOf(filename)
    console.log(`\n=== ${filename}`)
    if (!job) { failures++; console.log('FAIL no job row since', since); continue }
    if (job.status !== 'done') { failures++; console.log('FAIL job status is', job.status); continue }
    if (job.note === 'already-imported') { console.log('info: the same-name check skipped this file (nothing was imported); nothing to recount'); continue }

    // 1. offline parse with the same options the staged import uses (dedupInFile off, hard-drop predicate for T3); the hashes of its rows are staged in ClickHouse in batches
    clickhouse(`DROP TABLE IF EXISTS ${SCRATCH}`)
    clickhouse(`CREATE TABLE ${SCRATCH} (h UInt64) ENGINE = Memory`)
    let S: number, D: number, present: number, own: number
    let staged = 0, skipped = 0
    try {
      const stream = Readable.toWeb(openSource(path).stream()) as unknown as ReadableStream<Uint8Array>
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

      // 2. probe inside ClickHouse: the big column is scanned once per bucket, filtered by the small set (never the other way round). A bucket is the part of the
      // staged hashes with h % B = k, so each pass holds a 1/B share of the sets (the IN set and the two distinct counts) and the shares add up exactly.
      const buckets = Math.max(1, Math.ceil(staged / BUCKET_HASHES))
      ;[S, D, present, own] = [0, 0, 0, 0]
      for (let k = 0; k < buckets; k++) {
        const probe = probeBucket(filename, buckets, k)
        S += probe.staged; D += probe.distinct; present += probe.present; own += probe.own
      }
    } finally {
      clickhouse(`DROP TABLE IF EXISTS ${SCRATCH}`)
    }
    const rows = Number(clickhouse(`SELECT count() FROM ulp.credentials WHERE _partition_id = '${PARTITION}' AND source_file = ${sqlStr(filename)}`))
    const src = clickhouse(`SELECT line_count FROM ulp.sources WHERE filename = ${sqlStr(filename)}`)

    const reimport = process.env.REIMPORT === '1'
    console.log(check('importable rows (offline vs ClickHouse hashing)', S, staged))
    console.log(check('skipped   (offline == job)', skipped, job.skipped))
    if (job.repeats !== null && job.repeats !== undefined) console.log(check('repeats   rows repeated inside the file (offline == job)', staged - D, job.repeats))
    console.log(check('split     distinct hashes == new + known', D, job.imported + job.known))
    console.log(check('complete  every distinct hash is in the table', present, D))
    if (!reimport) {
      console.log(check('own       hashes written under this file == job.new', own, job.imported))
      console.log(check('known     hashes held under other files == job.known', present - own, job.known))
      console.log(check('rows      rows of this file in the table == job.new (no duplicates written)', rows, job.imported))
      console.log(check('source    ulp.sources.line_count == job.new (a file with no new row has no sources row)', src === '' ? (job.imported === 0 ? 0 : 'missing') : Number(src), job.imported))
    } else {
      // a RE-IMPORT: the rows the first import wrote and the new parser still produces stay (and count as "known" for this file)
      console.log(check('own       distinct hashes under this file >= job.new', own >= job.imported ? 'yes' : `no (${own} < ${job.imported})`, 'yes'))
      console.log(check('rows      rows of this file in the table == its distinct hashes (no duplicates)', rows, own))
      const linked = Number(clickhouse(`SELECT count() FROM ulp.credentials WHERE _partition_id = '${PARTITION}' AND source_file = ${sqlStr(filename)} AND (position(password, 't.me/') > 0 OR position(email, 't.me/') > 0)`))
      console.log(check('clean     no stored email or password of this file holds a Telegram link', linked, 0))
      console.log(check('source    ulp.sources.line_count == job.new (the delta; no new row, no sources row)', src === '' ? (job.imported === 0 ? 0 : 'missing') : Number(src), job.imported))
      console.log(`info: rows of this file now ${rows}; the delta the re-import added ${job.imported}`)
    }
    console.log(`info: in-file repeats = ${staged - D}`)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
