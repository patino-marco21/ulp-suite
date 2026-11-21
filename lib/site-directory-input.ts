/**
 * The Site Directory in the parts the page (a client component), its routes and its store share (design:
 * docs/superpowers/specs/2026-11-21-site-directory-design.md). The SQLite side is lib/site-directory.ts, which a page cannot import.
 *
 * The directory keeps every site that was counted, under the host the counts name (the key the marks use), with the numbers of its last all-time
 * count and, once asked for, how its logins split into e-mail, phone, user name and other.
 */
import type { SiteCount, SiteSort, SiteSortKey } from '@/lib/site-counts-input'
import { MARK_FILTERS, type MarkFilter, type SiteMark } from '@/lib/site-marks-input'

/** Sites in one page of the list: the page asks for no more and the server never sends more. */
export const DIRECTORY_PAGE_SIZE = 200

export interface BreakdownCounts {
  email: number
  phone: number
  username: number
  other: number
}

export interface Breakdown extends BreakdownCounts {
  /** SQLite UTC text, "YYYY-MM-DD HH:MM:SS". */
  at: string
}

/** One site as the list sends it. The numbers are those of the last all-time count; null where nothing was counted. */
export interface DirectorySite {
  host: string
  first_added_at: string
  last_counted_at: string | null
  times_counted: number
  count: number | null
  host_count: number | null
  subdomain_count: number | null
  subdomains: number | null
  top_subdomains: Array<{ domain: string; count: number }>
  counted_at: string | null
  /** Why the last count of this site gave no number (too broad), for as long as the table has not changed. */
  count_error: string | null
  breakdown: Breakdown | null
  mark: SiteMark | null
}

export interface DirectoryListing {
  sites: DirectorySite[]
  /** The offset of the next page, null at the end. */
  next_offset: number | null
  /** The sites matching the search and the chip; null after the first page, which carries it. */
  total: number | null
  /** The number each chip shows for the current search; null after the first page. */
  marks: Record<MarkFilter, number> | null
  /** When the refresh last finished in this process (ISO), null if it has not. The page offers a reload when it moves. */
  refreshed_at: string | null
}

export interface DirectoryStatus {
  total: number
  out_of_date: number
  state: 'current' | 'waiting' | 'refreshing'
  refreshed_at: string | null
}

export interface DirectoryQuery {
  sort: SiteSort | null
  q: string
  mark: MarkFilter
  /** One exact host (the page re-reads a single row with it). */
  host: string | null
  offset: number
  limit: number
}

const SORT_KEYS: readonly SiteSortKey[] = ['count', 'host_count', 'subdomain_count', 'subdomains', 'mark']
const MAX_SEARCH_LENGTH = 253

/** The list query a request asks for. Whatever it does not know falls back to the default, so a stale bookmark still shows a list. */
export function directoryQueryFromParams(sp: URLSearchParams): DirectoryQuery {
  const key = sp.get('sort')
  const sort: SiteSort | null = SORT_KEYS.includes(key as SiteSortKey)
    ? { key: key as SiteSortKey, direction: sp.get('dir') === 'asc' ? 'asc' : 'desc' }
    : null
  const mark = sp.get('mark') ?? 'all'
  const asked = Math.floor(Number(sp.get('limit')))
  const host = (sp.get('host') ?? '').trim()
  return {
    sort,
    q: (sp.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    mark: (MARK_FILTERS as readonly string[]).includes(mark) ? (mark as MarkFilter) : 'all',
    host: host === '' ? null : host,
    offset: Math.max(0, Math.floor(Number(sp.get('offset'))) || 0),
    limit: asked > 0 ? Math.min(asked, DIRECTORY_PAGE_SIZE) : DIRECTORY_PAGE_SIZE,
  }
}

/** The query string of a list request: what directoryQueryFromParams reads. Empty fields are left out. */
export function directoryParams(query: { sort: SiteSort | null; q: string; mark: MarkFilter; host?: string; offset?: number; limit?: number }): URLSearchParams {
  const ps = new URLSearchParams()
  if (query.sort) {
    ps.set('sort', query.sort.key)
    ps.set('dir', query.sort.direction)
  }
  if (query.q) ps.set('q', query.q)
  if (query.mark !== 'all') ps.set('mark', query.mark)
  if (query.host) ps.set('host', query.host)
  if (query.offset) ps.set('offset', String(query.offset))
  if (query.limit) ps.set('limit', String(query.limit))
  return ps
}

export const BREAKDOWN_PARTS = [
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Phone' },
  { key: 'username', label: 'User name' },
  { key: 'other', label: 'Other' },
] as const

export const breakdownTotal = (b: BreakdownCounts): number => b.email + b.phone + b.username + b.other

/** A share as text: one decimal, no trailing zero, and "<0.1%" for a part too small to round to a tenth. */
export function formatShare(percent: number): string {
  if (percent <= 0) return '0%'
  if (percent < 0.1) return '<0.1%'
  return `${Math.round(percent * 10) / 10}%`
}

export interface BreakdownShare {
  key: (typeof BREAKDOWN_PARTS)[number]['key']
  label: string
  count: number
  percent: number
  text: string
}

export function breakdownShares(b: BreakdownCounts): BreakdownShare[] {
  const total = breakdownTotal(b)
  return BREAKDOWN_PARTS.map(({ key, label }) => {
    const percent = total === 0 ? 0 : (b[key] / total) * 100
    return { key, label, count: b[key], percent, text: formatShare(percent) }
  })
}

/** A stored site as the Site Counts row shows a count, so the one row component serves both pages. */
export function directoryResult(site: DirectorySite): SiteCount {
  return {
    host: site.host,
    found: (site.count ?? 0) > 0,
    count: site.count,
    host_count: site.host_count,
    subdomain_count: site.subdomain_count,
    subdomains: site.subdomains,
    top_subdomains: site.top_subdomains,
    ...(site.count_error ? { error: site.count_error } : {}),
  }
}

/** Opening a row works the split out when there is none, unless the site is known to have no rows. */
export function needsBreakdown(site: DirectorySite): boolean {
  return site.breakdown === null && site.count !== 0
}

/** A sentence when the split was made over another number of rows than the site has now; null when they agree or either is unknown. */
export function breakdownNote(site: DirectorySite): string | null {
  if (!site.breakdown || site.count === null) return null
  const was = breakdownTotal(site.breakdown)
  return was === site.count ? null : `Worked out over ${was.toLocaleString('en-US')} rows; the site has ${site.count.toLocaleString('en-US')} now.`
}

/** The line above the list. */
export function statusLine(status: DirectoryStatus): string {
  const sites = (n: number) => `${n.toLocaleString('en-US')} site${n === 1 ? '' : 's'}`
  if (status.state === 'refreshing') return `refreshing: ${sites(status.out_of_date)} ${status.out_of_date === 1 ? 'is' : 'are'} older than the last import`
  if (status.state === 'waiting') return `waiting for imports to settle: ${sites(status.out_of_date)} will be recounted`
  return `${sites(status.total)} · numbers current`
}
