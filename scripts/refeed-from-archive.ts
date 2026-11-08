/**
 * Reads archived files again after a parser change (docs/superpowers/specs/2026-11-07-file-ledger-design.md, "Re-feeding from the archive"). For each file the ledger holds
 * with a hash, at a parser revision older than the current one, whose bytes the source archive holds, it writes one small `<name> (refeed v6.7).txt.archiveref` into the
 * inbox; the importer decodes the file from the archive, checks its sha256 before anything is committed, and the novelty check stores only the credentials the table does
 * not hold yet. No plaintext copy is made. It never prints a line of a file.
 *
 *   tsx scripts/refeed-from-archive.ts [--apply] [--max-revision N] [--min-revision N] [--only a,b] [--limit N] [--in-flight 2] [--floor-gib 60] [--poll-secs 10]
 *                                      [--no-wait] [--inbox <dir>] [--ledger <file>] [--archive <dir>] [--no-refresh]
 *
 * Without --apply it only lists what it would feed (smallest first) and how many files each rule left out. --only takes file-name parts or sha256 prefixes.
 * With --apply it keeps at most --in-flight references waiting or in processing/, pauses under --floor-gib free (resumes 5 GiB above), stops feeding (it never kills
 * anything) when a file lands in inbox/failed, and, unless --no-wait, waits for the importer to finish what it fed and then says where each reference ended up.
 * A file the quality gate holds lands in inbox/held: that is reported, it is the owner's decision. Environment: ULP_REPO (the checkout whose ./inbox is used; default the
 * current directory), ULP_LEDGER_FILE, ULP_ARCHIVE_DIR.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ARCHIVE_REF_EXT, serializeArchiveRef } from '@/lib/archive-ref'
import { defaultLedgerFile, refreshLedgerIfStale } from '@/lib/ledger-export'
import { readLedgerFile } from '@/lib/ledger-tools'
import { planRefeeds, type RefeedItem } from '@/lib/refeed-plan'
import { defaultArchiveDir, readManifest } from '@/lib/source-archive'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)
const num = (name: string, fallback: number): number => {
  const v = flag(name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) die(`--${name} needs a number, got "${v}"`)
  return n
}
function die(message: string, code = 2): never { console.error(message); process.exit(code) }
const stamp = (): string => new Date().toISOString().slice(11, 19)
const log = (line: string): void => console.log(`${stamp()} ${line}`)
const GiB = 1024 ** 3
const gib = (n: number): string => (n >= GiB ? `${(n / GiB).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`)

const REPO = process.env.ULP_REPO ?? process.cwd()
const INBOX = resolve(flag('inbox') ?? join(REPO, 'inbox'))
const LEDGER = flag('ledger') ?? defaultLedgerFile()
const ARCHIVE = flag('archive') ?? process.env.ULP_ARCHIVE_DIR ?? defaultArchiveDir()
const APPLY = has('apply')
const IN_FLIGHT = Math.max(1, num('in-flight', 2))
const FLOOR = num('floor-gib', 60) * GiB
const POLL_MS = Math.max(50, num('poll-secs', 10) * 1000)
const LIMIT = num('limit', Number.MAX_SAFE_INTEGER)
const ONLY = (flag('only') ?? '').split(',').map(s => s.trim()).filter(Boolean)
const FOLDERS = ['processing', 'done', 'held', 'failed']

if (!existsSync(INBOX)) die(`the inbox folder does not exist: ${INBOX}`)
if (!existsSync(join(ARCHIVE, 'manifest.jsonl'))) die(`no archive manifest in ${ARCHIVE}: nothing can be read from the archive`)

if (!has('no-refresh')) {
  try { if (refreshLedgerIfStale(LEDGER)) log(`ledger copy refreshed: ${LEDGER}`) } catch (err) {
    if (!existsSync(LEDGER)) die(`no ledger copy and the stack could not be read: ${err instanceof Error ? err.message : String(err)}`, 1)
    console.warn(`[refeed] the stack could not be read; using the copy as it is: ${err instanceof Error ? err.message : String(err)}`)
  }
}
if (!existsSync(LEDGER)) die(`no ledger copy at ${LEDGER}`, 1)

/** The names in the inbox and its folders: a reference whose file is already there (waiting, running, done, held or failed) is not written again. */
function inboxNames(): Set<string> {
  const names = new Set<string>()
  for (const dir of [INBOX, ...FOLDERS.map(f => join(INBOX, f))]) {
    if (!existsSync(dir)) continue
    for (const n of readdirSync(dir)) names.add(n)
  }
  return names
}
const count = (dir: string): number => (existsSync(dir) ? readdirSync(dir).length : 0)
/** References waiting in the inbox plus whatever is being imported. */
const pending = (): number => readdirSync(INBOX, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(ARCHIVE_REF_EXT)).length + count(join(INBOX, 'processing'))
const freeBytes = (): number => { const s = statfsSync(INBOX); return s.bavail * s.bsize }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const plan = planRefeeds(readLedgerFile(LEDGER), readManifest(ARCHIVE), {
  minRevision: flag('min-revision') !== undefined ? num('min-revision', 0) : undefined,
  maxRevision: flag('max-revision') !== undefined ? num('max-revision', 0) : undefined,
  only: ONLY,
  inboxNames: inboxNames(),
})
const items = plan.items.slice(0, LIMIT)
const total = items.reduce((s, i) => s + i.entry.size, 0)

