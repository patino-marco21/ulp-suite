/**
 * The Credentials list as one endless list: the next page is fetched with the cursor of the last one and joins the rows on screen
 * (docs/superpowers/specs/2026-10-28-next-page-speed-design.md). Pure helpers, so that the page and its tests decide the same way.
 *
 * The page used to swap its rows for a spinner on every page turn and ask the whole question again to go back. A page of a rare search costs 25-60 s, and
 * a user who waits that long should at least keep the rows already in front of them.
 */

/** Rows after which the list stops fetching by itself and a button continues, one page at a time: nothing virtualises the table, so the DOM grows with the rows. */
export const AUTO_LOAD_ROW_CAP = 5_000

/** The next page is fetched when the end of the rows comes within this many pixels of the bottom of the table's scroll box. */
export const LOAD_AHEAD_PX = 1_500

/** The part of a page response the list keeps and extends. */
export interface PageLike<Row> {
  results: Row[]
  next_cursor: string | null
}

/**
 * The rows on screen plus the next page. Everything else (the totals, which a cursor page does not carry, and the first page's timings) stays as it was;
 * the cursor becomes the last page's, null at the end. Returns a new object: the rows on screen are shared with React and are not modified.
 */
export function appendPage<T extends PageLike<Row>, Row = T['results'][number]>(shown: T, next: PageLike<Row>): T {
  return { ...shown, results: [...shown.results, ...next.results], next_cursor: next.next_cursor }
}

export interface ListState {
  /** Rows on screen. */
  rows: number
  /** The last page came with a cursor. */
  hasMore: boolean
  /** A search (the first page) is loading. */
  loading: boolean
  /** A later page is loading. */
  loadingMore: boolean
  /** The last later page failed or was stopped. */
  error: boolean
}

/** Whether the list fetches its next page by itself now. It never retries after an error or a stop: the user does, with the button. */
export function shouldAutoLoad(s: ListState): boolean {
  return s.hasMore && !s.loading && !s.loadingMore && !s.error && s.rows < AUTO_LOAD_ROW_CAP
}

export type ListFooter = 'loading' | 'error' | 'more' | 'capped' | 'end'

/** What the line under the rows says. */
export function listFooter(s: ListState): ListFooter {
  if (s.loadingMore) return 'loading'
  if (s.error) return 'error'
  if (!s.hasMore) return 'end'
  return s.rows >= AUTO_LOAD_ROW_CAP ? 'capped' : 'more'
}

/**
 * The element an IntersectionObserver must measure the end of the list against: the nearest ancestor that REALLY scrolls (an overflow of auto or scroll AND more
 * content than room), or null, which means the viewport. In the page's layout the table's own box has `overflow: auto` but grows with its rows (it was 141,775 px
 * tall for 3,456 rows), and the whole document scrolls; an observer rooted on that box saw the end of the list as visible all the time and fetched every page at
 * once. Where a box does scroll, it is the root.
 */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return null
}
