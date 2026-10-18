/**
 * What the last completed, non-applying content-dedup stats pass saw, kept in SQLite (app_settings) so an app restart does not cost another pass.
 *
 * The stats pass is a full GROUP BY over every content key (measured 2026-10-13 at 1.84B rows: about 80 s, 11.5 GiB of RAM, 13.8 GiB spilled to temp
 * disk). lib/content-dedup.ts skips it while the table's row count is unchanged, because duplicates can only appear through inserts. That memory used
 * to live only in the process, so the first 04:00 UTC tick after every deploy paid for the pass again even though nothing had been imported.
 *
 * Everything here fails safe: a missing, damaged or implausible marker reads as "nothing", which only costs one pass, and a marker that cannot be
 * written is ignored for the same reason.
 */
import { dbGet, dbRun } from '@/lib/sqlite'

export interface StatsMarker {
  /** Rows across the active parts of ulp.credentials when the pass started. */
  rows: number
  /** What the pass counted. */
  total: number
  excess: number
  /** Epoch milliseconds when the pass finished. */
  at: number
}

export const STATS_MARKER_KEY = 'dedup_last_stats_pass'

/** A marker stamped this far ahead of the clock is treated as damaged. A wider gap would skip every pass until that moment. */
const CLOCK_SKEW_MS = 60_000

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Strict: anything that is not exactly what saveStatsMarker writes is null. */
export function parseStatsMarker(raw: unknown, now: number = Date.now()): StatsMarker | null {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const m = parsed as Record<string, unknown>
  if (!count(m.rows) || !count(m.total) || !count(m.excess) || !count(m.at)) return null
  if (m.at > now + CLOCK_SKEW_MS) return null
  return { rows: m.rows, total: m.total, excess: m.excess, at: m.at }
}

export function loadStatsMarker(now: number = Date.now()): StatsMarker | null {
  try {
    const row = dbGet(`SELECT value FROM app_settings WHERE key_name = ?`, [STATS_MARKER_KEY]) as { value: string } | undefined
    return parseStatsMarker(row?.value, now)
  } catch {
    return null
  }
}

export function saveStatsMarker(marker: StatsMarker): void {
  try {
    dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, ?)`, [STATS_MARKER_KEY, JSON.stringify(marker)])
  } catch {
    // best effort: a marker that was not stored costs one pass after the next restart
  }
}

export function clearStatsMarker(): void {
  try {
    dbRun(`DELETE FROM app_settings WHERE key_name = ?`, [STATS_MARKER_KEY])
  } catch {
    // best effort
  }
}
