import { describe, test, expect } from 'vitest'
import {
  SITE_COUNTS_MAX_PER_LIST,
  SITE_COUNTS_MAX_PER_REQUEST,
  SITE_COUNTS_REQUEST_SIZE,
  nextSiteSort,
  orderSiteRows,
  planSites,
  siteCountsCsv,
  siteEntry,
  splitRequests,
  type SiteCount,
} from '@/lib/site-counts-input'

describe('siteEntry — what is pasted becomes the host that is counted', () => {
  test.each([
    ['example.tld', 'example.tld'],
    ['  Example.TLD  ', 'example.tld'],
    ['https://www.example.tld/login?next=/a', 'example.tld'],
    ['www.example.tld', 'example.tld'],
    ['example.tld:8443', 'example.tld'],
    ['"example.tld",', 'example.tld'],
    ['example.tld/en/some/page.html', 'example.tld'],
    ['login.corp.example.tld', 'login.corp.example.tld'],
    // a wildcard says "this site and its subdomains", which is what a count is
    ['*.example.tld', 'example.tld'],
    ['*.www.example.tld', 'example.tld'],
    ['.example.tld', 'example.tld'],
  ])('%j is counted as %j', (typed, host) => {
    const entry = siteEntry(typed)
    expect(entry).toMatchObject({ original: typed, host })
    expect(entry.error).toBeUndefined()
  })

  test.each([
    ['nothing', ''],
    ['blanks', '   '],
    ['a scheme alone', 'https://'],
    ['one label', 'localhost'],
    ['a bare top-level name', 'com'],
    ['a dot', '.'],
    ['a name longer than any host', `${'a'.repeat(250)}.tld`],
  ])('%s is not a site: no host, and the reason is on the entry', (_what, typed) => {
    const entry = siteEntry(typed)
    expect(entry.host).toBe('')
    expect(entry.error).toBe('not a site address')
  })

  test('the path of an entry is dropped, not matched: a count is for the site', () => {
    expect(siteEntry('example.tld/a/very/specific/page.html').host).toBe('example.tld')
  })
})

describe('planSites', () => {
  test('every entry keeps its place; the hosts to count are distinct, in the order first seen', () => {
    const plan = planSites([
      'https://www.b.example.tld/x',
      'a.example.tld',
      'B.example.tld',
      'not a site',
      'a.example.tld/other',
    ])
    expect(plan.entries.map(e => e.original)).toEqual([
      'https://www.b.example.tld/x', 'a.example.tld', 'B.example.tld', 'not a site', 'a.example.tld/other',
    ])
    expect(plan.hosts).toEqual(['b.example.tld', 'a.example.tld'])
  })

  test('nothing usable gives no host to count', () => {
    expect(planSites(['', 'localhost']).hosts).toEqual([])
  })
})

