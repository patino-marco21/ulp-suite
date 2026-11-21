import { describe, test, expect, beforeEach } from 'vitest'
import { dbRun } from '@/lib/sqlite'
import { orderSiteRows, type SiteCount, type SiteSort } from '@/lib/site-counts-input'
import { markRank, type MarkState } from '@/lib/site-marks-input'
import { listSites } from '@/lib/site-directory'
import type { DirectoryQuery } from '@/lib/site-directory-input'

// The directory sorts in SQLite; the Site Counts page sorts with orderSiteRows. This test makes the second the oracle of the first: the same random
// sites, every sort the page offers in both directions, walked page by page, must come out in the same order (the host is the last tie-break).
interface Fixture { host: string; count: number | null; host_count: number | null; subdomain_count: number | null; subdomains: number | null; mark: MarkState }

function fixtures(seed: number, n: number): Fixture[] {
  let s = seed
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
  const pick = (values: Array<number | null>) => values[Math.floor(rand() * values.length)]
  const marks: MarkState[] = ['done', 'skip', 'todo', 'none', 'none']
  return Array.from({ length: n }, (_, i) => {
    const counted = rand() > 0.15
    return {
      host: `s${String(i).padStart(3, '0')}.corp.example`,
      count: counted ? pick([0, 1, 5, 5, 40, 40, 900]) : null,
      host_count: counted ? pick([0, 3, 3, 20, null]) : null,
      subdomain_count: counted ? pick([0, 2, 2, 50, null]) : null,
      subdomains: counted ? pick([0, 1, 1, 7]) : null,
      mark: marks[Math.floor(rand() * marks.length)],
    }
  })
}

const toResult = (f: Fixture): SiteCount => ({
  host: f.host, found: (f.count ?? 0) > 0, count: f.count, host_count: f.host_count, subdomain_count: f.subdomain_count, subdomains: f.subdomains, top_subdomains: [],
})

