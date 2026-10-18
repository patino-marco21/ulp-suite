/**
 * The imported window as the operator sees it: presets in the browser's time zone, the text of the pill and of the sentence under the
 * results, the page address, and the "View what this added" link of an import job. Pure (no React, no `window`, no server module), so the
 * browser bundle can import it and the tests drive it with injected time zones.
 *
 * Design: docs/superpowers/specs/2026-10-18-imported-window-ux-design.md. The semantics are the API's (lib/imported-range.ts, which this file
 * must not import: it pulls in the ClickHouse client): `imported_after` is EXCLUSIVE, `imported_before` INCLUSIVE, both UTC instants to the
 * second; a bare date includes its whole UTC day on its own side. A test pins this file's address reader to that parser.
 */
import { epochSecondsToIso, utcEpochToLocalInput, utcIsoToDisplay } from '@/lib/imported-range-client'

/** Minutes the local clock is BEHIND UTC at an instant (`new Date(ms).getTimezoneOffset()`: 300 for UTC-5). Injected so tests do not depend on the machine. */
export type OffsetAt = (epochMs: number) => number
export const browserOffsetAt: OffsetAt = ms => new Date(ms).getTimezoneOffset()

/** Epoch seconds. `lower` is EXCLUSIVE, `upper` INCLUSIVE; null leaves that side open. */
export interface WindowEpochs {
  lower: number | null
  upper: number | null
}

export type PresetKey = 'today' | 'yesterday' | 'last-24h' | 'last-7d' | 'last-30d'
/** What can have produced the window on screen: a preset of the popover, or the page's own "Since last export". */
export type WindowSource = PresetKey | 'since-last-export'

export const WINDOW_PRESETS: ReadonlyArray<{ key: PresetKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last-24h', label: 'Last 24 h' },
  { key: 'last-7d', label: 'Last 7 days' },
  { key: 'last-30d', label: 'Last 30 days' },
]

const SOURCE_SHORT: Record<WindowSource, string> = {
  today: 'today',
  yesterday: 'yesterday',
  'last-24h': 'last 24 h',
  'last-7d': 'last 7 days',
  'last-30d': 'last 30 days',
  'since-last-export': 'since last export',
}

/** ClickHouse's DateTime runs from 1970-01-01 to 2106-02-07T06:28:15Z. */
const MAX_EPOCH = 4_294_967_295
const DAY_MS = 86_400_000

/** Local midnight of the day containing the instant, as an instant (epoch ms). Right on the days the clocks change. */
export function startOfLocalDay(epochMs: number, offsetAt: OffsetAt): number {
  const wall = epochMs - offsetAt(epochMs) * 60_000 // the local wall clock, written as if it were UTC
  const midnightWall = Math.floor(wall / DAY_MS) * DAY_MS
  const first = midnightWall + offsetAt(midnightWall) * 60_000
  return midnightWall + offsetAt(first) * 60_000
}

/**
 * The window a preset stands for, at `nowMs`. The rolling presets count back from now and leave the top open. Today and Yesterday are calendar
 * days of the browser's zone; the lower bound is exclusive, so it is midnight MINUS ONE SECOND (the first second of the day stays in), and
 * Yesterday's upper bound is today's lower bound: chained windows never overlap and never leave a gap.
 */
export function presetEpochs(key: PresetKey, nowMs: number, offsetAt: OffsetAt): WindowEpochs {
  const now = Math.floor(nowMs / 1000)
  switch (key) {
    case 'last-24h': return { lower: now - 86_400, upper: null }
    case 'last-7d': return { lower: now - 7 * 86_400, upper: null }
    case 'last-30d': return { lower: now - 30 * 86_400, upper: null }
    case 'today': return { lower: startOfLocalDay(nowMs, offsetAt) / 1000 - 1, upper: null }
    case 'yesterday': {
      const today = startOfLocalDay(nowMs, offsetAt)
      const yesterday = startOfLocalDay(today - 1, offsetAt)
      return { lower: yesterday / 1000 - 1, upper: today / 1000 - 1 }
    }
  }
}

// ── local date-time text <-> instants ─────────────────────────────────────────────────────────────────────────────────────────────

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** A `datetime-local` value ("2026-10-18T11:55", seconds optional) read as local time, as epoch seconds; null for empty or impossible text. */
export function localInputToEpoch(value: string, offsetAt: OffsetAt): number | null {
  const m = LOCAL_RE.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]]
  const s = m[6] === undefined ? 0 : +m[6]
  if (h > 23 || mi > 59 || s > 59) return null
  const wall = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(wall)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  const first = wall + offsetAt(wall) * 60_000 // the offset in force near that wall time, then refined at the instant it gives
  return Math.floor((wall + offsetAt(first) * 60_000) / 1000)
}

