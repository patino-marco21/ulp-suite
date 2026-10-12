/**
 * The guards of `scripts/archive-sources.ts archive --replace` (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, Part 1).
 * Plain values in, reasons out, so every rule is tested without a ClickHouse or a real inbox. The one destructive helper, replaceOriginal, only unlinks a
 * file after checking that it is still the file that was archived, and then only the names that share its inode.
 */
import { lstatSync, readdirSync, statSync, unlinkSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** A file modified more recently than this may still be downloading. */
export const MIN_AGE_MS = 10 * 60_000
/** Free space that must remain besides the work itself. */
export const FREE_MARGIN_BYTES = 10 * 1024 ** 3

export interface ReplaceFacts {
  nowMs: number
  /** Modification time of the original. */
  mtimeMs: number
  /** A file is in flight: inbox/ holds a top-level file, or inbox/processing/ is not empty. */
  inboxBusy: boolean
  /** The name is in ulp.sources. */
  inSources: boolean
  includeUnimported: boolean
}

export function replaceRefusals(f: ReplaceFacts): string[] {
  const why: string[] = []
  if (f.inboxBusy) why.push('a file is in flight in the inbox (a top-level file in inbox/, or something in inbox/processing/)')
  if (f.nowMs - f.mtimeMs < MIN_AGE_MS) why.push('modified in the last 10 minutes (still being downloaded?)')
  if (!f.inSources && !f.includeUnimported) why.push('not in ulp.sources (not imported yet); use --include-unimported to replace it anyway')
  return why
}

const gib = (n: number) => (n / 1024 ** 3).toFixed(1)

/** The free space the work on one file needs: the margin (10 GiB) plus twice the original (an upper bound of twice its archive). Null when there is room. */
export function spaceRefusal(freeBytes: number, originalBytes: number, marginBytes = FREE_MARGIN_BYTES): string | null {
  const need = marginBytes + 2 * originalBytes
  return freeBytes < need ? `free space ${gib(freeBytes)} GiB is under the ${gib(need)} GiB this work needs (${gib(marginBytes)} GiB plus twice the file)` : null
}

/** True while a file is in flight: a top-level file in the inbox, or anything in inbox/processing/. A missing inbox is not busy. */
export function inboxIsBusy(inboxDir: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(inboxDir, { withFileTypes: true })
  } catch {
    return false
  }
  if (entries.some(e => e.isFile())) return true
  try {
    return readdirSync(join(inboxDir, 'processing')).length > 0
  } catch {
    return false
  }
}

/** The regular files in `dirs` (not symlinks) that are hardlinks of `original`: same device and inode. */
export function sameInodeNames(original: string, dirs: string[]): string[] {
  const st = statSync(original)
  const found: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const p = join(dir, n)
      try {
        const s = lstatSync(p)
        if (s.isFile() && s.ino === st.ino && s.dev === st.dev) found.push(p)
      } catch {
        /* vanished meanwhile */
      }
    }
  }
  return found
}

/**
 * Unlinks the hardlinks of `original` under `linkDirs`, then `original`. Throws, removing nothing, when the original no longer has the size and modification time it
 * had when it was archived. Returns the paths removed.
 */
export function replaceOriginal(original: string, linkDirs: string[], expected: { size: number; mtimeMs: number }): string[] {
  const st = statSync(original)
  if (st.size !== expected.size || st.mtimeMs !== expected.mtimeMs) {
    throw new Error('the original changed while it was archived; nothing was removed')
  }
  const links = sameInodeNames(original, linkDirs)
  for (const p of links) unlinkSync(p)
  unlinkSync(original)
  return [...links, original]
}
