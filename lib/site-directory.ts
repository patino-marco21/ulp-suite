/**
 * The store of the Site Directory (design: docs/superpowers/specs/2026-11-21-site-directory-design.md). SQLite, in the same file as the users, the
 * monitors and the marks. Every Site Counts request records its sites here (lib/site-counts.ts), and the refresh tick (lib/site-directory-cron.ts)
 * recounts the ones the table has outgrown. The parts a page can import are in lib/site-directory-input.ts.
 *
 * Rules that hold everywhere below: a number that was not counted is never stored as a zero and never replaces a stored number; a count with an
 * imported window writes no numbers (so "rows" always means all time); a site is "out of date" when it has no fingerprint of its own or the one it has
 * is not the table's present one (lib/search-dictionary.ts: readLiveState).
 */
import { dbGet, dbQuery, dbRun, dbTransaction } from '@/lib/sqlite'
import { OUT_OF_TIME, type SiteCount } from '@/lib/site-counts-input'
import type { SiteMarkStatus } from '@/lib/site-marks-input'
import type { BreakdownCounts, DirectorySite } from '@/lib/site-directory-input'

const SEED_FLAG = 'site_directory_seeded'

/**
 * Adds the sites that carry a mark, once: no search history exists, and a marked site has certainly been looked at. They have no numbers; the first
 * refresh counts them. The flag keeps a site the person removed from coming back at the next start.
 */
