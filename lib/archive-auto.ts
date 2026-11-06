/**
 * The automatic archive run (scripts/archive-when-idle.ts, ticket 04 of .scratch/ingest-yield-and-throughput): when the inbox has been quiet for a while, the files in
 * inbox/done that are not archived yet are archived and a sample is verified. Plaintext is never removed by it: `--replace` stays the owner's decision. This file holds
 * the plain parts (when to run, what is ready to replace, the status file and its one-line note) so each is tested without a ClickHouse, a real archive or a clock.
 *
 * The status file lives in the archive directory, which the app container mounts read-only (docker-compose.yml), so the Inbox page can show it.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ManifestEntry } from '@/lib/source-archive'

export const AUTO_STATUS_FILE = 'auto-archive-status.json'
/** How long the inbox must have been still before a run starts. */
export const DEFAULT_IDLE_MS = 20 * 60_000

const GiB = 1024 ** 3
const gib = (n: number) => (n / GiB).toFixed(1)
const files = (n: number) => (n === 1 ? '1 file' : `${n} files`)

export interface IdleFacts {
  nowMs: number
  /** inboxIsBusy(): a top-level file waiting, or something in inbox/processing/ (the disk gate holding the ingest leaves files waiting, so it counts as busy too). */
  inboxBusy: boolean
  /** The newest change of any inbox folder (inboxLastActivityMs), null when there are none. */
  lastActivityMs: number | null
  idleMs: number
}

/** Why a run must not start now. Empty when the inbox is idle. */
export function idleRefusals(f: IdleFacts): string[] {
  const why: string[] = []
  if (f.inboxBusy) why.push('a file is waiting or in flight in the inbox')
  if (f.lastActivityMs !== null && f.nowMs - f.lastActivityMs < f.idleMs) {
    why.push(`the inbox changed ${Math.floor((f.nowMs - f.lastActivityMs) / 60_000)} minutes ago (a run waits for ${Math.round(f.idleMs / 60_000)} minutes of quiet)`)
  }
  return why
}

/** After a run that failed (an archive or the sample check), the next waits this long: a file that cannot be archived must not be compressed again every tick. */
export const FAILURE_BACKOFF_MS = 6 * 60 * 60_000

/** Why this run should wait for the failure of the last one; null when it should go ahead. `--now` skips this in the script. */
export function failureBackoff(prev: Pick<AutoArchiveStatus, 'at' | 'failed' | 'verify'> | null, nowMs: number): string | null {
  if (!prev || (prev.failed === 0 && (prev.verify?.failed ?? 0) === 0)) return null
  const ago = nowMs - Date.parse(prev.at)
  if (!(ago >= 0) || ago >= FAILURE_BACKOFF_MS) return null
  return `the last run failed ${Math.round(ago / 60_000)} minutes ago and a run after a failure waits 6 hours (--now overrides)`
}

/** The newest modification time of the inbox folders. A folder changes when a file is added, removed or renamed in it, which is what finishing a file does. */
export function inboxLastActivityMs(inboxDir: string): number | null {
  let newest: number | null = null
  for (const dir of [inboxDir, ...['processing', 'done', 'failed', 'held'].map(d => join(inboxDir, d))]) {
    try {
      const t = statSync(dir).mtimeMs
      if (newest === null || t > newest) newest = t
    } catch {
      /* the folder does not exist */
    }
  }
  return newest
}

export interface ReadyToReplace {
  /** Files in done/ whose latest manifest entry matches them and whose archive file exists: the replace would remove them. */
  ready_files: number
  /** Plaintext the replace would free: each inode counted once, however many names it has. */
  ready_bytes: number
  /** `*.txt` files in done/ the archive does not hold yet (the next run takes them). */
  unarchived_files: number
  unarchived_bytes: number
  /** Files the tool does not read at all: its names must end in .txt. */
  other_files: number
  other_bytes: number
  /** Files of 0 bytes (a copy that failed): there is nothing to archive. */
  empty_files: number
}

export function readyToReplace(doneDir: string, archiveDir: string, latest: Map<string, ManifestEntry>): ReadyToReplace {
  const r: ReadyToReplace = { ready_files: 0, ready_bytes: 0, unarchived_files: 0, unarchived_bytes: 0, other_files: 0, other_bytes: 0, empty_files: 0 }
  const seen = new Set<string>()
  let names: string[] = []
  try { names = readdirSync(doneDir).sort() } catch { return r }
  for (const name of names) {
    let st
    try { st = lstatSync(join(doneDir, name)) } catch { continue }
    if (!st.isFile()) continue
    if (st.size === 0) { r.empty_files++; continue }
    const inode = `${st.dev}:${st.ino}`
    const firstName = !seen.has(inode)
    seen.add(inode)
    if (!name.toLowerCase().endsWith('.txt')) { r.other_files++; if (firstName) r.other_bytes += st.size; continue }
    const e = latest.get(name)
    if (e && e.size === st.size && existsSync(join(archiveDir, `${e.id}.zst`))) {
      r.ready_files++
      if (firstName) r.ready_bytes += st.size
    } else {
      r.unarchived_files++
      if (firstName) r.unarchived_bytes += st.size
    }
  }
  return r
}

