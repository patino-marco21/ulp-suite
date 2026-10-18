// usage: node scripts/pile/jobs-summary.cjs <dir holding a COPY of ulp.db (+ -wal, -shm)> <since 'YYYY-MM-DD HH:MM:SS' UTC> [list]
// One summary line of the inbox import jobs recorded since <since>; with "list" also one line per job (never a line of a file).
// When the database has the phase timings (processing_jobs.parse_ms / check_ms / insert_ms, lib/phase-timings.ts) the lines also say where the time went;
// a copy made before they existed prints exactly what it always printed.
const Database = require('better-sqlite3')
const [dir, since, mode] = process.argv.slice(2)
if (!dir || !since) { console.error('usage: jobs-summary.cjs <dir> <since UTC> [list]'); process.exit(2) }
const db = new Database(`${dir}/ulp.db`)
const columns = new Set(db.prepare('PRAGMA table_info(processing_jobs)').all().map(c => c.name))
const timed = ['parse_ms', 'check_ms', 'insert_ms'].every(c => columns.has(c))
const rows = db.prepare(
  `SELECT source, filename, status, imported, known, skipped, duration_ms, error_message, created_at${timed ? ', parse_ms, check_ms, insert_ms' : ''} FROM processing_jobs WHERE created_at >= ? ORDER BY created_at`,
).all(since)
const sum = (k, st) => rows.filter(r => !st || r.status === st).reduce((a, r) => a + (Number(r[k]) || 0), 0)
const n = st => rows.filter(r => r.status === st).length
const minutes = k => (sum(k, 'done') / 60000).toFixed(1)
const seconds = ms => ((Number(ms) || 0) / 1000).toFixed(1)
console.log(
  `JOBS since ${since}: done=${n('done')} failed=${n('failed')} imported(new)=${sum('imported', 'done')} known=${sum('known', 'done')} skipped=${sum('skipped', 'done')} ` +
  `busy_min=${minutes('duration_ms')}` +
  (timed ? ` parse_min=${minutes('parse_ms')} check_min=${minutes('check_ms')} insert_min=${minutes('insert_ms')}` : ''),
)
if (mode === 'list') {
  for (const r of rows) {
    const phases = timed ? ` parse=${seconds(r.parse_ms)}s check=${seconds(r.check_ms)}s insert=${seconds(r.insert_ms)}s` : ''
    console.log(`  ${r.created_at} ${r.status.padEnd(6)} new=${r.imported} known=${r.known} skipped=${r.skipped} ${seconds(r.duration_ms)}s${phases} ${r.filename}${r.error_message ? '  ERR: ' + String(r.error_message).slice(0, 160) : ''}`)
  }
}
