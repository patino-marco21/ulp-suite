/**
 * SQLite side of the ingest quality gate (lib/ingest-quality-gate.ts): the one-shot releases of held files, and the report of the newest hold of a file.
 *
 * A release is a row in gate_overrides keyed by FILE NAME. The Release route stores it before it moves the file back into the inbox; the watcher consumes it when
 * it claims that name. It is one-shot (a second import of the same name is gated again) and it expires after a day, so an old click cannot release a file that
 * comes back next month.
 */
import { dbGet, dbRun } from '@/lib/sqlite'
import type { GateReport } from '@/lib/ingest-quality-gate'

const OVERRIDE_MAX_AGE = '-1 day'

/** Stores a release. False when SQLite refused (the caller then must not move the file: it would only be held again). */
export function addGateOverride(filename: string, by: string | null): boolean {
  try {
    dbRun(`INSERT OR REPLACE INTO gate_overrides (filename, created_by) VALUES (?, ?)`, [filename, by])
    return true
  } catch (err) {
    console.error('[ingest-gate-store] could not store the release of a held file:', err instanceof Error ? err.message : err)
    return false
  }
}

export function removeGateOverride(filename: string): void {
  try {
    dbRun(`DELETE FROM gate_overrides WHERE filename = ?`, [filename])
  } catch {
    /* nothing to remove */
  }
}

/** True when an admin released this file name less than a day ago. The row is consumed. A SQLite failure answers false: the file is held again, the safe side. */
export function consumeGateOverride(filename: string): boolean {
  try {
    dbRun(`DELETE FROM gate_overrides WHERE created_at < datetime('now', ?)`, [OVERRIDE_MAX_AGE])
    return dbRun(`DELETE FROM gate_overrides WHERE filename = ?`, [filename]).changes > 0
  } catch {
    return false
  }
}

/** The report stored with the newest held job of this file name, or null. */
export function latestHeldReport(filename: string): GateReport | null {
  try {
    const row = dbGet(
      `SELECT gate_report FROM processing_jobs WHERE filename = ? AND status = 'held' AND gate_report IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [filename],
    ) as { gate_report: string } | undefined
    return row ? (JSON.parse(row.gate_report) as GateReport) : null
  } catch {
    return null
  }
}