export interface ArchiveSummary { archived: number; already: number; young: number; failed: number; plain_bytes: number }

/** The last line of `archive`: "archived 11, already archived 8, too young 0, replaced 0, kept 0, failed 0; plaintext 19.20 GiB". */
export function parseArchiveSummary(output: string): ArchiveSummary | null {
  const m = /archived (\d+), already archived (\d+), too young (\d+), replaced \d+, kept \d+, failed (\d+); plaintext ([\d.]+) GiB/.exec(output)
  return m ? { archived: Number(m[1]), already: Number(m[2]), young: Number(m[3]), failed: Number(m[4]), plain_bytes: Math.round(Number(m[5]) * GiB) } : null
}

/** The last line of `verify`: "verified 3, failed 0". */
export function parseVerifySummary(output: string): { checked: number; failed: number } | null {
  const m = /verified (\d+), failed (\d+)/.exec(output)
  return m ? { checked: Number(m[1]), failed: Number(m[2]) } : null
}

export interface AutoArchiveStatus extends ReadyToReplace {
  v: 1
  /** When the run finished (ISO). */
  at: string
  /** False when there was nothing new to archive (the figures are still fresh). */
  ran: boolean
  archived: number
  failed: number
  plain_bytes: number
  verify: { checked: number; failed: number } | null
  free_bytes: number
}

export function writeStatus(archiveDir: string, status: AutoArchiveStatus): void {
  const path = join(archiveDir, AUTO_STATUS_FILE)
  writeFileSync(`${path}.part`, JSON.stringify(status) + '\n')
  renameSync(`${path}.part`, path)
}

/** The status the last run left, or null when there is none or it is not one this version understands. Never throws. */
export function readStatus(archiveDir: string): AutoArchiveStatus | null {
  try {
    const s = JSON.parse(readFileSync(join(archiveDir, AUTO_STATUS_FILE), 'utf8')) as Partial<AutoArchiveStatus>
    return s && s.v === 1 && typeof s.at === 'string' ? (s as AutoArchiveStatus) : null
  } catch {
    return null
  }
}

/** The one-line account the Inbox page and the run's log carry: what was archived, what is ready to replace and what that would free. */
export function archiveNote(s: AutoArchiveStatus): string {
  const parts: string[] = []
  parts.push(s.archived > 0 ? `Archive: ${files(s.archived)} archived (${gib(s.plain_bytes)} GiB)` : s.ran ? 'Archive: no file was archived' : 'Archive: nothing new to archive')
  if (s.verify && s.verify.checked > 0) parts[0] += `, ${s.verify.checked - s.verify.failed} of ${s.verify.checked} sampled files verified`
  parts[0] += '.'
  if (s.failed > 0) parts.push(`${files(s.failed)} FAILED to archive.`)
  if (s.verify && s.verify.checked === 0 && s.verify.failed > 0) parts.push('The sample check FAILED to run.')
  else if (s.verify && s.verify.failed > 0) parts.push(`${s.verify.failed} of ${s.verify.checked} sampled files FAILED the check.`)
  parts.push(s.ready_files > 0
    ? `${files(s.ready_files)} ${s.ready_files === 1 ? 'is' : 'are'} ready to replace: removing their plaintext would free about ${gib(s.ready_bytes)} GiB.`
    : 'Nothing is ready to replace.')
  if (s.unarchived_files > 0) parts.push(`${files(s.unarchived_files)} (${gib(s.unarchived_bytes)} GiB) in done/ ${s.unarchived_files === 1 ? 'is' : 'are'} not archived yet.`)
  if (s.other_files > 0) parts.push(`${files(s.other_files)} (${gib(s.other_bytes)} GiB) with another name than *.txt ${s.other_files === 1 ? 'is' : 'are'} not archived by the tool.`)
  if (s.empty_files > 0) parts.push(`${files(s.empty_files)} of 0 bytes (a copy that failed) ${s.empty_files === 1 ? 'is' : 'are'} in done/.`)
  parts.push(`Free disk: ${gib(s.free_bytes)} GiB. Nothing is removed without you.`)
  return parts.join(' ')
}