/** A `datetime-local` value as the UTC instant the API takes (`2026-10-18T16:55:00Z`); null for empty or impossible text. */
export function localToUtcIso(value: string, offsetAt: OffsetAt = browserOffsetAt): string | null {
  const epoch = value ? localInputToEpoch(value, offsetAt) : null
  return epoch === null ? null : epochSecondsToIso(epoch)
}

/** The text the two inputs show for a window, in local time ('' for an open side). */
export function epochsToLocalInputs(w: WindowEpochs, offsetAt: OffsetAt): { after: string; before: string } {
  const text = (epoch: number | null) => (epoch === null ? '' : utcEpochToLocalInput(epoch, offsetAt(epoch * 1000)))
  return { after: text(w.lower), before: text(w.upper) }
}

export type WindowCheck = { ok: true } | { ok: false; reason: string }

/** Whether the two inputs make a window the API will take: real times, in range, and `before` later than `after`. */
export function checkLocalWindow(after: string, before: string, offsetAt: OffsetAt): WindowCheck {
  const read = (label: string, value: string): { ok: true; epoch: number | null } | { ok: false; reason: string } => {
    if (value.trim() === '') return { ok: true, epoch: null }
    const epoch = localInputToEpoch(value, offsetAt)
    if (epoch === null) return { ok: false, reason: `${label} is not a date and time` }
    if (epoch < 0 || epoch > MAX_EPOCH) return { ok: false, reason: `${label} is outside 1970-01-01 to 2106-02-07` }
    return { ok: true, epoch }
  }
  const a = read('Imported after', after)
  if (!a.ok) return a
  const b = read('Imported before', before)
  if (!b.ok) return b
  if (a.epoch !== null && b.epoch !== null && b.epoch <= a.epoch) return { ok: false, reason: 'Imported before must be later than imported after' }
  return { ok: true }
}

// ── text ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-10-18T11:55:00` -> `Oct 18 11:55`; seconds only when they are not 00, the year only when it is not the current one. */
function shortLocal(value: string, currentYear: number): string {
  const m = LOCAL_RE.exec(value.trim())
  if (!m) return value
  const secs = m[6] !== undefined && m[6] !== '00' ? `:${m[6]}` : ''
  const year = +m[1] !== currentYear ? ` ${m[1]}` : ''
  return `${MONTHS[+m[2] - 1]} ${+m[3]}${year} ${m[4]}:${m[5]}${secs}`
}

/** What the pill says. `source` is the preset (or "since last export") that produced the window, null once the operator typed it. */
export function pillLabel(w: { after: string; before: string; preset: WindowSource | null }, currentYear: number): string {
  if (!w.after && !w.before) return 'Imported: any time'
  if (w.preset) return `Imported: ${SOURCE_SHORT[w.preset]}`
  if (w.after && w.before) return `Imported: ${shortLocal(w.after, currentYear)} → ${shortLocal(w.before, currentYear)}`
  if (w.after) return `Imported: after ${shortLocal(w.after, currentYear)}`
  return `Imported: before ${shortLocal(w.before, currentYear)}`
}

