/**
 * The store of the site marks, and the answers of POST and PUT /api/lookup/marks (design: docs/superpowers/specs/2026-10-29-site-marks-design.md).
 * SQLite, in the same file as the users and the monitors: a mark is small, set by hand and the owner's own. The route only checks the session and hands
 * the body here, as the counts routes do with lib/site-counts.ts. The parts a page can import are in lib/site-marks-input.ts.
 */
import { dbGet, dbQuery, dbRun, dbTransaction } from '@/lib/sqlite'
import {
  SITE_MARKS_MAX_HOSTS,
  checkMarkPatch,
  isMarkableHost,
  mergeMark,
  type SiteMark,
  type SiteMarkPatch,
  type SiteMarkStatus,
} from '@/lib/site-marks-input'

interface MarkRow {
  host: string
  status: string | null
  note: string | null
  updated_by: string | null
  updated_at: string
}

const MARK_COLUMNS = 'host, status, note, updated_by, updated_at'

const toMark = (row: MarkRow): SiteMark => ({
  status: row.status as SiteMarkStatus | null,
  note: row.note,
  updated_by: row.updated_by,
  updated_at: row.updated_at,
})

/** The marks of these hosts, only for the ones that have one, looked up exactly as given (the page sends the hosts the counts named). */
export function readSiteMarks(hosts: string[]): Record<string, SiteMark> {
  const unique = Array.from(new Set(hosts))
  const marks: Record<string, SiteMark> = {}
  if (unique.length === 0) return marks
  // One IN list: this build of SQLite takes 32,766 variables and a read carries at most SITE_MARKS_MAX_HOSTS (2,000), in about 4 ms.
  const rows = dbQuery(`SELECT ${MARK_COLUMNS} FROM site_marks WHERE host IN (${unique.map(() => '?').join(',')})`, unique) as MarkRow[]
  for (const row of rows) marks[row.host] = toMark(row)
  return marks
}

/**
 * Changes one site's mark and answers with what is stored afterwards (null when no mark is left). Only the fields of the patch change, so two people
 * changing different fields of one site both keep their change. A change that leaves the mark as it was writes nothing: the row keeps the name and the
 * time of whoever last really changed it. updated_at is SQLite's UTC text ("YYYY-MM-DD HH:MM:SS"), which lib/format-relative-time.ts reads.
 */
export function changeSiteMark(host: string, patch: SiteMarkPatch, by: string | null): SiteMark | null {
  return dbTransaction(() => {
    const stored = dbGet(`SELECT ${MARK_COLUMNS} FROM site_marks WHERE host = ?`, [host]) as MarkRow | undefined
    const next = mergeMark(stored ? { status: stored.status as SiteMarkStatus | null, note: stored.note } : null, patch)
    if (next === null) {
      if (stored) dbRun(`DELETE FROM site_marks WHERE host = ?`, [host])
      return null
    }
    if (stored && stored.status === next.status && stored.note === next.note) return toMark(stored)
    dbRun(
      `INSERT INTO site_marks (host, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(host) DO UPDATE SET status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [host, next.status, next.note, by ?? null],
    )
    return toMark(dbGet(`SELECT ${MARK_COLUMNS} FROM site_marks WHERE host = ?`, [host]) as MarkRow)
  })
}

export interface MarksReply {
  status: number
  json: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const refused = (error: string): MarksReply => ({ status: 400, json: { success: false, error } })

/** POST /api/lookup/marks: the marks of the hosts in `{ hosts: string[] }`, only for the sites that have one. */
export function answerMarksRead(rawBody: unknown): MarksReply {
  const hosts = isObject(rawBody) ? rawBody.hosts : undefined
  if (!Array.isArray(hosts) || hosts.length === 0) return refused('Provide at least one site in "hosts"')
  if (hosts.length > SITE_MARKS_MAX_HOSTS) return refused(`Too many sites (${hosts.length}). Maximum is ${SITE_MARKS_MAX_HOSTS} per request.`)
  if (!hosts.every((host): host is string => typeof host === 'string')) return refused('"hosts" must be a list of text')
  try {
    return { status: 200, json: { success: true, marks: readSiteMarks(hosts) } }
  } catch (error) {
    console.error('site marks read error:', error)
    return { status: 500, json: { success: false, error: 'Reading the marks failed' } }
  }
}

/** PUT /api/lookup/marks: `{ host, status?, note? }` changes one site; `by` is who is asking (their e-mail address). */
export function answerMarkChange(rawBody: unknown, by: string | null): MarksReply {
  if (!isObject(rawBody)) return refused('Body must be a JSON object')
  const host = typeof rawBody.host === 'string' ? rawBody.host : ''
  if (!isMarkableHost(host)) return refused('"host" must be a site as the counts name it, for example corp.example (no scheme, path, port or www.)')
  const checked = checkMarkPatch(rawBody)
  if (!checked.ok) return refused(checked.error)
  try {
    return { status: 200, json: { success: true, host, mark: changeSiteMark(host, checked.patch, by) } }
  } catch (error) {
    console.error('site marks change error:', error)
    return { status: 500, json: { success: false, error: 'Saving the mark failed' } }
  }
}
