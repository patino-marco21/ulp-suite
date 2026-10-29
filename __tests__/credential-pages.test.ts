import { describe, expect, test } from 'vitest'
import { AUTO_LOAD_ROW_CAP, appendPage, listFooter, shouldAutoLoad, type ListState } from '@/lib/credential-pages'

const state = (over: Partial<ListState> = {}): ListState => ({ rows: 200, hasMore: true, loading: false, loadingMore: false, error: false, ...over })

describe('appendPage — the next page joins the rows on screen', () => {
  const shown = { results: [{ id: 1 }, { id: 2 }], next_cursor: 'c1', total: 500, raw_total: 900, totalPending: false, total_ms: 4200, query_ms: 4100 }

  test('the rows follow the rows, in order, and the cursor is the last page\'s', () => {
    const out = appendPage(shown, { results: [{ id: 3 }, { id: 4 }], next_cursor: 'c2' })
    expect(out.results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    expect(out.next_cursor).toBe('c2')
  })

  test('the last page has no cursor: the list ends', () => {
    expect(appendPage(shown, { results: [{ id: 3 }], next_cursor: null }).next_cursor).toBeNull()
  })

  test('the totals and the first page\'s timings stay (a cursor page carries no total)', () => {
    const out = appendPage(shown, { results: [{ id: 3 }], next_cursor: null })
    expect(out).toMatchObject({ total: 500, raw_total: 900, totalPending: false, total_ms: 4200, query_ms: 4100 })
  })

  test('the rows on screen are not modified', () => {
    const before = JSON.stringify(shown)
    appendPage(shown, { results: [{ id: 3 }], next_cursor: 'c2' })
    expect(JSON.stringify(shown)).toBe(before)
  })
})

describe('shouldAutoLoad — when the list fetches its next page by itself', () => {
  test('there is a next page, nothing is loading, no error: yes', () => {
    expect(shouldAutoLoad(state())).toBe(true)
  })

  test('not at the end of the list', () => {
    expect(shouldAutoLoad(state({ hasMore: false }))).toBe(false)
  })

  test('not while a search or a page is loading (one request at a time)', () => {
    expect(shouldAutoLoad(state({ loading: true }))).toBe(false)
    expect(shouldAutoLoad(state({ loadingMore: true }))).toBe(false)
  })

  test('not after an error or a stop: it never retries by itself (a failing page would be asked for again and again)', () => {
    expect(shouldAutoLoad(state({ error: true }))).toBe(false)
  })

  test('not at the row cap: past it the button loads, one page at a time', () => {
    expect(shouldAutoLoad(state({ rows: AUTO_LOAD_ROW_CAP - 1 }))).toBe(true)
    expect(shouldAutoLoad(state({ rows: AUTO_LOAD_ROW_CAP }))).toBe(false)
  })
})

describe('listFooter — what the line under the rows says', () => {
  test('a page is loading', () => {
    expect(listFooter(state({ loadingMore: true }))).toBe('loading')
  })

  test('an error or a stop shows the retry, even when there is more', () => {
    expect(listFooter(state({ error: true }))).toBe('error')
  })

  test('more is coming by scrolling', () => {
    expect(listFooter(state())).toBe('more')
  })

  test('the cap asks for a click', () => {
    expect(listFooter(state({ rows: AUTO_LOAD_ROW_CAP }))).toBe('capped')
  })

  test('the end of the results', () => {
    expect(listFooter(state({ hasMore: false }))).toBe('end')
  })

  test('a page that is loading wins over an old error (the retry started it)', () => {
    expect(listFooter(state({ loadingMore: true, error: true }))).toBe('loading')
  })
})
