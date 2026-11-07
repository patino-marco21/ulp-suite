/**
 * Moves downloaded files into the inbox the way the file ledger wants them (docs/superpowers/specs/2026-11-07-file-ledger-design.md), and leaves a STAND-IN where each
 * download was: a sparse file of the same name, size and modification time that takes no disk. Telegram Desktop and AyuGram keep a message "downloaded" while a file with that
 * size and time sits at the path they recorded, so the message does not offer the download again after the real file has moved on.
 *
 *   tsx scripts/take-to-inbox.ts <file-or-folder>... [--apply] [--refeed] [--ext txt] [--min-size 1000000] [--inbox <dir>] [--ledger <file>] [--archive <dir>] [--no-refresh]
 *
 * Without --apply it only says what it would do. For each file it computes the sha256 and asks the ledger (the plain-text copy of ulp.sources, refreshed when older than 5 min):
 *   new                            move into the inbox, leave a stand-in
 *   ingested, bytes in the archive swap the download for a stand-in (frees the disk); nothing is moved
 *   ingested, not archived yet     leave the file where it is
 *   ingested by an older parser    with --refeed: move it under a name that says "refeed", so the importer takes it again
 *   the name is taken in the inbox refuse (nothing is overwritten)
 * A folder is read one level deep, for the extensions of --ext (default txt) and the files of --min-size bytes or more; a file named on the command line is always looked at.
 * A file that is already a stand-in is skipped. Every stand-in is listed in the registry next to the ledger copy. The move is a rename: the inbox must be on the same
 * filesystem as the download. Environment: ULP_LEDGER_FILE, ULP_ARCHIVE_DIR, ULP_REPO (the checkout whose ./inbox is used; default the current directory).
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { defaultLedgerFile, refreshLedgerIfStale, standInRegistryFile } from '@/lib/ledger-export'
import {
  appendStandIn, indexLedger, isStandIn, moveAndLeaveStandIn, planTake, readLedgerFile, replaceWithStandIn, sha256OfFile, type TakeAction,
} from '@/lib/ledger-tools'
import { defaultArchiveDir, readManifest } from '@/lib/source-archive'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
const FLAGS_WITH_VALUE = new Set(['ext', 'min-size', 'inbox', 'ledger', 'archive'])
const targets = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && FLAGS_WITH_VALUE.has(argv[i - 1].slice(2))))

const REPO = process.env.ULP_REPO ?? process.cwd()
const INBOX = resolve(flag('inbox') ?? join(REPO, 'inbox'))
const LEDGER = flag('ledger') ?? defaultLedgerFile()
const APPLY = has('apply')
const EXT = (flag('ext') ?? 'txt').split(',').map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
const MIN_SIZE = Number(flag('min-size') ?? 1_000_000)
const gib = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`)

function die(message: string, code = 2): never { console.error(message); process.exit(code) }
if (targets.length === 0) die('usage: tsx scripts/take-to-inbox.ts <file-or-folder>... [--apply] [--refeed]')
if (!existsSync(INBOX)) die(`the inbox folder does not exist: ${INBOX}`)

// The files to look at: those named, and one level of each folder named.
const files: string[] = []
for (const t of targets) {
  const p = resolve(t)
  if (!existsSync(p)) die(`not found: ${p}`)
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p)) {
      const f = join(p, name)
      const st = statSync(f)
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
      if (st.isFile() && EXT.includes(ext) && st.size >= MIN_SIZE) files.push(f)
    }
  } else {
    files.push(p)
  }
}

if (!has('no-refresh')) {
  try { if (refreshLedgerIfStale(LEDGER)) console.log(`[take-to-inbox] ledger copy refreshed: ${LEDGER}`) } catch (err) {
    if (!existsSync(LEDGER)) die(`no ledger copy and the stack could not be read: ${err instanceof Error ? err.message : String(err)}`, 1)
    console.warn(`[take-to-inbox] the stack could not be read; using the copy as it is: ${err instanceof Error ? err.message : String(err)}`)
  }
}
const index = indexLedger(readLedgerFile(LEDGER))

const archiveDir = flag('archive') ?? process.env.ULP_ARCHIVE_DIR ?? defaultArchiveDir()
const archived = new Set<string>(existsSync(archiveDir) ? readManifest(archiveDir).map(e => e.sha256) : [])

/** Names already in the inbox or one of its folders: a file moved onto one of them would replace it or be skipped by the same-name guard. */
const inboxNames = new Set<string>()
for (const dir of [INBOX, ...['processing', 'done', 'held', 'failed'].map(d => join(INBOX, d))]) {
  if (!existsSync(dir)) continue
  for (const n of readdirSync(dir)) inboxNames.add(n)
}

const REGISTRY = standInRegistryFile(LEDGER)
let moved = 0, swapped = 0, kept = 0, refused = 0, skipped = 0, failed = 0

async function main(): Promise<void> {
  for (const src of files) {
    const name = basename(src)
    if (isStandIn(src)) { skipped++; console.log(`skip     ${name}: already a stand-in`); continue }
    const size = statSync(src).size
    let sha256: string
    try { sha256 = await sha256OfFile(src) } catch (err) { failed++; console.log(`FAILED   ${name}: ${err instanceof Error ? err.message : String(err)}`); continue }
    const action: TakeAction = planTake(index, { name, size, sha256, archiveHolds: archived.has(sha256), inboxNames, refeed: has('refeed') })
    const label = action.kind === 'move' ? 'move    ' : action.kind === 'standin-only' ? 'stand-in' : action.kind === 'keep' ? 'keep    ' : 'REFUSED '
    const why = action.kind === 'move' ? `${action.note}${action.destName !== name ? ` -> "${action.destName}"` : ''}` : action.reason
    console.log(`${label} ${name} (${gib(size)}): ${why}`)
    if (!APPLY) { if (action.kind === 'keep') kept++; else if (action.kind === 'refuse') refused++; continue }
    try {
      if (action.kind === 'move') {
        const r = moveAndLeaveStandIn(src, join(INBOX, action.destName))
        appendStandIn(REGISTRY, src, r.size, r.mtimeNs, sha256, new Date().toISOString())
        inboxNames.add(action.destName)
        moved++
      } else if (action.kind === 'standin-only') {
        const r = replaceWithStandIn(src)
        appendStandIn(REGISTRY, src, r.size, r.mtimeNs, sha256, new Date().toISOString())
        swapped++
      } else if (action.kind === 'keep') kept++
      else refused++
    } catch (err) {
      failed++
      console.log(`FAILED   ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`\n${APPLY ? 'done' : 'dry run (nothing changed; --apply does it)'}: ${moved} moved, ${swapped} swapped for a stand-in, ${kept} kept, ${refused} refused, ${skipped} skipped, ${failed} failed`)
  if (failed > 0 || refused > 0) process.exitCode = 1
}

main().catch(err => { console.error(err); process.exit(1) })