function load(rows: Fixture[]) {
  dbRun('DELETE FROM site_directory')
  dbRun('DELETE FROM site_marks')
  dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES ('site_directory_seeded', '1')`)
  for (const f of rows) {
    dbRun(
      `INSERT INTO site_directory (host, row_count, host_count, subdomain_count, subdomains) VALUES (?, ?, ?, ?, ?)`,
      [f.host, f.count, f.host_count, f.subdomain_count, f.subdomains],
    )
    if (f.mark !== 'none' && f.mark !== null) dbRun(`INSERT INTO site_marks (host, status) VALUES (?, ?)`, [f.host, f.mark])
  }
}

const walk = (query: Omit<DirectoryQuery, 'offset' | 'limit'>, limit: number): string[] => {
  const hosts: string[] = []
  for (let offset: number | null = 0; offset !== null;) {
    const page = listSites({ ...query, offset, limit })
    hosts.push(...page.sites.map(s => s.host))
    offset = page.next_offset
  }
  return hosts
}

const KEYS = ['count', 'host_count', 'subdomain_count', 'subdomains', 'mark'] as const
const SORTS: Array<SiteSort | null> = [null, ...KEYS.flatMap(key => (['desc', 'asc'] as const).map(direction => ({ key, direction })))]

describe.each([1, 2, 3])('listSites order, seed %i', seed => {
  const rows = fixtures(seed, 60)
  beforeEach(() => load(rows))

  test.each(SORTS.map(sort => [sort ? `${sort.key} ${sort.direction}` : 'the default', sort] as const))('%s is the order of the Site Counts page', (_label, sort) => {
    const byHost = [...rows].sort((a, b) => (a.host < b.host ? -1 : 1)).map(f => ({ f, result: toResult(f) }))
    // the directory's default order is "most rows first, the sites with no number last": the page's explicit sort by rows
    const oracle = orderSiteRows(byHost, sort ?? { key: 'count', direction: 'desc' }, row => markRank(row.f.mark)).map(r => r.f.host)
    expect(walk({ sort, q: '', mark: 'all', host: null }, 7)).toEqual(oracle)
  })
})

describe('listSites paging', () => {
  const rows = fixtures(9, 45)
  beforeEach(() => load(rows))

  test('every site comes once, whatever the page size', () => {
    for (const size of [1, 7, 20, 45, 200]) {
      const hosts = walk({ sort: null, q: '', mark: 'all', host: null }, size)
      expect(hosts).toHaveLength(45)
      expect(new Set(hosts).size).toBe(45)
    }
  })

  test('the first page carries the total and the chips, the later ones do not, and the next offset ends with null', () => {
    const first = listSites({ sort: null, q: '', mark: 'all', host: null, offset: 0, limit: 10 })
    expect(first.total).toBe(45)
    expect(first.marks).not.toBeNull()
    expect(first.next_offset).toBe(10)
    const later = listSites({ sort: null, q: '', mark: 'all', host: null, offset: 10, limit: 10 })
    expect(later.total).toBeNull()
    expect(later.marks).toBeNull()
    expect(listSites({ sort: null, q: '', mark: 'all', host: null, offset: 40, limit: 10 }).next_offset).toBeNull()
  })

  test('a page past the end is empty and ends', () => {
    expect(listSites({ sort: null, q: '', mark: 'all', host: null, offset: 500, limit: 10 })).toMatchObject({ sites: [], next_offset: null })
  })
})

describe('listSites search and chips', () => {
  beforeEach(() => {
    load([])
    const add = (host: string, count: number, mark?: 'done' | 'todo') => {
      dbRun(`INSERT INTO site_directory (host, row_count) VALUES (?, ?)`, [host, count])
      if (mark) dbRun(`INSERT INTO site_marks (host, status) VALUES (?, ?)`, [host, mark])
    }
    add('shop.corp.example', 5, 'done')
    add('corp.example', 50, 'todo')
    add('other.example', 7)
    add('under_score.example', 1)
    add('100%.example', 2)
    dbRun(`INSERT INTO site_marks (host, note) VALUES ('other.example', 'note only')`)
  })
  const base = { sort: null, mark: 'all', host: null, offset: 0, limit: 50 } as const

  test('a search is a case-insensitive part of the host', () => {
    expect(listSites({ ...base, q: 'CORP' }).sites.map(s => s.host)).toEqual(['corp.example', 'shop.corp.example'])
  })

  test('% and _ in a search are letters, not wildcards', () => {
    expect(listSites({ ...base, q: '_' }).sites.map(s => s.host)).toEqual(['under_score.example'])
    expect(listSites({ ...base, q: '%' }).sites.map(s => s.host)).toEqual(['100%.example'])
  })

  test('a chip narrows the list; its total is the rows it shows and the chips count the current search, not the chip', () => {
    const done = listSites({ ...base, q: 'corp', mark: 'done' })
    expect(done.sites.map(s => s.host)).toEqual(['shop.corp.example'])
    expect(done.total).toBe(1)
    expect(done.marks).toEqual({ all: 2, done: 1, skip: 0, todo: 1, none: 0 })
    const none = listSites({ ...base, q: '', mark: 'none' })
    expect(none.sites.map(s => s.host).sort()).toEqual(['100%.example', 'other.example', 'under_score.example'])
    expect(none.marks).toEqual({ all: 5, done: 1, skip: 0, todo: 1, none: 3 })
  })

  test('a site with a note and no status is "No mark" and still shows its note', () => {
    const [other] = listSites({ ...base, q: 'other' }).sites
    expect(other.mark).toMatchObject({ status: null, note: 'note only' })
  })

  test('an exact host returns that one site', () => {
    expect(listSites({ ...base, q: '', host: 'corp.example' }).sites.map(s => s.host)).toEqual(['corp.example'])
    expect(listSites({ ...base, q: '', host: 'corp' }).sites).toEqual([])
  })
})
