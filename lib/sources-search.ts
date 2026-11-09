/**
 * Search of the Sources page (docs/superpowers/specs/2026-11-08-sources-search-design.md): "has a file with this name been ingested or processed?". The answer
 * comes from two places, because ulp.sources is not the whole story: the job log also knows files processed before the ledger existed, files the quality gate held
 * and files whose import failed. This module is pure; app/api/sources/route.ts reads the two sources and hands the rows here.
 */

export type SourceStatus = 'ingested' | 'processed' | 'held' | 'failed'

export interface SourceHit {
  filename: string
  status: SourceStatus
  /** Bytes, 0 when not recorded (older ledger rows, job-log-only names). */
  size: number
  line_count: number
  /** "YYYY-MM-DD HH:MM:SS", UTC (ClickHouse and SQLite both write it that way); utcDate() reads it. */
  imported_at: string
  /** Never filled while searching (the per-name credential count scans ulp.credentials); present so a hit fits the list's row type. */
  cred_count: number
}

export interface SourceRowInput { filename: string; line_count: number | string; size_bytes: number | string; last_imported: string }
export interface JobRowInput { id: number | string; filename: string; status: string; imported: number | string; created_at: string }

export const MIN_QUERY_LENGTH = 2
export const MAX_QUERY_LENGTH = 200

/** The query to search for, or null when the list should be shown (nothing typed, or under 2 characters). */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? '').trim().slice(0, MAX_QUERY_LENGTH).trim()
  return q.length >= MIN_QUERY_LENGTH ? q : null
}

/** Case-insensitive "contains"; every character, % and _ included, stands for itself. */
export function matchesName(filename: string, query: string): boolean {
  return filename.toLowerCase().includes(query.toLowerCase())
}

const ARCHIVE_REF = '.archiveref'

/**
 * Merges the rows for `query`. Per name: a ulp.sources row (Ingested) beats a finished job (Processed earlier) beats the latest unfinished job (Held or Failed). A job named
 * like an archive reference stands for the file it points at (lib/ledger-export.ts does the same). Newest first.
 */
export function mergeHits(sources: SourceRowInput[], jobs: JobRowInput[], query: string): SourceHit[] {
  const hits = new Map<string, SourceHit>()
  for (const s of sources) {
    hits.set(s.filename, {
      filename: s.filename, status: 'ingested', size: Number(s.size_bytes) || 0, line_count: Number(s.line_count) || 0, imported_at: String(s.last_imported), cred_count: 0,
    })
  }

  const byName = new Map<string, JobRowInput[]>()
  for (const j of jobs) {
    const name = j.filename.endsWith(ARCHIVE_REF) ? j.filename.slice(0, -ARCHIVE_REF.length) : j.filename
    if (hits.has(name) || !matchesName(name, query)) continue
    const rows = byName.get(name) ?? []
    rows.push(j)
    byName.set(name, rows)
  }
  for (const [name, rows] of byName) {
    const done = rows.filter(r => r.status === 'done')
    if (done.length > 0) {
      hits.set(name, {
        filename: name, status: 'processed', size: 0, line_count: done.reduce((n, r) => n + (Number(r.imported) || 0), 0),
        imported_at: done.map(r => r.created_at).sort().at(-1)!, cred_count: 0,
      })
      continue
    }
    const open = rows.filter(r => r.status === 'held' || r.status === 'failed')
    if (open.length === 0) continue
    const last = open.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a))
    hits.set(name, { filename: name, status: last.status as 'held' | 'failed', size: 0, line_count: 0, imported_at: last.created_at, cred_count: 0 })
  }

  return [...hits.values()].sort((a, b) => (a.imported_at === b.imported_at ? a.filename.localeCompare(b.filename) : a.imported_at < b.imported_at ? 1 : -1))
}

/** ClickHouse and SQLite write "YYYY-MM-DD HH:MM:SS" in UTC; `new Date()` would read that as local time. A string that already names its zone is left alone. */
export function utcDate(stamp: string): Date {
  return /[zZ]$|[+-]\d\d:?\d\d$/.test(stamp) ? new Date(stamp) : new Date(`${stamp.replace(' ', 'T')}Z`)
}
