/**
 * Marks on the Site Counts page, in the parts the page (a client component), its marks store and the routes share (design:
 * docs/superpowers/specs/2026-10-29-site-marks-design.md). The SQLite side is lib/site-marks.ts, which a page cannot import.
 *
 * A mark is a status and a note, each optional, kept per site: the host the counts name. A change names only the fields it touches: a field left out
 * keeps its value, null clears it, and a site with neither left has no mark.
 */
import { formatRelativeTime } from '@/lib/format-relative-time'
import { SITE_COUNTS_MAX_PER_LIST, siteEntry } from '@/lib/site-counts-input'

/** The statuses, in the order the menu lists them. A fourth is one entry here and one in SITE_MARK_LABELS: the column is text, so there is no migration. */
export const SITE_MARK_STATUSES = ['done', 'skip', 'todo'] as const
export type SiteMarkStatus = (typeof SITE_MARK_STATUSES)[number]

export const SITE_MARK_LABELS: Record<SiteMarkStatus, string> = { done: 'Done', skip: 'Skip', todo: 'To look at' }

/** What a site with no status is called. Not "Clear": the list panel already has a Clear, for the pasted list. */
export const NO_MARK_LABEL = 'No mark'

/** A note is a reminder, not a document: this bounds the tooltip, the menu and the answer. */
export const SITE_MARK_NOTE_MAX = 500

/** Hosts one read may carry: a whole list, as many as the page takes. */
export const SITE_MARKS_MAX_HOSTS = SITE_COUNTS_MAX_PER_LIST

/** How much of a note the tooltip of a cell shows. */
const TITLE_NOTE_MAX = 200

/** What the server stores and answers for one site. updated_by and updated_at are null only on the page, for a change the server has not answered yet. */
export interface SiteMark {
  status: SiteMarkStatus | null
  note: string | null
  updated_by: string | null
  updated_at: string | null
}

/** A change to one site: a field left out keeps its stored value, null clears it. */
export interface SiteMarkPatch {
  status?: SiteMarkStatus | null
  note?: string | null
}

/**
 * A host the marks can be kept under: one the counts name and the cleaning leaves as it is. A row with no host (not a site address) has no mark, and
 * neither has the one shape the cleaning still changes on a second pass (three or more leading `www.`), so the page and the server can never disagree
 * about a key.
 */
export function isMarkableHost(host: string): boolean {
  return host !== '' && siteEntry(host).host === host
}

/** A note as it is stored: trimmed, and null when nothing is left. */
export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = (note ?? '').trim()
  return trimmed === '' ? null : trimmed
}

const isStatus = (value: unknown): value is SiteMarkStatus => (SITE_MARK_STATUSES as readonly unknown[]).includes(value)

export type PatchCheck = { ok: true; patch: SiteMarkPatch } | { ok: false; error: string }

/** The change a request body asks for, or why it is refused. A field that is absent (or undefined) is left out of the patch; the host is the caller's to check. */
export function checkMarkPatch(body: Record<string, unknown>): PatchCheck {
  const patch: SiteMarkPatch = {}
  const status = body.status
  if (status !== undefined) {
    if (status !== null && !isStatus(status)) return { ok: false, error: `status must be one of ${SITE_MARK_STATUSES.join(', ')}, or null` }
    patch.status = status
  }
  const rawNote = body.note
  if (rawNote !== undefined) {
    if (rawNote !== null && typeof rawNote !== 'string') return { ok: false, error: 'note must be text, or null' }
    const note = normalizeNote(rawNote)
    if (note !== null && note.length > SITE_MARK_NOTE_MAX) return { ok: false, error: `note is at most ${SITE_MARK_NOTE_MAX} characters` }
    patch.note = note
  }
  if (patch.status === undefined && patch.note === undefined) return { ok: false, error: 'Send a status, a note or both' }
  return { ok: true, patch }
}

/**
 * A site's mark after a change, or null when neither a status nor a note is left (then the site has no mark and a stored row is deleted). The server
 * writes this and the page shows it before the server has answered, so the two cannot drift apart.
 */
export function mergeMark(
  current: { status: SiteMarkStatus | null; note: string | null } | null,
  patch: SiteMarkPatch,
): { status: SiteMarkStatus | null; note: string | null } | null {
  const status = patch.status !== undefined ? patch.status : (current?.status ?? null)
  const note = patch.note !== undefined ? normalizeNote(patch.note) : (current?.note ?? null)
  return status === null && note === null ? null : { status, note }
}

/**
 * What the table knows about a row's mark: its status, 'none' (it can be marked and has no status), or null (it cannot show one: it has no host, or the
 * marks are not loaded). null is never read as 'none': that would let a person save over a note they cannot see.
 */
export type MarkState = SiteMarkStatus | 'none' | null

export function markStateOf(host: string, marks: Readonly<Record<string, SiteMark>>, loaded: boolean): MarkState {
  if (!loaded || !isMarkableHost(host)) return null
  return marks[host]?.status ?? 'none'
}

/** The order of the Mark column, biggest first (the first click): To look at, then No mark, then Done, then Skip. null: the row goes last whichever way. */
const RANK: Record<SiteMarkStatus | 'none', number> = { todo: 3, none: 2, done: 1, skip: 0 }

export function markRank(state: MarkState): number | null {
  return state === null ? null : RANK[state]
}

export type MarkFilter = 'all' | SiteMarkStatus | 'none'

export const MARK_FILTERS: readonly MarkFilter[] = ['all', ...SITE_MARK_STATUSES, 'none']

export const MARK_FILTER_LABELS: Record<MarkFilter, string> = { all: 'All', ...SITE_MARK_LABELS, none: NO_MARK_LABEL }

/** All shows every row, one that cannot show a mark included; the others show the rows of that state only. */
export function matchesMarkFilter(state: MarkState, filter: MarkFilter): boolean {
  return filter === 'all' || state === filter
}

/** How many rows each chip would show. */
export function markFilterCounts(states: MarkState[]): Record<MarkFilter, number> {
  const counts: Record<MarkFilter, number> = { all: states.length, done: 0, skip: 0, todo: 0, none: 0 }
  for (const state of states) if (state !== null) counts[state] += 1
  return counts
}

/** The tooltip of a cell: the label, the note (its first 200 characters), then who set it and when. */
export function markTitle(mark: SiteMark | null): string {
  const lines = [mark?.status ? SITE_MARK_LABELS[mark.status] : NO_MARK_LABEL]
  if (mark?.note) lines.push(mark.note.length > TITLE_NOTE_MAX ? `${mark.note.slice(0, TITLE_NOTE_MAX)}…` : mark.note)
  if (mark?.updated_by && mark.updated_at) lines.push(`${mark.updated_by}, ${formatRelativeTime(mark.updated_at)}`)
  return lines.join('\n')
}

/** The accessible name of a cell: which site, what mark, and whether a note is there. */
export function markAriaLabel(host: string, mark: SiteMark | null): string {
  const label = mark?.status ? SITE_MARK_LABELS[mark.status] : NO_MARK_LABEL
  return `Mark for ${host}: ${label}${mark?.note ? ', has a note' : ''}`
}
