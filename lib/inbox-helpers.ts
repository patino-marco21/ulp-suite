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
