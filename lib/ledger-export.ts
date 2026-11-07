/**
 * Fetches the file ledger from the running stack and writes its plain-text copy (docs/superpowers/specs/2026-11-07-file-ledger-design.md). Shared by the ledger scripts; it
 * reaches ClickHouse and the app's job log through `docker exec`, as scripts/archive-sources.ts does, so it runs on the host without the app's environment.
 *
 * The copy has one line per row of ulp.sources (`ledger`) and one per file the job log completed that has no such row (`jobs`: files from before the ledger, and files
 * that yielded nothing before the ledger remembered them). It lives OUTSIDE the repository: it holds file names.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatLedger, writeFileAtomic, type LedgerRow } from '@/lib/ledger-tools'

const CH = () => process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const APP = () => process.env.APP_CONTAINER ?? 'ulpsuite_app'

/** The folder that holds everything the download pipeline keeps on this machine for the owner to open: ULP_PIPELINE_DIR, or ulp-pipeline on the desktop. */
export function pipelineDir(env: NodeJS.Dict<string> = process.env): string {
  return env.ULP_PIPELINE_DIR && env.ULP_PIPELINE_DIR.trim() !== '' ? env.ULP_PIPELINE_DIR : join(homedir(), 'Desktop', 'ulp-pipeline')
}

/** Where the plain-text ledger lives: ULP_LEDGER_FILE, or ledger.tsv in the pipeline folder. */
export function defaultLedgerFile(env: NodeJS.Dict<string> = process.env): string {
  return env.ULP_LEDGER_FILE && env.ULP_LEDGER_FILE.trim() !== '' ? env.ULP_LEDGER_FILE : join(pipelineDir(env), 'ledger.tsv')
}

/** The stand-in registry sits next to the ledger. */
export function standInRegistryFile(ledgerFile: string): string {
  return join(dirname(ledgerFile), 'stand-ins.tsv')
}

function docker(container: string, args: string[], input?: string): string {
  const r = spawnSync('docker', ['exec', ...(input !== undefined ? ['-i'] : []), container, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`docker exec ${container} failed: ${(r.stderr ?? '').slice(0, 300)}`)
  return r.stdout
}

interface SourceRow { filename: string; size: string | number; sha256: string; line_count: string | number; parser_revision: string | number; imported_at: string; archived: number | boolean }

export function fetchLedgerRows(): LedgerRow[] {
  const out = docker(CH(), ['clickhouse-client', '-q',
    "SELECT filename, size, sha256, line_count, parser_revision, toString(imported_at) AS imported_at, archive_id != '' AS archived FROM ulp.sources ORDER BY imported_at FORMAT JSONEachRow"])
  return out.split('\n').filter(l => l.trim() !== '').map(l => {
    const r = JSON.parse(l) as SourceRow
    return {
      kind: 'ledger', filename: r.filename, size: Number(r.size), sha256: r.sha256, lines: Number(r.line_count), revision: Number(r.parser_revision), when: r.imported_at,
      archived: Boolean(Number(r.archived)),
    } satisfies LedgerRow
  })
}

/** Run inside the app container, where better-sqlite3 and the live database (with its write-ahead log) are. Prints one JSON line per file name. */
const JOBS_SCRIPT = `
const D = require('better-sqlite3'); const db = new D('/app/data/ulp.db', { readonly: true });
const rows = db.prepare("SELECT filename, min(created_at) first, sum(coalesce(imported,0)) added FROM processing_jobs WHERE status = 'done' AND coalesce(note,'') NOT IN ('already-imported','empty-file','same-content') GROUP BY filename").all();
for (const r of rows) console.log(JSON.stringify(r));
`

/** Files the job log completed that ulp.sources has no row for. A job named like an archive reference stands for the file it points at. Fails soft: the jobs part is a courtesy. */
export function fetchJobOnlyRows(known: Set<string>): LedgerRow[] {
  let out: string
  try { out = docker(APP(), ['node', '-e', JOBS_SCRIPT]) } catch (err) {
    console.warn(`[ledger-export] the job log could not be read, so the copy has no 'jobs' lines: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  const rows: LedgerRow[] = []
  const seen = new Set<string>()
  for (const l of out.split('\n').filter(x => x.trim().startsWith('{'))) {
    const r = JSON.parse(l) as { filename: string; first: string; added: number }
    const name = r.filename.endsWith('.archiveref') ? r.filename.slice(0, -'.archiveref'.length) : r.filename
    if (known.has(name) || seen.has(name)) continue
    seen.add(name)
    rows.push({ kind: 'jobs', filename: name, size: 0, sha256: '', lines: Number(r.added) || 0, revision: 0, when: r.first, archived: false })
  }
  return rows
}

/** Reads the ledger and writes the plain-text copy; returns the number of lines of each kind. */
export function exportLedger(out: string = defaultLedgerFile(), opts: { jobs?: boolean } = {}): { ledger: number; jobs: number; out: string } {
  const ledger = fetchLedgerRows()
  const jobs = opts.jobs === false ? [] : fetchJobOnlyRows(new Set(ledger.map(r => r.filename)))
  writeFileAtomic(out, formatLedger([...ledger, ...jobs]))
  return { ledger: ledger.length, jobs: jobs.length, out }
}

/** Refreshes the copy when it is missing or older than `maxAgeMs`; returns true when it did. */
export function refreshLedgerIfStale(out: string = defaultLedgerFile(), maxAgeMs = 5 * 60_000): boolean {
  if (existsSync(out) && Date.now() - statSync(out).mtimeMs < maxAgeMs) return false
  exportLedger(out)
  return true
}
