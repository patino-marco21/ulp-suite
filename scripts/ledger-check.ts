/**
 * Checks a Telegram Desktop chat export against the file ledger BEFORE anything is downloaded (docs/superpowers/specs/2026-11-07-file-ledger-design.md). The export lists a
 * name and a size for every file of a chat, with the file itself in it or not (Settings > Advanced > Export Telegram data; JSON; untick the files, or set a small size limit, so
 * nothing is downloaded; a date range exports only what is new). Nothing here uses your Telegram session or its data folder.
 *
 *   tsx scripts/ledger-check.ts <result.json> [--dir <download folder>] [--ext txt] [--min-size 1000000] [--new-out <file>] [--all] [--ledger <file>] [--no-refresh]
 *
 *   NEW             not in the ledger: worth downloading
 *   DIFFERENT-SIZE  the ledger has the name with another size: a different file under a used name, worth downloading
 *   LOCAL           the download folder already has a file of that name and size (a stand-in counts)
 *   HAVE            the ledger has the name and the size
 * The same file in several messages or chats is one line, with the number of copies. Default filter: .txt files of 1 MB or more. --all lists every status; the default lists
 * NEW and DIFFERENT-SIZE. --new-out writes those two as a tab-separated file. The match is by name and size, which is all the export holds; the importer's own check
 * (content hash) is the safety net for a name that is reused.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultLedgerFile, refreshLedgerIfStale } from '@/lib/ledger-export'
import { checkExport, indexLedger, localKey, parseTelegramExport, readLedgerFile, type ExportVerdict } from '@/lib/ledger-tools'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
const FLAGS_WITH_VALUE = new Set(['dir', 'ext', 'min-size', 'new-out', 'ledger'])
const input = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && FLAGS_WITH_VALUE.has(argv[i - 1].slice(2))))

function die(message: string, code = 2): never { console.error(message); process.exit(code) }
if (!input) die('usage: tsx scripts/ledger-check.ts <result.json> [--dir <download folder>] [--new-out <file>] [--all]')
if (!existsSync(input)) die(`not found: ${input}`)

const LEDGER = flag('ledger') ?? defaultLedgerFile()
if (!has('no-refresh')) {
  try { if (refreshLedgerIfStale(LEDGER)) console.log(`[ledger-check] ledger copy refreshed: ${LEDGER}`) } catch (err) {
    if (!existsSync(LEDGER)) die(`no ledger copy and the stack could not be read: ${err instanceof Error ? err.message : String(err)}`, 1)
    console.warn(`[ledger-check] the stack could not be read; using the copy as it is: ${err instanceof Error ? err.message : String(err)}`)
  }
}

let json: unknown
try { json = JSON.parse(readFileSync(input, 'utf8')) } catch (err) {
  die(`could not read ${input} as JSON (${err instanceof Error ? err.message : String(err)}). A very large export can exceed what one read allows: export one chat at a time, or a date range.`, 1)
}
const files = parseTelegramExport(json)
if (files.length === 0) die('the export lists no file: check that it is the JSON export (result.json) and that the chat has files')

/** Name and size of every file under the download folder, stand-ins included (their apparent size is the real one). */
function listLocal(dir: string, into: Set<string>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) listLocal(p, into)
    else if (st.isFile()) into.add(localKey(name, st.size))
  }
}
const local = new Set<string>()
if (flag('dir')) {
  const dir = resolve(flag('dir')!)
  if (!existsSync(dir)) die(`not found: ${dir}`)
  listLocal(dir, local)
}

const verdicts = checkExport(files, indexLedger(readLedgerFile(LEDGER)), {
  extensions: (flag('ext') ?? 'txt').split(',').map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean),
  minSize: Number(flag('min-size') ?? 1_000_000),
  local,
})

const gib = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`)
const count = (s: string) => verdicts.filter(v => v.status === s).length
const bytes = (s: string) => verdicts.filter(v => v.status === s).reduce((a, v) => a + v.size, 0)
const line = (v: ExportVerdict) =>
  `${v.status.padEnd(14)} ${gib(v.size).padStart(10)}  ${v.firstMessage.date.slice(0, 10)}  ${v.name}${v.copies > 1 ? `  (${v.copies} messages)` : ''}${v.detail ? `  [${v.detail}]` : ''}`

console.log(`${files.length} file messages in the export, ${verdicts.length} distinct files (name and size) after the filter`)
for (const s of ['NEW', 'DIFFERENT-SIZE', 'LOCAL', 'HAVE']) console.log(`  ${s.padEnd(14)} ${String(count(s)).padStart(5)} files  ${gib(bytes(s)).padStart(10)}`)
console.log('')
for (const v of verdicts) if (has('all') || v.status === 'NEW' || v.status === 'DIFFERENT-SIZE') console.log(line(v))

if (flag('new-out')) {
  const wanted = verdicts.filter(v => v.status === 'NEW' || v.status === 'DIFFERENT-SIZE')
  writeFileSync(flag('new-out')!, ['#status\tname\tsize\tdate\tchat\tmessage_id', ...wanted.map(v => [v.status, v.name, v.size, v.firstMessage.date, v.firstMessage.chat, v.firstMessage.messageId].join('\t'))].join('\n') + '\n')
  console.log(`\n${wanted.length} files written to ${flag('new-out')}`)
}
