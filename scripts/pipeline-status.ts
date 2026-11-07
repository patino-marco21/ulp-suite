/**
 * Prints the pipeline status (lib/pipeline-status.ts) and, with --write, also rewrites STATUS.html, STATUS.txt and README.txt in the pipeline folder.
 *
 *   tsx scripts/pipeline-status.ts [--write] [--json]
 *
 * Environment: ULP_DOWNLOAD_DIR, ULP_REPO, ULP_ARCHIVE_DIR, ULP_LEDGER_FILE / ULP_PIPELINE_DIR (as scripts/pull-downloads.ts). Exit 0 when everything works, 1 when something is
 * amber (needs you), 2 when something is broken, so a script can ask.
 */
import { dirname } from 'node:path'
import { defaultLedgerFile } from '@/lib/ledger-export'
import { evaluate, gatherFacts, renderText, writeStatusFiles } from '@/lib/pipeline-status'
import { defaultArchiveDir } from '@/lib/source-archive'
import { defaultDownloadDir } from '@/lib/stand-in-sweep'

const ledger = defaultLedgerFile()
const facts = gatherFacts({
  downloads: defaultDownloadDir(), repo: process.env.ULP_REPO ?? process.cwd(), archive: process.env.ULP_ARCHIVE_DIR ?? defaultArchiveDir(), pipeline: dirname(ledger), ledger,
})
const verdict = process.argv.includes('--write') ? writeStatusFiles(facts) : evaluate(facts)
if (process.argv.includes('--json')) console.log(JSON.stringify({ facts, verdict }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2))
else process.stdout.write(renderText(facts, verdict))
process.exit(verdict.level === 'ok' ? 0 : verdict.level === 'warn' ? 1 : 2)
