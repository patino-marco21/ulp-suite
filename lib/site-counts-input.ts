/**
 * What a person pastes into the site counts, and what comes back, in the parts the page (a client component) and the routes share (design:
 * docs/superpowers/specs/2026-10-26-site-counts-design.md). The SQL and the counting are in lib/site-counts.ts, which talks to ClickHouse and so
 * cannot be imported by a page.
 *
 * A count is for a SITE: the host an entry stands for and every subdomain of it. The entry is cleaned with the same cut the lookups use
 * (domainEntry, lib/batch-input.ts: a URL, a `www.` host, `host:port`, quotes and padding all become the bare host the table stores), and the
 * path of an entry is dropped: `domain` holds hosts, and a page of a site is not a column.
 */
import { domainEntry } from '@/lib/batch-input'
import { csvCell } from '@/lib/csv-safe'

/** Sites one request may carry (the API). Counting is by 20 at a time inside it: see lib/site-counts.ts. */
export const SITE_COUNTS_MAX_PER_REQUEST = 100

/** Sites per request the page sends: it cuts a longer list into requests so it can show progress, and one slow site delays only its own request. */
export const SITE_COUNTS_REQUEST_SIZE = 20

/** Sites the page takes in one list (a hundred requests of 20 at about a second each in the worst case). */
export const SITE_COUNTS_MAX_PER_LIST = 2000

/** The longest name a host can have (RFC 1035); a longer entry is text that is not a site. */
const MAX_HOST_LENGTH = 253

export const NOT_A_SITE = 'not a site address'

export interface SiteEntry {
  /** The string as pasted: the key of the answer. */
  original: string
  /** The host that is counted ('' when the entry is not a site address). */
  host: string
  error?: string
}

/**
 * The count for one entry. `count` is the rows under the site: on the host itself (with its `www.` spelling, which a few thousand older rows keep)
 * plus on subdomains. A number is null when it was not counted: `error` says why for the whole entry, and the subdomain numbers alone are null when
 * only the host could be counted (the answer then says `subdomains_counted: false`).
 */
export interface SiteCount {
  host: string
  found: boolean
  count: number | null
  host_count: number | null
  subdomain_count: number | null
  /** How many different subdomains of the site the rows are under. */
  subdomains: number | null
  /** The subdomains with the most rows, most first. */
  top_subdomains: Array<{ domain: string; count: number }>
  /** What was counted, when it is not what was pasted: a URL's host, the site under a `*.` wildcard. */
  searched_as?: string
  error?: string
}

/**
 * The host to count for a pasted entry. A leading `*.` or `.` (how a site and its subdomains are written in a cookie or a certificate) and a `www.`
 * are not part of the site. Text with no host, a name with no dot (`localhost`, a top-level name: it would count every site under it) or one longer
 * than a host can be is not a site address.
 */
export function siteEntry(original: string): SiteEntry {
  const host = domainEntry(original).host.replace(/^(\*?\.)+/, '').replace(/^www\./, '')
  if (host === '' || !host.includes('.') || host.length > MAX_HOST_LENGTH) return { original, host: '', error: NOT_A_SITE }
  return { original, host }
}

export interface SitePlan {
  /** One per pasted entry, in order. */
  entries: SiteEntry[]
  /** The distinct hosts to count, in the order they first appear. */
  hosts: string[]
}

export function planSites(entries: string[]): SitePlan {
  const planned = entries.map(siteEntry)
  return { entries: planned, hosts: Array.from(new Set(planned.filter(e => e.host !== '').map(e => e.host))) }
}

/** `items` cut into runs of at most `size`, in order (a size below one is one item per run). */
export function splitRequests<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size))
  const runs: T[][] = []
  for (let i = 0; i < items.length; i += step) runs.push(items.slice(i, i + step))
  return runs
}

const CSV_HEADER = 'site,counted_as,rows,on_host,on_subdomains,subdomains,top_subdomains,note'

/** A number as a cell: empty when it was not counted, so a blank is never read as a zero. */
const numberCell = (n: number | null) => (n === null ? '' : String(n))

/** The counts as a file: one line per site in the order given, the top subdomains in one cell. */
export function siteCountsCsv(rows: Array<{ site: string; result: SiteCount }>): string {
  const lines = rows.map(({ site, result }) => [
    csvCell(site),
    csvCell(result.host),
    numberCell(result.count),
    numberCell(result.host_count),
    numberCell(result.subdomain_count),
    numberCell(result.subdomains),
    csvCell(result.top_subdomains.map(s => `${s.domain} (${s.count})`).join('; ')),
    csvCell(result.error ?? ''),
  ].join(','))
  return [CSV_HEADER, ...lines].join('\n')
}
