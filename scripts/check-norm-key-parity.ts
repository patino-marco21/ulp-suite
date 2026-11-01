/**
 * Read-only parity check of the normalised key (docs/superpowers/specs/2026-11-01-near-duplicates-design.md): in each domain range given, the number of distinct
 * keys of the SQL the tables define (lib/url-content-key.ts) must equal the number of an independent formulation of the same rule (the scheme and one trailing
 * slash removed, host and rest split by hand, then the www. and the remaining trailing slashes removed with their own patterns). It counts and writes nothing.
 * Look-alikes share a `domain` (the parser lower-cases it and strips www.) and the table is ordered by it, so a domain range holds every twin of its rows.
 *
 *   npx tsx scripts/check-norm-key-parity.ts ha:hb ta:tb sc:sd                          # the live server: container ulpsuite_clickhouse
 *   CH_CONTAINER=ulprehearsal_clickhouse npx tsx scripts/check-norm-key-parity.ts a:b   # the rehearsal stack
 *
 * A range is lo:hi, meaning domain >= lo AND domain < hi. Exit 0 when every range agrees, 1 when one does not, 2 on a usage or ClickHouse error.
 */
import { execFileSync } from 'node:child_process'
import { NORM_CONTENT_KEY } from '../lib/url-content-key'

const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const ranges = process.argv.slice(2).map(a => a.split(':'))
if (ranges.length === 0 || ranges.some(r => r.length !== 2 || r[0] === '' || r[1] === '')) {
  console.error('usage: check-norm-key-parity.ts <lo:hi> [<lo:hi> ...]   (domain >= lo AND domain < hi)')
  process.exit(2)
}

const INDEPENDENT = String.raw`cityHash64(concat(lower(replaceRegexpOne(auth, '^(?i:www\\.)', '')), replaceRegexpOne(rest, '/+$', '')), lower(email), password)`

const QUERY = `
WITH
  replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '') AS u,
  extract(u, '^[^/?#]*') AS auth,
  substring(u, length(auth) + 1) AS rest
SELECT count() AS rows, uniqExact(${INDEPENDENT}) AS independent_keys, uniqExact(${NORM_CONTENT_KEY}) AS table_keys
FROM ulp.credentials WHERE domain >= {lo:String} AND domain < {hi:String}
SETTINGS max_threads = 6, max_memory_usage = 4000000000
FORMAT TSV`

let failed = 0
for (const [lo, hi] of ranges) {
  let out: string
  try {
    out = execFileSync('docker', ['exec', CH, 'clickhouse-client', `--param_lo=${lo}`, `--param_hi=${hi}`, '--query', QUERY], { encoding: 'utf8', maxBuffer: 1 << 20 }).trim()
  } catch (err) {
    console.error(`range ${lo}:${hi}: ClickHouse failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`)
    process.exit(2)
  }
  const [rows, independent, table] = out.split('\t').map(Number)
  const ok = Number.isFinite(independent) && independent === table
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${lo}:${hi}  rows ${rows}  independent form ${independent} keys  table's SQL ${table} keys`)
}
process.exit(failed === 0 ? 0 : 1)
