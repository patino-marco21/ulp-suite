/**
 * What may leave inbox/done, and when (docs/superpowers/specs/2026-10-21-ingest-hardening-design.md, "done/ retention").
 *
 * The clean-up at start-up used to delete every file whose own modification date was older than 7 days. A rename keeps that date, so a file downloaded ten
 * days before it was imported was "old" the moment it landed in done/, and the next app start deleted it, archived or not. The archive
 * (scripts/archive-sources.ts) is the only other copy of a source file. A file now leaves done/ only when BOTH hold:
 *   - the job log says it was imported more than 7 days ago (the file's own date and its change time say nothing: a rename keeps the first, and every
 *     start of the container touches the second, because docker-entrypoint.sh runs chmod -R on the inbox), and
 *   - the archive holds that exact file: the same name and size in its manifest with the archive file on disk at the size the manifest records, or, for an
 *     `.archiveref`, the archive file the reference points to.
 * Everything else stays, and the start-up log says how many files and bytes wait for an archive.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ARCHIVE_REF_EXT, readArchiveRefFile } from '@/lib/archive-ref'
import { dbGet } from '@/lib/sqlite'
import { readManifest, type ManifestEntry } from '@/lib/source-archive'

export const DONE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export interface RetentionLookups {
  /** When the newest finished import of this file name ended, in ms since the epoch; null when the job log never imported it. */
  importedAt(filename: string): number | null
  /** Whether the source archive holds this exact file. */
  isArchived(filePath: string, size: number): boolean
}

export interface RetentionReport {
  /** Names removed. */
  deleted: string[]
  /** Kept: imported less than the retention ago. */
  young: number
  /** Kept: old enough, but the archive does not hold it. */
  unarchived: Array<{ name: string; size: number }>
  /** Kept: the job log has no finished import of this name. */
  unknown: number
}

/** Removes from `dir` the files that were imported more than `maxAgeMs` ago and are archived. A problem with one file never stops the others. */
export function pruneDoneFiles(dir: string, maxAgeMs: number, lookups: RetentionLookups, now = Date.now()): RetentionReport {
  const report: RetentionReport = { deleted: [], young: 0, unarchived: [], unknown: 0 }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return report // no done/ yet
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(dir, entry.name)
    try {
      let importedAt: number | null
      try {
        importedAt = lookups.importedAt(entry.name)
      } catch {
        importedAt = null
      }
      if (importedAt === null) {
        report.unknown++
        continue
      }
      if (!(importedAt < now - maxAgeMs)) {
        report.young++
        continue
      }
      const size = fs.statSync(filePath).size
      let archived: boolean
      try {
        archived = lookups.isArchived(filePath, size)
      } catch {
        archived = false
      }
      if (!archived) {
        report.unarchived.push({ name: entry.name, size })
        continue
      }
      fs.unlinkSync(filePath)
      report.deleted.push(entry.name)
    } catch {
      /* the file vanished or cannot be removed: leave it, carry on */
    }
  }
  return report
}

/** The archive file `<id>.zst` is on disk, and has `bytes` bytes when the manifest says how many. */
function archiveFileOk(archiveDir: string, id: string, bytes?: number): boolean {
  try {
    const st = fs.statSync(path.join(archiveDir, `${id}.zst`))
    return st.isFile() && (bytes === undefined || st.size === bytes)
  } catch {
    return false
  }
}

/**
 * isArchived for pruneDoneFiles. The manifest is read once, at the first file that needs it. A manifest that cannot be read means NOTHING counts as archived
 * (so nothing is deleted) and the start-up log says so.
 */
export function archiveLookup(archiveDir: string): RetentionLookups['isArchived'] {
  let byNameAndSize: Map<string, ManifestEntry> | null = null
  let unreadable = false
  const load = (): void => {
    if (byNameAndSize || unreadable) return
    try {
      const map = new Map<string, ManifestEntry>()
      for (const e of readManifest(archiveDir)) map.set(`${e.size}\0${e.name}`, e) // a later line supersedes an earlier one
      byNameAndSize = map
    } catch (err) {
      unreadable = true
      console.warn(`[inbox-watcher] cleanup: the source archive manifest in ${archiveDir} cannot be read, so no file of done/ counts as archived and none is deleted: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return (filePath, size) => {
    const name = path.basename(filePath)
    if (name.endsWith(ARCHIVE_REF_EXT)) {
      try {
        return archiveFileOk(archiveDir, readArchiveRefFile(filePath).id)
      } catch {
        return false
      }
    }
    load()
    const entry = byNameAndSize?.get(`${size}\0${name}`)
    return !!entry && archiveFileOk(archiveDir, entry.id, entry.archive_bytes)
  }
}

/** importedAt for pruneDoneFiles: the newest finished inbox import of the name in the job log (SQLite keeps UTC, 'YYYY-MM-DD HH:MM:SS'). */
export function importedAtFromJobLog(): RetentionLookups['importedAt'] {
  return filename => {
    const row = dbGet(
      `SELECT MAX(created_at) AS at FROM processing_jobs WHERE source = 'inbox' AND status = 'done' AND filename = ?`,
      [filename],
    ) as { at: string | null } | undefined
    if (!row?.at) return null
    const ms = Date.parse(`${row.at.replace(' ', 'T')}Z`)
    return Number.isFinite(ms) ? ms : null
  }
}