export function seedFromMarks(): number {
  if (dbGet(`SELECT 1 AS done FROM app_settings WHERE key_name = ?`, [SEED_FLAG])) return 0
  return dbTransaction(() => {
    const added = dbRun(`INSERT OR IGNORE INTO site_directory (host, first_added_at) SELECT host, updated_at FROM site_marks`).changes
    dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, '1')`, [SEED_FLAG])
    return added
  })
}

/** One site's answer into its row: see the rules above. `fingerprint` null = the table could not be read: stored, but the site stays out of date. */
function storeCount(host: string, result: SiteCount, fingerprint: string | null): void {
  if (result.error === OUT_OF_TIME) return // the request never reached it: the next refresh counts it
  if (result.error !== undefined) {
    // too broad: keep the numbers, remember why, and do not try again until the table changes
    dbRun(`UPDATE site_directory SET count_error = ?, counted_fp = ? WHERE host = ?`, [result.error, fingerprint, host])
    return
  }
  if (result.count === null) return
  const hostOnly = result.subdomain_count === null
  if (hostOnly) {
    const stored = dbGet(`SELECT subdomain_count FROM site_directory WHERE host = ?`, [host]) as { subdomain_count: number | null } | undefined
    if (stored && stored.subdomain_count !== null) return // never replace a complete count with a host-only one
  }
  dbRun(
    `UPDATE site_directory SET row_count = ?, host_count = ?, subdomain_count = ?, subdomains = ?, top_subdomains = ?, counted_at = datetime('now'),
       counted_fp = ?, count_error = NULL WHERE host = ?`,
    [
      result.count, result.host_count, result.subdomain_count, result.subdomains, JSON.stringify(result.top_subdomains),
      hostOnly ? null : fingerprint, // a host-only count is out of date at once: the refresh gets the subdomains when the index is back
      host,
    ],
  )
}

export interface RecordInput {
  /** The answer of a count, keyed by what was pasted. */
  results: Record<string, SiteCount>
  /** The count had an imported window: it adds sites but writes no numbers. */
  windowed: boolean
  /** The fingerprint of the live table read BEFORE the counting; null when it could not be read. */
  fingerprint: string | null
}

/** Records the sites of one Site Counts request: each distinct host once, however many spellings were pasted. */
export function recordSites({ results, windowed, fingerprint }: RecordInput): void {
  const byHost = new Map<string, SiteCount>()
  for (const result of Object.values(results)) if (result.host !== '' && !byHost.has(result.host)) byHost.set(result.host, result)
  if (byHost.size === 0) return
  dbTransaction(() => {
    for (const [host, result] of byHost) {
      dbRun(
        `INSERT INTO site_directory (host, times_counted, last_counted_at) VALUES (?, 1, datetime('now'))
         ON CONFLICT(host) DO UPDATE SET times_counted = times_counted + 1, last_counted_at = datetime('now')`,
        [host],
      )
      if (!windowed) storeCount(host, result, fingerprint)
    }
  })
}

/** The refresh's write: the answers of a recount, keyed by the host that was counted. Adds no site and no request. */
export function storeCounts(results: Record<string, SiteCount>, fingerprint: string): void {
  dbTransaction(() => {
    for (const [host, result] of Object.entries(results)) storeCount(host, result, fingerprint)
  })
}

export function removeSite(host: string): boolean {
  return dbRun(`DELETE FROM site_directory WHERE host = ?`, [host]).changes > 0
}

export function siteExists(host: string): boolean {
  return dbGet(`SELECT 1 AS there FROM site_directory WHERE host = ?`, [host]) !== undefined
}

export function directoryTotal(): number {
  return (dbGet(`SELECT count(*) AS n FROM site_directory`) as { n: number }).n
}

// ── Out of date ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const COUNT_OUT_OF_DATE = `(counted_fp IS NULL OR counted_fp <> ?)`
const SPLIT_OUT_OF_DATE = `(bd_at IS NOT NULL AND (bd_fp IS NULL OR bd_fp <> ?))`
/** The biggest sites first (the ones looked at most), the ones never counted last. */
const BIGGEST_FIRST = `(row_count IS NULL), row_count DESC, host`

export function outOfDateHosts(fingerprint: string, limit: number): string[] {
  const rows = dbQuery(`SELECT host FROM site_directory WHERE ${COUNT_OUT_OF_DATE} ORDER BY ${BIGGEST_FIRST} LIMIT ?`, [fingerprint, limit]) as Array<{ host: string }>
  return rows.map(r => r.host)
}

/** Sites with a stored split that was made against another state of the table. A site with no split is never listed: the split stays on demand. */
export function breakdownTargets(fingerprint: string, limit: number): string[] {
  const rows = dbQuery(`SELECT host FROM site_directory WHERE ${SPLIT_OUT_OF_DATE} ORDER BY ${BIGGEST_FIRST} LIMIT ?`, [fingerprint, limit]) as Array<{ host: string }>
  return rows.map(r => r.host)
}

/** Sites whose count or split is out of date. */
export function staleCount(fingerprint: string): number {
  return (dbGet(`SELECT count(*) AS n FROM site_directory WHERE ${COUNT_OUT_OF_DATE} OR ${SPLIT_OUT_OF_DATE}`, [fingerprint, fingerprint]) as { n: number }).n
}

// ── The split ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function storeBreakdown(host: string, counts: BreakdownCounts, fingerprint: string | null): boolean {
  return dbRun(
    `UPDATE site_directory SET bd_email = ?, bd_phone = ?, bd_username = ?, bd_other = ?, bd_at = datetime('now'), bd_fp = ? WHERE host = ?`,
    [counts.email, counts.phone, counts.username, counts.other, fingerprint, host],
  ).changes > 0
}

/** A split that could not be refreshed keeps its numbers and is not tried again until the table changes. */
export function touchBreakdown(host: string, fingerprint: string): void {
  dbRun(`UPDATE site_directory SET bd_fp = ? WHERE host = ? AND bd_at IS NOT NULL`, [fingerprint, host])
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Row {
  host: string
  first_added_at: string
  last_counted_at: string | null
  times_counted: number
  row_count: number | null
  host_count: number | null
  subdomain_count: number | null
  subdomains: number | null
  top_subdomains: string | null
  counted_at: string | null
  count_error: string | null
  bd_email: number | null
  bd_phone: number | null
  bd_username: number | null
  bd_other: number | null
  bd_at: string | null
  mark_status: string | null
  mark_note: string | null
  mark_by: string | null
  mark_at: string | null
}

export const COLUMNS = `d.host, d.first_added_at, d.last_counted_at, d.times_counted, d.row_count, d.host_count, d.subdomain_count, d.subdomains, d.top_subdomains,
  d.counted_at, d.count_error, d.bd_email, d.bd_phone, d.bd_username, d.bd_other, d.bd_at,
  m.status AS mark_status, m.note AS mark_note, m.updated_by AS mark_by, m.updated_at AS mark_at`
export const FROM = `FROM site_directory d LEFT JOIN site_marks m ON m.host = d.host`

function parseTop(json: string | null): Array<{ domain: string; count: number }> {
  if (!json) return []
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value)) return []
    return value.filter((v): v is { domain: string; count: number } => typeof v?.domain === 'string' && typeof v?.count === 'number')
  } catch {
    return []
  }
}

export function toSite(r: Row): DirectorySite {
  return {
    host: r.host,
    first_added_at: r.first_added_at,
    last_counted_at: r.last_counted_at,
    times_counted: r.times_counted,
    count: r.row_count,
    host_count: r.host_count,
    subdomain_count: r.subdomain_count,
    subdomains: r.subdomains,
    top_subdomains: parseTop(r.top_subdomains),
    counted_at: r.counted_at,
    count_error: r.count_error,
    breakdown: r.bd_at === null
      ? null
      : { email: r.bd_email ?? 0, phone: r.bd_phone ?? 0, username: r.bd_username ?? 0, other: r.bd_other ?? 0, at: r.bd_at },
    mark: r.mark_status !== null || r.mark_note !== null
      ? { status: r.mark_status as SiteMarkStatus | null, note: r.mark_note, updated_by: r.mark_by, updated_at: r.mark_at }
      : null,
  }
}

export function getSite(host: string): DirectorySite | null {
  const [row] = dbQuery(`SELECT ${COLUMNS} ${FROM} WHERE d.host = ?`, [host]) as Row[]
  return row ? toSite(row) : null
}
