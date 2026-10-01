/**
 * Client-side state for the Credentials Browser's result count.
 *
 * On the first page the table is fetched with `skip_totals=1` and the whole-table totals with
 * `totals_only=1`, as two requests, so the rows render as soon as they are ready instead of waiting
 * for a count that scans the table (11 s for a domain-token search on 1.39B rows, against ~3 s for the
 * first page). These helpers keep the "counting..." / failed / done states in one place; they are
 * pure so they can be tested without React. See app/api/credentials/route.ts for the two modes.
 */

export interface TotalsFields {
  total: number
  raw_total?: number | null
  /** The rows are showing but the totals request has not answered yet. */
  totalPending?: boolean
  /** The totals request failed; the rows are still valid. */
  totalFailed?: boolean
}

export interface Totals {
  total: number
  raw_total: number | null
}

/** Rows arrived on a first page whose totals were requested separately. */
export function withPendingTotals<T extends TotalsFields>(page: T): T {
  return { ...page, total: 0, raw_total: null, totalPending: true, totalFailed: false }
}

/**
 * The totals request answered (or failed, `totals === null`). Leaves everything else on the page alone.
 * `prev` may be null if the page was cleared in the meantime.
 */
export function withTotals<T extends TotalsFields>(prev: T | null, totals: Totals | null): T | null {
  if (!prev) return prev
  if (!totals) return { ...prev, totalPending: false, totalFailed: true }
  return { ...prev, total: totals.total, raw_total: totals.raw_total, totalPending: false, totalFailed: false }
}

/** The totals-only request for the same search: same filters, no cursor, no rows. */
export function totalsParams(params: URLSearchParams): URLSearchParams {
  const copy = new URLSearchParams(params)
  copy.delete('cursor')
  copy.delete('skip_totals')
  copy.set('totals_only', '1')
  return copy
}

/** Parses a totals_only response, or null when it is not a usable success. */
export function parseTotals(json: unknown): Totals | null {
  if (!json || typeof json !== 'object') return null
  const j = json as { success?: unknown; total?: unknown; raw_total?: unknown }
  if (j.success !== true || typeof j.total !== 'number' || !Number.isFinite(j.total)) return null
  return { total: j.total, raw_total: typeof j.raw_total === 'number' && Number.isFinite(j.raw_total) ? j.raw_total : null }
}

/** "1,234 records", or a placeholder while counting / when the count failed. */
export function recordsLabel(page: TotalsFields): string {
  if (page.totalPending) return 'Counting…'
  if (page.totalFailed) return 'Count unavailable'
  return `${page.total.toLocaleString()} records`
}

/** The footer's count between the paging buttons. */
export function resultsLabel(page: TotalsFields | null | undefined): string {
  if (!page) return ''
  if (page.totalPending) return '…'
  if (page.totalFailed) return '—'
  return `${page.total.toLocaleString()} results`
}
