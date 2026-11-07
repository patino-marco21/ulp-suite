/**
 * Swaps the downloads whose bytes are already ingested and archived for stand-ins (lib/stand-in-sweep.ts; docs/superpowers/specs/2026-11-07-file-ledger-design.md, "The sweep"), so
 * the chat client keeps showing them as downloaded and their disk comes back. This by-hand tool never moves a file and never starts an ingest; scripts/pull-downloads.ts, which
 * the minute timer runs, does this swap and also moves finished new downloads into the inbox.
 *
 *   tsx scripts/stand-in-sweep.ts [--apply] [--dir <folder>] [--min-age <minutes>] [--ext txt] [--min-size 1000000] [--ledger <file>] [--archive <dir>] [--no-refresh]
 *   tsx scripts/stand-in-sweep.ts --restore <stand-in path> [--ledger <file>] [--archive <dir>]
 *
 * Without --apply it only says what it would do. --restore puts the real bytes back where a stand-in is (it needs the file's size in free disk).
 * Environment: ULP_DOWNLOAD_DIR (default ~/Downloads/AyuGram Desktop), ULP_LEDGER_FILE, ULP_ARCHIVE_DIR, ULP_STANDIN_SWEEP=off (the timer's run skips the sweep).
 * Exit 0 when nothing went wrong (a missing download folder or archive is not an error: there is nothing to sweep), 1 when a swap or a restore failed, 2 for a bad call.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultLedgerFile, refreshLedgerIfStale, standInRegistryFile } from '@/lib/ledger-export'
import { indexLedger, readLedgerFile } from '@/lib/ledger-tools'
import { defaultDownloadDir, hashCacheFile, registryEntryFor, restoreStandIn, sweepDownloads } from '@/lib/stand-in-sweep'
import { defaultArchiveDir, readManifest, verifyEntry } from '@/lib/source-archive'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1] }
const has = (name: string): boolean => argv.includes(`--${name}`)

const LEDGER = flag('ledger') ?? defaultLedgerFile()
const ARCHIVE = flag('archive') ?? process.env.ULP_ARCHIVE_DIR ?? defaultArchiveDir()
const say = (m: string): void => console.log(`[stand-in-sweep] ${m}`)
const gib = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`)

function restore(path: string): number {
  const abs = resolve(path)
  const fact = registryEntryFor(standInRegistryFile(LEDGER), abs)
  if (!fact) { console.error(`${abs} is not in the stand-in registry (${standInRegistryFile(LEDGER)}); nothing to restore`); return 2 }
  const entry = readManifest(ARCHIVE).find(e => e.sha256 === fact.sha256)
  if (!entry) { console.error(`the archive holds no entry with sha256 ${fact.sha256}`); return 1 }
  restoreStandIn(abs, entry, ARCHIVE, fact.mtimeNs)
  say(`restored ${abs} (${gib(entry.size)}) from archive ${entry.id}, modification time kept`)
  return 0
}

async function sweep(): Promise<number> {
  const dir = resolve(flag('dir') ?? defaultDownloadDir())
  if (!existsSync(dir)) { say(`no download folder at ${dir}: nothing to sweep`); return 0 }
  if (!existsSync(ARCHIVE)) { say(`no archive at ${ARCHIVE}: nothing can be swapped`); return 0 }
  if (!has('no-refresh')) {
    try { refreshLedgerIfStale(LEDGER) } catch (err) {
      if (!existsSync(LEDGER)) { console.error(`no ledger copy and the stack could not be read: ${err instanceof Error ? err.message : String(err)}`); return 1 }
      console.warn(`[stand-in-sweep] the stack could not be read; using the ledger copy as it is: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!existsSync(LEDGER)) { say(`no ledger copy at ${LEDGER}: nothing is known, nothing is swapped`); return 0 }
  const byHash = new Map(readManifest(ARCHIVE).map(e => [e.sha256, e]))
  const apply = has('apply')
  const r = await sweepDownloads({
    dir, index: indexLedger(readLedgerFile(LEDGER)), holds: sha => byHash.get(sha), verify: e => verifyEntry(ARCHIVE, e),
    registry: standInRegistryFile(LEDGER), hashCache: hashCacheFile(LEDGER),
    exts: (flag('ext') ?? 'txt').split(',').map(e => e.trim()).filter(Boolean),
    minSize: Number(flag('min-size') ?? 1_000_000),
    minAgeMs: flag('min-age') !== undefined ? Number(flag('min-age')) * 60_000 : undefined,
    apply,
  })
  for (const n of r.swapped) say(`swapped for a stand-in: ${n}`)
  for (const n of r.wouldSwap) say(`would swap for a stand-in: ${n}`)
  for (const f of r.failed) say(`FAILED ${f.name}: ${f.error}`)
  say(`${apply ? 'done' : 'dry run (nothing changed; --apply does it)'}: ${r.swapped.length} swapped, ${r.wouldSwap.length} would be, ${r.notIngested.length} not ingested (left), ${r.notArchivedYet.length} ingested but not archived yet (left), ` +
    `${r.waiting.length} not finished (left), ${r.changed.length} changed while read (left), ${r.standIns} already stand-ins, ${r.failed.length} failed; ${r.hashed} file(s) hashed`)
  return r.failed.length > 0 ? 1 : 0
}

async function main(): Promise<number> {
  const target = flag('restore')
  if (has('restore')) {
    if (!target) { console.error('usage: tsx scripts/stand-in-sweep.ts --restore <stand-in path>'); return 2 }
    return restore(target)
  }
  return sweep()
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