describe('splitRequests', () => {
  test('cuts a list into requests of at most the given size, in order', () => {
    expect(splitRequests([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(splitRequests([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
    expect(splitRequests([], 3)).toEqual([])
  })

  test('a size below one is one entry per request, not an endless loop', () => {
    expect(splitRequests([1, 2], 0)).toEqual([[1], [2]])
  })
})

describe('orderSiteRows and nextSiteSort — the table sorted by a clicked column', () => {
  const counted = (host: string, count: number, hostCount: number, subdomainCount: number, subdomains: number): SiteCount => ({
    host, found: count > 0, count, host_count: hostCount, subdomain_count: subdomainCount, subdomains, top_subdomains: [],
  })
  const notCounted = (host: string): SiteCount => ({
    host, found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], error: 'not a site address',
  })
  // Only the host could be counted (the reversed-domain key was missing): the subdomain numbers are null, the rest is real.
  const hostOnly = (host: string, count: number): SiteCount => ({
    host, found: count > 0, count, host_count: count, subdomain_count: null, subdomains: null, top_subdomains: [],
  })
  const row = (site: string, result: SiteCount) => ({ site, result })
  const names = (rows: Array<{ site: string }>) => rows.map(r => r.site)

  // In the order they were pasted. rows / on the site / on subdomains / how many subdomains:
  const pasted = [
    row('small', counted('small.tld', 10, 10, 0, 0)),
    row('quiet', counted('quiet.tld', 0, 0, 0, 0)),
    row('broken', notCounted('broken.tld')),
    row('spread', counted('spread.tld', 50, 5, 45, 9)),
    row('huge', counted('huge.tld', 100, 100, 0, 0)),
    row('deep', counted('deep.tld', 70, 20, 50, 2)),
  ]

  test('with no sort chosen: what needs attention first, then the most rows, then the sites with none', () => {
    expect(names(orderSiteRows(pasted, null))).toEqual(['broken', 'huge', 'deep', 'spread', 'small', 'quiet'])
  })

  test('a column sorts biggest first, and smallest first the other way', () => {
    expect(names(orderSiteRows(pasted, { key: 'count', direction: 'desc' }))).toEqual(['huge', 'deep', 'spread', 'small', 'quiet', 'broken'])
    expect(names(orderSiteRows(pasted, { key: 'count', direction: 'asc' }))).toEqual(['quiet', 'small', 'spread', 'deep', 'huge', 'broken'])
    expect(names(orderSiteRows(pasted, { key: 'host_count', direction: 'desc' }))).toEqual(['huge', 'deep', 'small', 'spread', 'quiet', 'broken'])
    expect(names(orderSiteRows(pasted, { key: 'host_count', direction: 'asc' }))).toEqual(['quiet', 'spread', 'small', 'deep', 'huge', 'broken'])
    expect(names(orderSiteRows(pasted, { key: 'subdomains', direction: 'desc' }))).toEqual(['spread', 'deep', 'huge', 'small', 'quiet', 'broken'])
  })

  test('sites that tie keep the default order (the most rows first), whichever way the column goes', () => {
    // huge, small and quiet all have 0 rows on subdomains
    expect(names(orderSiteRows(pasted, { key: 'subdomain_count', direction: 'desc' }))).toEqual(['deep', 'spread', 'huge', 'small', 'quiet', 'broken'])
    expect(names(orderSiteRows(pasted, { key: 'subdomain_count', direction: 'asc' }))).toEqual(['huge', 'small', 'quiet', 'spread', 'deep', 'broken'])
  })

  test('a site with no number for the column goes last both ways, and is never taken for a zero', () => {
    const withHostOnly = [...pasted, row('hosty', hostOnly('hosty.tld', 30))]
    // not counted at all, then host-only (both have no subdomain number), after every real number
    expect(names(orderSiteRows(withHostOnly, { key: 'subdomain_count', direction: 'desc' })))
      .toEqual(['deep', 'spread', 'huge', 'small', 'quiet', 'broken', 'hosty'])
    expect(names(orderSiteRows(withHostOnly, { key: 'subdomain_count', direction: 'asc' })))
      .toEqual(['huge', 'small', 'quiet', 'spread', 'deep', 'broken', 'hosty'])
    // the host-only site does have rows and an on-the-site number, so there it sorts like any other
    expect(names(orderSiteRows(withHostOnly, { key: 'count', direction: 'desc' })))
      .toEqual(['huge', 'deep', 'spread', 'hosty', 'small', 'quiet', 'broken'])
    expect(names(orderSiteRows(withHostOnly, { key: 'host_count', direction: 'asc' })))
      .toEqual(['quiet', 'spread', 'small', 'deep', 'hosty', 'huge', 'broken'])
  })

  test('returns a new list and leaves the one it was given as it was', () => {
    const before = names(pasted)
    const sorted = orderSiteRows(pasted, { key: 'count', direction: 'desc' })
    expect(sorted).not.toBe(pasted)
    expect(names(pasted)).toEqual(before)
    expect(orderSiteRows(pasted, null)).not.toBe(pasted)
  })

  test('the same rows come back, none lost or doubled', () => {
    for (const key of ['count', 'host_count', 'subdomain_count', 'subdomains'] as const) {
      for (const direction of ['desc', 'asc'] as const) {
        expect(names(orderSiteRows(pasted, { key, direction })).sort()).toEqual(names(pasted).sort())
      }
    }
  })

  test('an empty list stays empty', () => {
    expect(orderSiteRows([], { key: 'count', direction: 'desc' })).toEqual([])
    expect(orderSiteRows([], null)).toEqual([])
  })

  test('a first click sorts biggest first, a second reverses it, a third goes back to the default order', () => {
    const first = nextSiteSort(null, 'host_count')
    expect(first).toEqual({ key: 'host_count', direction: 'desc' })
    const second = nextSiteSort(first, 'host_count')
    expect(second).toEqual({ key: 'host_count', direction: 'asc' })
    expect(nextSiteSort(second, 'host_count')).toBeNull()
  })

  test('a click on another column starts that column over, biggest first', () => {
    expect(nextSiteSort({ key: 'count', direction: 'asc' }, 'subdomains')).toEqual({ key: 'subdomains', direction: 'desc' })
    expect(nextSiteSort({ key: 'count', direction: 'desc' }, 'subdomain_count')).toEqual({ key: 'subdomain_count', direction: 'desc' })
  })
})

describe('limits', () => {
  test('the page sends requests the API accepts, and takes a list of many requests', () => {
    expect(SITE_COUNTS_REQUEST_SIZE).toBeLessThanOrEqual(SITE_COUNTS_MAX_PER_REQUEST)
    expect(SITE_COUNTS_MAX_PER_LIST).toBeGreaterThan(SITE_COUNTS_MAX_PER_REQUEST)
  })
})

describe('siteCountsCsv', () => {
  const found: SiteCount = {
    host: 'example.tld', found: true, count: 150, host_count: 30, subdomain_count: 120, subdomains: 3,
    top_subdomains: [{ domain: 'login.example.tld', count: 100 }, { domain: 'app.example.tld', count: 15 }],
  }
  const none: SiteCount = {
    host: 'quiet.tld', found: false, count: 0, host_count: 0, subdomain_count: 0, subdomains: 0, top_subdomains: [],
  }
  const failed: SiteCount = {
    host: 'huge.tld', found: false, count: null, host_count: null, subdomain_count: null, subdomains: null,
    top_subdomains: [], error: 'too broad to count in the time allowed',
  }

  test('one line per site with the header first; the top subdomains are one cell', () => {
    const csv = siteCountsCsv([
      { site: 'https://www.example.tld/login', result: { ...found, searched_as: 'example.tld' } },
      { site: 'quiet.tld', result: none },
    ])
    expect(csv.split('\n')).toEqual([
      'site,counted_as,rows,on_host,on_subdomains,subdomains,top_subdomains,note',
      '"https://www.example.tld/login","example.tld",150,30,120,3,"login.example.tld (100); app.example.tld (15)",""',
      '"quiet.tld","quiet.tld",0,0,0,0,"",""',
    ])
  })

  test('a site that could not be counted has empty numbers and says why, so a blank is never read as zero', () => {
    const csv = siteCountsCsv([{ site: 'huge.tld', result: failed }])
    expect(csv.split('\n')[1]).toBe('"huge.tld","huge.tld",,,,,"","too broad to count in the time allowed"')
  })

  test('subdomains that were not counted (null) are empty cells, the host counts stay', () => {
    const hostOnly: SiteCount = { ...found, subdomain_count: null, subdomains: null, top_subdomains: [], count: 30 }
    expect(siteCountsCsv([{ site: 'example.tld', result: hostOnly }]).split('\n')[1])
      .toBe('"example.tld","example.tld",30,30,,,"",""')
  })

  test('a site written as a spreadsheet formula is text in the file', () => {
    const csv = siteCountsCsv([{ site: '=HYPERLINK("http://x.tld")', result: { ...none, host: 'x.tld' } }])
    expect(csv.split('\n')[1].startsWith(`"'=HYPERLINK(""http://x.tld"")"`)).toBe(true)
  })
})

describe('orderSiteRows — the Mark column', () => {
  const counted = (host: string, count: number): SiteCount => ({
    host, found: count > 0, count, host_count: count, subdomain_count: 0, subdomains: 0, top_subdomains: [],
  })
  const row = (site: string, count: number) => ({ site, result: counted(`${site}.tld`, count) })
  const names = (rows: Array<{ site: string }>) => rows.map(r => r.site)

  // In the order pasted, with the rank the page gives each row's mark: 3 to look at, 2 no mark, 1 done, 0 skip, null cannot show a mark.
  const pasted = [row('a', 10), row('b', 50), row('c', 30), row('d', 20), row('e', 40), row('f', 5)]
  const ranks: Record<string, number | null> = { a: 1, b: 3, c: 2, d: null, e: 3, f: 0 }
  const rankOf = (r: { site: string }) => ranks[r.site]

  test('the first click puts what is left to look at on top; rows that tie keep the default order, the most rows first', () => {
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'desc' }, rankOf))).toEqual(['b', 'e', 'c', 'a', 'f', 'd'])
  })

  test('the other way reverses the ranks, and a row that cannot show a mark is last both ways, never taken for a rank', () => {
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'asc' }, rankOf))).toEqual(['f', 'a', 'c', 'b', 'e', 'd'])
  })

  test('without a rank function every row ties, so the default order stands', () => {
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'desc' }))).toEqual(names(orderSiteRows(pasted, null)))
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'asc' }))).toEqual(names(orderSiteRows(pasted, null)))
  })

  test('the rank function is not asked about the number columns', () => {
    const asked: string[] = []
    orderSiteRows(pasted, { key: 'count', direction: 'desc' }, r => { asked.push(r.site); return 0 })
    expect(asked).toEqual([])
  })

  test('the Mark header cycles like the number columns: biggest rank first, reversed, then the default order', () => {
    const first = nextSiteSort(null, 'mark')
    expect(first).toEqual({ key: 'mark', direction: 'desc' })
    const second = nextSiteSort(first, 'mark')
    expect(second).toEqual({ key: 'mark', direction: 'asc' })
    expect(nextSiteSort(second, 'mark')).toBeNull()
    expect(nextSiteSort({ key: 'count', direction: 'asc' }, 'mark')).toEqual({ key: 'mark', direction: 'desc' })
  })
})
