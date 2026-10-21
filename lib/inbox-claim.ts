/**
 * Filesystem-atomic claim primitives for the inbox watcher.
 *
 * The watcher's in-memory `inFlight` Set dedups within a single process, but it
 * dies on restart -- so a file sitting in inbox/ when the app restarts (mid
 * import, or imported-but-not-yet-moved) gets re-picked and re-imported,
 * producing byte-identical duplicate rows. These helpers move the dedup gate to
 * the filesystem, where a rename is atomic and survives restarts:
 *
 *   claimFileForProcessing — move inbox/X -> processing/X BEFORE reading it.
 *     A second attempt (or a fresh reconcile after restart) finds X already
 *     gone from inbox/ and refuses to import it.
 *   sweepProcessingToFailed — on startup, move anything left in processing/
 *     (interrupted mid-import) to failed/ so it is NOT silently re-imported.
 *
 * Pure fs/path only -- no app singletons -- so they are unit-testable against a
 * real temp directory.
 */

import fs from 'fs'
import path from 'path'

/**
 * Moves a file with rename(2), and finishes the move when the destination is another name of the same file.
 *
 * POSIX says rename(2) between two names of ONE file does nothing and reports success, so the source name stays. That happens when a file is kept under
 * two names (an owner who moves a held or finished file back into inbox/ with a hard link): the final move of processing/X onto held/X, done/X or failed/X
 * left X in processing/, where the next start reported it as a failed import. After the rename, a source that still exists and is the same file as the
 * destination (same device and inode, reached through a different directory entry) is removed; the data stays under the destination name.
 *
 * Throws what rename throws, ENOENT for a missing source included. Moving a file onto its own path, or onto an alias of its own path through a symlinked
 * directory, changes nothing.
 */
export function moveFile(src: string, dest: string): void {
  fs.renameSync(src, dest)
  let leftover: fs.BigIntStats
  try {
    leftover = fs.lstatSync(src, { bigint: true })
  } catch {
    return // the normal case: the source name is gone
  }
  try {
    if (fs.realpathSync(src) === fs.realpathSync(dest)) return // one directory entry reached by two paths, not a second name of the file
    const kept = fs.statSync(dest, { bigint: true })
    if (leftover.dev === kept.dev && leftover.ino === kept.ino) fs.unlinkSync(src)
  } catch (err) {
    console.warn(`[inbox] moved ${path.basename(dest)}, but could not tell whether the old name of the same file is left behind: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Atomically claim a file for processing by moving it out of the inbox into
 * `procDir`. Returns the destination path if the claim succeeded, or null if
 * the source no longer exists (already claimed/removed by another attempt).
 *
 * The rename is the single-winner gate: of two concurrent attempts (or a
 * pre-restart attempt and a post-restart reconcile), exactly one rename
 * succeeds; the other gets ENOENT and is told to skip. Any other error is
 * rethrown so the caller can route the file to failed/.
 */
export function claimFileForProcessing(srcPath: string, procDir: string): string | null {
  const dest = path.join(procDir, path.basename(srcPath))
  try {
    fs.mkdirSync(procDir, { recursive: true })
    moveFile(srcPath, dest)
    return dest
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Move any files left in `procDir` (interrupted mid-import by a crash/restart)
 * into `failDir`. Returns the basenames moved. Files are routed to failed/
 * rather than re-queued because their import may be partial -- re-importing
 * would duplicate the partial rows. The user can review and re-drop them.
 *
 * Subdirectories are ignored; individual move errors are swallowed so one bad
 * file doesn't block the rest.
 */
export function sweepProcessingToFailed(procDir: string, failDir: string): string[] {
  const swept: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(procDir, { withFileTypes: true })
  } catch {
    return swept // procDir doesn't exist yet
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      fs.mkdirSync(failDir, { recursive: true })
      moveFile(path.join(procDir, entry.name), path.join(failDir, entry.name))
      swept.push(entry.name)
    } catch {
      /* ignore individual file errors */
    }
  }
  return swept
}

/**
 * Checks whether a file's size has stopped changing over `waitMs`, as a proxy
 * for "an external writer (e.g. cp of a large file) has finished." A file
 * still being written has a size that changes between the two checks; a
 * fully-written file's size stays the same. Returns false (not stable) if the
 * file vanishes between checks — treated the same as "still changing," not as
 * an error: the caller should skip this attempt, not throw.
 */
export async function isFileSizeStable(filePath: string, waitMs: number): Promise<boolean> {
  let before: number
  try {
    before = fs.statSync(filePath).size
  } catch {
    return false
  }
  await new Promise(resolve => setTimeout(resolve, waitMs))
  try {
    const after = fs.statSync(filePath).size
    return after === before
  } catch {
    return false
  }
}
