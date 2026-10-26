import { describe, test, expect } from 'vitest'
import {
  SITE_COUNTS_MAX_PER_LIST,
  SITE_COUNTS_MAX_PER_REQUEST,
  SITE_COUNTS_REQUEST_SIZE,
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