for (const i of items) console.log(`${APPLY ? 'queue  ' : 'would  '} ${i.refName} (${gib(i.entry.size)}, read by parser revision ${i.revision})`)
const s = plan.skipped
console.log(`\n${items.length} file(s), ${gib(total)} to read again from the archive. Left out: ${s['already-current']} already read by the current parser, ${s['out-of-range']} outside the revision range, ${s['not-in-archive']} whose bytes are not in the archive, ${s['not-selected']} not selected, ${s['already-in-inbox']} already in the inbox, ${s['name-too-long']} with a name too long.`)
if (!APPLY) { console.log('dry run (nothing written; --apply feeds them)'); process.exit(0) }
if (items.length === 0) { log('nothing to feed'); process.exit(0) }

const WORK = join(dirname(INBOX), '.pile-work')
mkdirSync(WORK, { recursive: true })

/** Written next to the inbox and renamed in, so the importer never sees half a reference. */
function dropReference(i: RefeedItem): void {
  const tmp = join(WORK, `${process.pid}-${i.refFile}`)
  writeFileSync(tmp, serializeArchiveRef({ id: i.entry.id, name: i.refName, size: i.entry.size, sha256: i.entry.sha256 }))
  renameSync(tmp, join(INBOX, i.refFile))
}

async function main(): Promise<void> {
  const failedAtStart = count(join(INBOX, 'failed'))
  let fed = 0
  let stoppedBy: string | undefined
  let lowDisk = false
  for (const i of items) {
    while (true) {
      if (count(join(INBOX, 'failed')) > failedAtStart) { stoppedBy = 'a file landed in inbox/failed'; break }
      const free = freeBytes()
      if (free < FLOOR) { if (!lowDisk) log(`LOW DISK ${gib(free)} free, under the ${gib(FLOOR)} floor: pausing`); lowDisk = true; await sleep(POLL_MS); continue }
      if (lowDisk) { if (free < FLOOR + 5 * GiB) { await sleep(POLL_MS); continue }; log(`DISK OK ${gib(free)} free: resuming`); lowDisk = false }
      if (pending() >= IN_FLIGHT) { await sleep(POLL_MS); continue }
      break
    }
    if (stoppedBy) break
    dropReference(i)
    fed++
    log(`FEED ${i.refName} (${gib(i.entry.size)}; ${fed} of ${items.length})`)
  }
  if (stoppedBy) log(`STOP ${stoppedBy}; ${fed} of ${items.length} fed, the rest stay unfed. Nothing was killed.`)

  if (!has('no-wait')) {
    log('waiting for the importer to finish what was fed')
    while (pending() > 0) await sleep(POLL_MS)
  }
  const where = new Map<string, number>()
  for (const i of items.slice(0, fed)) {
    const place = ['', ...FOLDERS].find(f => existsSync(join(INBOX, f, i.refFile))) ?? 'gone'
    const label = place === '' ? 'inbox (not taken yet)' : place
    where.set(label, (where.get(label) ?? 0) + 1)
    if (place === 'held' || place === 'failed') log(`${place.toUpperCase()} ${i.refName}`)
  }
  log(`${stoppedBy ? 'STOPPED' : 'COMPLETE'}: ${fed} of ${items.length} fed; ${[...where].map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`)
  if (stoppedBy || (where.get('failed') ?? 0) > 0) process.exitCode = 1
}

main().catch(err => { console.error(err); process.exit(1) })
