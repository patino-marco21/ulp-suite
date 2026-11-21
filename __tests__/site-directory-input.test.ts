import { describe, test, expect } from 'vitest'
import {
  DIRECTORY_PAGE_SIZE, breakdownNote, breakdownShares, breakdownTotal, directoryParams, directoryQueryFromParams, directoryResult, formatShare,
  needsBreakdown, statusLine, type DirectorySite,
} from '@/lib/site-directory-input'

const site = (over: Partial<DirectorySite> = {}): DirectorySite => ({
  host: 'corp.example', first_added_at: '2026-11-21 10:00:00', last_counted_at: '2026-11-21 10:00:00', times_counted: 1,
  count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, top_subdomains: [{ domain: 'app.corp.example', count: 15 }],
  counted_at: '2026-11-21 10:00:00', count_error: null, breakdown: null, mark: null, ...over,
})

describe('formatShare', () => {
  test.each([[56.3, '56.3%'], [4, '4%'], [0, '0%'], [0.04, '<0.1%'], [100, '100%'], [39.74, '39.7%']])('%s -> %s', (percent, text) => {
    expect(formatShare(percent)).toBe(text)
  })
})

describe('breakdownShares', () => {
  test('gives each part its count, its share and its label, in the order e-mail, phone, user name, other', () => {
    const shares = breakdownShares({ email: 563, phone: 40, username: 397, other: 0, at: '2026-11-21 10:00:00' })
    expect(shares.map(s => [s.key, s.label, s.count, s.text])).toEqual([
      ['email', 'E-mail', 563, '56.3%'], ['phone', 'Phone', 40, '4%'], ['username', 'User name', 397, '39.7%'], ['other', 'Other', 0, '0%'],
    ])
    expect(breakdownTotal({ email: 563, phone: 40, username: 397, other: 0, at: 'x' })).toBe(1000)
  })
  test('a split over no rows has no shares to divide by zero', () => {
    expect(breakdownShares({ email: 0, phone: 0, username: 0, other: 0, at: 'x' }).every(s => s.percent === 0 && s.text === '0%')).toBe(true)
  })
})

describe('directoryQueryFromParams / directoryParams', () => {
  test('defaults: no sort, no search, all marks, first page of 200', () => {
    expect(directoryQueryFromParams(new URLSearchParams())).toEqual({ sort: null, q: '', mark: 'all', host: null, offset: 0, limit: DIRECTORY_PAGE_SIZE })
  })
  test('reads a sort and its direction, a search, a mark chip, an exact host, an offset and a smaller limit', () => {
    const q = directoryQueryFromParams(new URLSearchParams('sort=subdomains&dir=asc&q=%20Corp%20&mark=todo&host=corp.example&offset=400&limit=7'))
    expect(q).toEqual({ sort: { key: 'subdomains', direction: 'asc' }, q: 'Corp', mark: 'todo', host: 'corp.example', offset: 400, limit: 7 })
  })
  test('refuses what it does not know: an unknown sort is the default, an unknown mark is All, a limit is capped, a negative offset is zero', () => {
    const q = directoryQueryFromParams(new URLSearchParams('sort=drop&mark=maybe&offset=-5&limit=100000'))
    expect(q).toMatchObject({ sort: null, mark: 'all', offset: 0, limit: DIRECTORY_PAGE_SIZE })
    expect(directoryQueryFromParams(new URLSearchParams('limit=abc')).limit).toBe(DIRECTORY_PAGE_SIZE)
  })
  test('the page builds what the route reads', () => {
    const sp = directoryParams({ sort: { key: 'mark', direction: 'desc' }, q: 'corp', mark: 'done', offset: 200 })
    expect(directoryQueryFromParams(sp)).toMatchObject({ sort: { key: 'mark', direction: 'desc' }, q: 'corp', mark: 'done', offset: 200 })
    expect(directoryParams({ sort: null, q: '', mark: 'all' }).toString()).toBe('')
  })
})

describe('directoryResult', () => {
  test('is the Site Counts result of a stored site, so the Site Counts row can show it', () => {
    expect(directoryResult(site())).toEqual({
      host: 'corp.example', found: true, count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, top_subdomains: [{ domain: 'app.corp.example', count: 15 }],
    })
  })
  test('a site not counted yet has no numbers and is not "found"; a stored reason shows as the row error', () => {
    const r = directoryResult(site({ count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], count_error: 'too broad to count in the time allowed' }))
    expect(r).toMatchObject({ found: false, count: null, error: 'too broad to count in the time allowed' })
    expect(directoryResult(site({ count: 0 })).found).toBe(false)
  })
})

describe('needsBreakdown / breakdownNote', () => {
  test('a split is worked out for a site without one unless the site has no rows', () => {
    expect(needsBreakdown(site())).toBe(true)
    expect(needsBreakdown(site({ count: null }))).toBe(true)
    expect(needsBreakdown(site({ count: 0 }))).toBe(false)
    expect(needsBreakdown(site({ breakdown: { email: 30, phone: 0, username: 0, other: 0, at: 'x' } }))).toBe(false)
  })
  test('says so when the split was made over another number of rows than the site has now', () => {
    const b = { email: 20, phone: 0, username: 0, other: 0, at: 'x' }
    expect(breakdownNote(site({ breakdown: b }))).toBe('Worked out over 20 rows; the site has 30 now.')
    expect(breakdownNote(site({ breakdown: { ...b, email: 30 } }))).toBeNull()
    expect(breakdownNote(site({ breakdown: b, count: null }))).toBeNull()
    expect(breakdownNote(site())).toBeNull()
  })
})

describe('statusLine', () => {
  test.each([
    [{ total: 212, out_of_date: 0, state: 'current', refreshed_at: null }, '212 sites · numbers current'],
    [{ total: 1, out_of_date: 0, state: 'current', refreshed_at: null }, '1 site · numbers current'],
    [{ total: 212, out_of_date: 37, state: 'waiting', refreshed_at: null }, 'waiting for imports to settle: 37 sites will be recounted'],
    [{ total: 212, out_of_date: 1, state: 'refreshing', refreshed_at: null }, 'refreshing: 1 site is older than the last import'],
    [{ total: 212, out_of_date: 37, state: 'refreshing', refreshed_at: null }, 'refreshing: 37 sites are older than the last import'],
  ] as const)('%j', (status, text) => {
    expect(statusLine(status)).toBe(text)
  })
})