const fullLocal = (value: string) => {
  const m = LOCAL_RE.exec(value.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}` : null
}

/**
 * The sentence under the results: what is shown, in the operator's time, and the instants the server uses. null when nothing is set or the
 * fields hold no time.
 */
export function windowSentence(w: { after: string; before: string }, offsetAt: OffsetAt): { text: string; utc: string } | null {
  const side = (value: string) => {
    const local = fullLocal(value)
    const epoch = localInputToEpoch(value, offsetAt)
    return local === null || epoch === null ? null : { local, utc: utcIsoToDisplay(epochSecondsToIso(epoch)) }
  }
  const a = side(w.after)
  const b = side(w.before)
  if (a && b) return { text: `added after ${a.local} and up to ${b.local} (your time)`, utc: `${a.utc} to ${b.utc}` }
  if (a) return { text: `added after ${a.local} (your time)`, utc: a.utc }
  if (b) return { text: `added up to ${b.local} (your time)`, utc: b.utc }
  return null
}

// ── the page address ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/i

function utcEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (h > 23 || mi > 59 || s > 59) return null
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return Math.floor(ms / 1000)
}

/** The forms the API takes (lib/imported-range.ts): a date, a UTC date-time, or an ISO time with an offset. */
function parseInstant(text: string): { epoch: number; bareDate: boolean } | null {
  const date = DATE_RE.exec(text)
  if (date) {
    const epoch = utcEpoch(+date[1], +date[2], +date[3], 0, 0, 0)
    return epoch === null ? null : { epoch, bareDate: true }
  }
  const dt = DATE_TIME_RE.exec(text)
  if (!dt) return null
  let epoch = utcEpoch(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], +dt[6])
  if (epoch === null) return null
  const zone = dt[7]
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    const hh = +digits.slice(0, 2)
    const mm = +digits.slice(2, 4)
    if (hh > 23 || mm > 59) return null
    epoch -= (zone[0] === '-' ? -1 : 1) * (hh * 3600 + mm * 60)
  }
  return { epoch, bareDate: false }
}

/** One bound of the address as the epoch the API would use: null = open; `bad` when the API would refuse the text. */
function boundFromText(text: string, side: 'after' | 'before'): { epoch: number | null; bad: boolean } {
  const trimmed = text.trim()
  if (trimmed === '') return { epoch: null, bad: false }
  const instant = parseInstant(trimmed)
  if (!instant || instant.epoch < 0 || instant.epoch > MAX_EPOCH) return { epoch: null, bad: true }
  if (side === 'after') {
    const lower = instant.bareDate ? instant.epoch - 1 : instant.epoch
    return { epoch: lower < 0 ? null : lower, bad: false }
  }
  return { epoch: Math.min(MAX_EPOCH, instant.bareDate ? instant.epoch + 86_399 : instant.epoch), bad: false }
}

/**
 * The window and the file named in a page address (`?imported_after=..&imported_before=..&source_file=..`), as the values the page's inputs
 * hold. A bound the API would refuse is left open and named in `invalid`.
 */
export function readWindowFromSearch(search: string, offsetAt: OffsetAt): { after: string; before: string; sourceFile: string; invalid: string[] } {
  const sp = new URLSearchParams(search)
  const invalid: string[] = []
  const after = boundFromText(sp.get('imported_after') ?? '', 'after')
  const before = boundFromText(sp.get('imported_before') ?? '', 'before')
  if (after.bad) invalid.push('imported_after')
  if (before.bad) invalid.push('imported_before')
  const inputs = epochsToLocalInputs({ lower: after.epoch, upper: before.epoch }, offsetAt)
  return { ...inputs, sourceFile: sp.get('source_file') ?? '', invalid }
}

/**
 * The address with the three managed parameters set (or removed when empty). Everything else in it stays where it was. `afterIso` / `beforeIso`
 * are the UTC instants the API takes. Returns '?...' or ''.
 */
export function writeWindowToSearch(
  currentSearch: string,
  w: { afterIso: string | null; beforeIso: string | null; sourceFile: string | null },
): string {
  const sp = new URLSearchParams(currentSearch)
  const put = (key: string, value: string | null) => {
    if (value) sp.set(key, value)
    else sp.delete(key)
  }
  put('imported_after', w.afterIso)
  put('imported_before', w.beforeIso)
  put('source_file', w.sourceFile)
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

// ── "View what this added" ────────────────────────────────────────────────────────────────────────────────────────────────────────

const JOB_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
const PLAIN_TEXT_FILE = /\.(txt|csv)$/i

export interface JobForLink {
  filename: string
  status: string
  imported: number
  duration_ms: number
  /** processing_jobs.created_at: UTC, to the second, stamped when the job finished. */
  created_at: string
}

/**
 * The Credentials page filtered to the rows one import job added, or null when the job added none. Jobs run one at a time and stamp their
 * rows between their start and their end, so the window is (floor(end - duration) - 1 s, end + 1 s]: the log row is stamped to the second,
 * and the lower bound is exclusive. A plain .txt / .csv file also pins `source_file`, which removes any bleed from the neighbouring job; a
 * ZIP or an archive reference does not (its rows carry the inner file names).
 */
export function jobViewHref(job: JobForLink): string | null {
  if (job.status !== 'done' || !(job.imported > 0) || !Number.isFinite(job.duration_ms) || job.duration_ms < 0) return null
  const m = JOB_TIME_RE.exec(job.created_at)
  if (!m) return null
  const end = utcEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])
  if (end === null) return null
  const sp = new URLSearchParams({
    imported_after: epochSecondsToIso(Math.floor(end - job.duration_ms / 1000) - 1),
    imported_before: epochSecondsToIso(end + 1),
  })
  if (PLAIN_TEXT_FILE.test(job.filename)) sp.set('source_file', job.filename)
  return `/credentials?${sp.toString()}`
}
