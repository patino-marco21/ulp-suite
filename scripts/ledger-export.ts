/**
 * Writes the plain-text copy of the file ledger (docs/superpowers/specs/2026-11-07-file-ledger-design.md): one line per file the stack has imported, with its size, sha256, the
 * parser revision and the date. Grep it before you download a file; scripts/ledger-check.ts and scripts/take-to-inbox.ts read it.
 *
 *   tsx scripts/ledger-export.ts [--out <file>] [--no-jobs]
 *
 * Default file: ULP_LEDGER_FILE, else ~/Desktop/ulp-ledger.tsv (outside the repository: it holds file names). Environment: CH_CONTAINER (ulpsuite_clickhouse), APP_CONTAINER
 * (ulpsuite_app, for the job-log lines; --no-jobs leaves them out). scripts/archive-when-idle.ts runs it every time its timer fires. It only reads the stack.
 */
import { defaultLedgerFile, exportLedger } from '@/lib/ledger-export'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }

try {
  const r = exportLedger(flag('out') ?? defaultLedgerFile(), { jobs: !argv.includes('--no-jobs') })
  console.log(`[ledger-export] ${r.ledger} ledger lines + ${r.jobs} job-log lines -> ${r.out}`)
} catch (err) {
  console.error(`[ledger-export] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
