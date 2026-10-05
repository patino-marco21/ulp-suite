/**
 * Browser-side helpers for the imported-after filter. Pure (no React, no `window`), so they are tested directly.
 *
 *  - date-time inputs <-> the UTC instants the API takes (the server reads every bound as UTC; the operator thinks in local time);
 *  - the "since last export" memory and the chain rule that keeps it gap-free.
 *
 * Design: docs/superpowers/specs/2026-10-05-imported-after-filter-design.md ("UI", "Since last export").
 */

/**
 * Rows are stamped with `now()` when their insert block starts being processed and become visible when it commits (p95 3.6 s per 100k-row
 * block), so a cut taken "now" can fall inside a block that is still landing. Cutting this far back makes that impossible in practice.
 */
export const EXPORT_CUT_LAG_SECONDS = 120

const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** `2026-10-05T19:37:00Z` for epoch seconds. */
export function epochSecondsToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * An `<input type="datetime-local">` value ("2026-10-05T14:37", seconds optional), read as the browser's local time, as a UTC ISO instant.
 * `offsetMinutes` is `new Date(value).getTimezoneOffset()` at that moment (minutes the local clock is BEHIND UTC; 300 for UTC-5), passed in
 * so this stays pure and testable. null for an empty or impossible value.
 */
export function localInputToUtcIso(value: string, offsetMinutes: number): string | null {
  const m = LOCAL_INPUT_RE.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]]
  const s = m[6] === undefined ? 0 : +m[6]
  if (h > 23 || mi > 59 || s > 59) return null
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(asUtc)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return epochSecondsToIso(Math.floor(asUtc / 1000) + offsetMinutes * 60)
}

/** The reverse, for presets that set an input: epoch seconds as a `datetime-local` value in local time ("2026-10-05T14:37:00"). */
export function utcEpochToLocalInput(epochSeconds: number, offsetMinutes: number): string {
  return new Date((epochSeconds - offsetMinutes * 60) * 1000).toISOString().slice(0, 19)
}

/** `2026-10-05T19:37:00Z` -> `2026-10-05 19:37:00 UTC`, shown beside an input so the operator sees what the server will use. */
export function utcIsoToDisplay(iso: string): string {
  return iso.replace('T', ' ').replace('Z', ' UTC')
}

/** A short stable key for "the same search": every field that narrows the rows, none of date, sort, format or page size. */
export function searchFingerprint(fields: Record<string, string | number | boolean | string[] | null | undefined>): string {
  const parts = Object.keys(fields)
    .sort()
    .map(k => [k, fields[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
  const text = parts.join('&')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return `${hash.toString(36)}-${text.length.toString(36)}`
}

/** What the page remembers about the last complete export of one search. `through` is epoch seconds, the INCLUSIVE upper bound it covered. */
export interface ExportMark {
  through: number
  rows: number
  /** epoch milliseconds when it was recorded */
  at: number
}

export const markStorageKey = (fingerprint: string) => `ulp:last-export:${fingerprint}`

type ReadableStorage = { getItem(key: string): string | null }
type WritableStorage = { setItem(key: string, value: string): void }

/** Storage can be missing, blocked or hold junk (private windows, cleared site data): every failure is "nothing remembered". */
export function readMark(storage: ReadableStorage | null | undefined, key: string): ExportMark | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ExportMark>
    if (typeof v.through !== 'number' || !Number.isFinite(v.through) || typeof v.rows !== 'number' || typeof v.at !== 'number') return null
    return { through: v.through, rows: v.rows, at: v.at }
  } catch {
    return null
  }
}

export function writeMark(storage: WritableStorage | null | undefined, key: string, mark: ExportMark): void {
  try {
    storage?.setItem(key, JSON.stringify(mark))
  } catch {
    // The memory is a convenience: the file name of the export still records its window.
  }
}

export type SinceLastExport =
  | { ok: true; after: string; before: string }
  | { ok: false; reason: 'no-mark' | 'too-soon' }

/** The window a "Since last export" export sends: (the remembered cut, now minus the lag]. */
export function sinceLastExportWindow(mark: ExportMark | null, nowMs: number): SinceLastExport {
  if (!mark) return { ok: false, reason: 'no-mark' }
  const before = Math.floor(nowMs / 1000) - EXPORT_CUT_LAG_SECONDS
  if (before <= mark.through) return { ok: false, reason: 'too-soon' }
  return { ok: true, after: epochSecondsToIso(mark.through), before: epochSecondsToIso(before) }
}

/**
 * What to remember after an export that came back OK, or null to leave the stored mark alone. `sent` is the window the request carried
 * (epoch seconds, null = open). The chain stays gap-free because a mark is only written when:
 *  - the export was complete (a truncated one hides rows between its last row and its upper bound), and
 *  - it started at the beginning (no lower bound: it covered everything up to its cut) or exactly at the previous cut, and
 *  - the new cut does not move backwards.
 * The cut is the explicit upper bound, but never later than now minus the lag (a future or very recent bound would otherwise skip rows
 * that are still landing). A hand-typed range that starts somewhere else never moves the mark.
 */
export function markAfterExport(
  prev: ExportMark | null,
  sent: { lower: number | null; upper: number | null },
  outcome: { truncated: boolean; rows: number },
  nowMs: number,
): ExportMark | null {
  if (outcome.truncated) return null
  const chains = sent.lower === null || (prev !== null && sent.lower === prev.through)
  if (!chains) return null
  const latestSafe = Math.floor(nowMs / 1000) - EXPORT_CUT_LAG_SECONDS
  const through = sent.upper === null ? latestSafe : Math.min(sent.upper, latestSafe)
  if (prev !== null && through < prev.through) return null
  return { through, rows: outcome.rows, at: nowMs }
}

/** Presets for the lower bound, as seconds before now. */
export const IMPORTED_PRESETS = [
  { key: 'last-24h', label: 'Last 24 h', seconds: 24 * 3600 },
  { key: 'last-7d', label: 'Last 7 days', seconds: 7 * 24 * 3600 },
] as const
