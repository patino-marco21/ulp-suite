// usage: node scripts/pile/jobs-summary.cjs <dir holding a COPY of ulp.db (+ -wal, -shm)> <since 'YYYY-MM-DD HH:MM:SS' UTC> [list]
// One summary line of the inbox import jobs recorded since <since>; with "list" also one line per job (never a line of a file).
const Database = require('better-sqlite3')
const [dir, since, mode] = process.argv.slice(2)
if (!dir || !since) { console.error('usage: jobs-summary.cjs <dir> <since UTC> [list]'); process.exit(2) }
const db = new Database(`${dir}/ulp.db`)
const rows = db.prepare('SELECT source, filename, status, imported, known, skipped, duration_ms, error_message, created_at FROM processing_jobs WHERE created_at >= ? ORDER BY created_at').all(since)
const sum = (k, st) => rows.filter(r => !st || r.status === st).reduce((a, r) => a + (Number(r[k]) || 0), 0)
const n = st => rows.filter(r => r.status === st).length
console.log(
  `JOBS since ${since}: done=${n('done')} failed=${n('failed')} imported(new)=${sum('imported', 'done')} known=${sum('known', 'done')} skipped=${sum('skipped', 'done')} ` +
  `busy_min=${(sum('duration_ms', 'done') / 60000).toFixed(1)}`,
)
if (mode === 'list') {
  for (const r of rows) console.log(`  ${r.created_at} ${r.status.padEnd(6)} new=${r.imported} known=${r.known} skipped=${r.skipped} ${(r.duration_ms / 1000).toFixed(1)}s ${r.filename}${r.error_message ? '  ERR: ' + String(r.error_message).slice(0, 160) : ''}`)
}
