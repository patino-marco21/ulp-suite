/**
 * Filesystem helpers for the inbox watcher directories.
 *
 * Extracted from API routes so they can be unit-tested in isolation
 * (tests mock 'fs' rather than needing a real filesystem).
 */

import fs   from 'fs'
import path from 'path'

export const INBOX_DIR  = path.resolve('./inbox')
export const DONE_DIR   = path.resolve('./inbox/done')
export const FAILED_DIR = path.resolve('./inbox/failed')

export interface InboxFileEntry {
  name:       string
  size_bytes: number
  mtime:      string   // ISO datetime string
}

function readFileEntries(dir: string): InboxFileEntry[] {
  try {
    return (fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile())
      .map(e => {
        const stat = fs.statSync(path.join(dir, e.name))
        return { name: e.name, size_bytes: stat.size, mtime: stat.mtime.toISOString() }
      })
  } catch {
    return []
  }
}

/** Files in inbox/ root — sorted oldest first (next to process). */
export function getWaiting(): InboxFileEntry[] {
  try {
    return (fs.readdirSync(INBOX_DIR, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile())   // skip done/ and failed/ subdirs
      .map(e => {
        const stat = fs.statSync(path.join(INBOX_DIR, e.name))
        return { name: e.name, size_bytes: stat.size, mtime: stat.mtime.toISOString() }
      })
      .sort((a, b) => a.mtime.localeCompare(b.mtime))
  } catch {
    return []
  }
}

/** Files in inbox/failed/. */
export function getFailed(): InboxFileEntry[] {
  return readFileEntries(FAILED_DIR)
}

/** Count of files in inbox/done/ — no file details (could be thousands). */
export function getDoneCount(): number {
  try {
    return (fs.readdirSync(DONE_DIR, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile()).length
  } catch {
    return 0
  }
}

/**
 * Move named files from inbox/failed/ → inbox/.
 * Skips filenames containing '/', '\\', or '..' (path traversal guard).
 * Returns the list of filenames actually moved.
 */
export function retryFiles(filenames: string[]): string[] {
  const moved: string[] = []
  for (const name of filenames) {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
    try {
      fs.renameSync(path.join(FAILED_DIR, name), path.join(INBOX_DIR, name))
      moved.push(name)
    } catch {
      // file missing or unreadable — skip
    }
  }
  return moved
}

/** Move ALL files from inbox/failed/ → inbox/. */
export function retryAllFailed(): string[] {
  try {
    const names = (fs.readdirSync(FAILED_DIR, { withFileTypes: true }) as fs.Dirent[])
      .filter(e => e.isFile())
      .map(e => e.name)
    return retryFiles(names)
  } catch {
    return []
  }
}

// ─── Content sniffing for files whose name says nothing ──────────────────────

export type SniffedKind = 'zip' | 'text' | 'binary'

const SNIFF_BYTES = 64 * 1024

/**
 * Classify a file's first bytes. ZIP magic wins; otherwise it is text when there is no NUL byte,
 * under 1% of the bytes are control characters other than tab/newline/return/form-feed, and under 5%
 * of the decoded characters are U+FFFD (so a few mis-encoded lines, common in stealer logs, do not
 * disqualify a file, while a PDF, executable or image does). An empty head is `binary`: there is
 * nothing to import and nothing to learn from it.
 */
export function classifyHead(head: Buffer): SniffedKind {
  if (head.length === 0) return 'binary'
  if (
    head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  ) return 'zip'
  if (head.includes(0)) return 'binary'

  let control = 0
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control++
  if (control / head.length >= 0.01) return 'binary'

  const decoded = head.toString('utf8')
  let replacement = 0
  for (const ch of decoded) if (ch === '\uFFFD') replacement++
  if (decoded.length > 0 && replacement / decoded.length >= 0.05) return 'binary'
  return 'text'
}

/**
 * Sniff a file by content. The inbox only trusts `.txt`, `.csv` and `.zip` names, but files arrive
 * from Telegram and similar sources with names like `... - 29.04.2026 - ULP PRIVATE.08`, whose
 * "extension" is a date fragment; one such 81 MB file sat in inbox/failed/ for that reason alone.
 */
export async function sniffFileKind(filePath: string): Promise<SniffedKind> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0)
    return classifyHead(buf.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
