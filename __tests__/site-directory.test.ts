import { describe, test, expect, beforeEach } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'
import { OUT_OF_TIME, TOO_BROAD, type SiteCount } from '@/lib/site-counts-input'
import {
  breakdownTargets, directoryTotal, getSite, outOfDateHosts, recordSites, removeSite, seedFromMarks, siteExists, staleCount, storeBreakdown,
  storeCounts, touchBreakdown,
} from '@/lib/site-directory'

// These run on the real SQLite file of the test worker (see __tests__/setup/), so the SQL itself is what is proven.
const counted = (host: string, over: Partial<SiteCount> = {}): SiteCount => ({
  host, found: true, count: 30, host_count: 10, subdomain_count: 20, subdomains: 2,
  top_subdomains: [{ domain: `app.${host}`, count: 15 }, { domain: `m.${host}`, count: 5 }], ...over,
})
const notCounted = (host: string, error: string): SiteCount => ({
  host, found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], error,
})
const rowOf = (host: string) => dbGet('SELECT * FROM site_directory WHERE host = ?', [host]) as Record<string, any> | undefined
const run = (results: Record<string, SiteCount>, extra: { windowed?: boolean; fingerprint?: string | null } = {}) =>
  recordSites({ results, windowed: extra.windowed ?? false, fingerprint: extra.fingerprint === undefined ? 'fp-1' : extra.fingerprint })

beforeEach(() => {
  dbRun('DELETE FROM site_directory')
  dbRun('DELETE FROM site_marks')
  dbRun(`DELETE FROM app_settings WHERE key_name = 'site_directory_seeded'`)
})

describe('recordSites', () => {
  test('a first all-time count adds the site with its numbers, the date and the fingerprint', () => {
    run({ 'corp.example': counted('corp.example') })
    expect(rowOf('corp.example')).toMatchObject({
      times_counted: 1, row_count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, counted_fp: 'fp-1', count_error: null,
      top_subdomains: JSON.stringify([{ domain: 'app.corp.example', count: 15 }, { domain: 'm.corp.example', count: 5 }]),
    })
    expect(rowOf('corp.example')!.counted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(rowOf('corp.example')!.first_added_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  test('a repeat replaces the numbers and counts one more request', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': counted('corp.example', { count: 50, host_count: 20, subdomain_count: 30 }) }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ times_counted: 2, row_count: 50, host_count: 20, counted_fp: 'fp-2' })
  })

  test('several spellings of one site in one request are one site counted once', () => {
    run({ 'corp.example': counted('corp.example'), 'https://www.corp.example/login': counted('corp.example'), '*.corp.example': counted('corp.example') })
    expect(directoryTotal()).toBe(1)
    expect(rowOf('corp.example')!.times_counted).toBe(1)
  })

  test('an entry that is not a site (no host) is not recorded', () => {
    run({ localhost: notCounted('', 'not a site address') })
    expect(directoryTotal()).toBe(0)
  })

  test('a count with an imported window adds a new site without numbers and leaves an old site\'s all-time numbers alone', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': counted('corp.example', { count: 3 }), 'new.example': counted('new.example', { count: 3 }) }, { windowed: true, fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: 'fp-1', times_counted: 2 })
    expect(rowOf('new.example')).toMatchObject({ row_count: null, counted_fp: null, counted_at: null, times_counted: 1 })
  })

  test('a site too broad to count is added, keeps the numbers it had and keeps the reason with the fingerprint', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': notCounted('corp.example', TOO_BROAD), 'huge.example': notCounted('huge.example', TOO_BROAD) }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, count_error: TOO_BROAD, counted_fp: 'fp-2' })
    expect(rowOf('huge.example')).toMatchObject({ row_count: null, count_error: TOO_BROAD, counted_fp: 'fp-2' })
  })

  test('a site the request ran out of time before reaching is added but not marked as tried', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': notCounted('corp.example', OUT_OF_TIME) }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: 'fp-1', count_error: null })
  })

  test('a later good count clears the reason', () => {
    run({ 'huge.example': notCounted('huge.example', TOO_BROAD) })
    run({ 'huge.example': counted('huge.example') }, { fingerprint: 'fp-2' })
    expect(rowOf('huge.example')).toMatchObject({ row_count: 30, count_error: null, counted_fp: 'fp-2' })
  })

  test('a host-only result is stored when nothing is, with no fingerprint so the refresh counts it again, and never replaces a complete count', () => {
    const hostOnly = counted('corp.example', { count: 10, subdomain_count: null, subdomains: null, top_subdomains: [] })
    run({ 'corp.example': hostOnly })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 10, subdomain_count: null, counted_fp: null })
    run({ 'corp.example': counted('corp.example') })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, subdomain_count: 20, counted_fp: 'fp-1' })
    run({ 'corp.example': hostOnly }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, subdomain_count: 20, counted_fp: 'fp-1' })
  })

  test('without a fingerprint (the table could not be read) the numbers are stored and the site is out of date at the next refresh', () => {
    run({ 'corp.example': counted('corp.example') }, { fingerprint: null })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: null })
    expect(staleCount('fp-now')).toBe(1)
  })
})

describe('storeCounts (the refresh)', () => {
  test('stores the numbers without counting a request, under the key it was given', () => {
    run({ 'corp.example': counted('corp.example') })
    storeCounts({ 'corp.example': counted('corp.example', { count: 99 }) }, 'fp-2')
    expect(rowOf('corp.example')).toMatchObject({ row_count: 99, counted_fp: 'fp-2', times_counted: 1 })
  })
  test('a key that is not in the directory is not added', () => {
    storeCounts({ 'ghost.example': counted('ghost.example') }, 'fp-2')
    expect(siteExists('ghost.example')).toBe(false)
  })
})

describe('seedFromMarks', () => {
  test('adds the marked sites once, dated by their mark, with no numbers', () => {
    dbRun(`INSERT INTO site_marks (host, status, updated_at) VALUES ('marked.example', 'done', '2026-10-30 09:00:00')`)
    dbRun(`INSERT INTO site_marks (host, note) VALUES ('noted.example', 'look later')`)
    expect(seedFromMarks()).toBe(2)
    expect(rowOf('marked.example')).toMatchObject({ first_added_at: '2026-10-30 09:00:00', row_count: null, counted_fp: null, times_counted: 0 })
    expect(directoryTotal()).toBe(2)
  })
  test('a removed site is not added again: the flag keeps it from running twice', () => {
    dbRun(`INSERT INTO site_marks (host, status) VALUES ('marked.example', 'done')`)
    seedFromMarks()
    removeSite('marked.example')
    expect(seedFromMarks()).toBe(0)
    expect(siteExists('marked.example')).toBe(false)
  })
})

describe('removeSite / getSite', () => {
  test('removes a site and says whether there was one', () => {
    run({ 'corp.example': counted('corp.example') })
    expect(removeSite('corp.example')).toBe(true)
    expect(removeSite('corp.example')).toBe(false)
  })
  test('a removed site that is counted again starts over', () => {
    run({ 'corp.example': counted('corp.example') })
    removeSite('corp.example')
    run({ 'corp.example': counted('corp.example') })
    expect(rowOf('corp.example')!.times_counted).toBe(1)
  })
  test('getSite gives the site as the list sends it, with its mark and its split', () => {
    run({ 'corp.example': counted('corp.example') })
    dbRun(`INSERT INTO site_marks (host, status, note, updated_by) VALUES ('corp.example', 'todo', 'check', 'a@example.test')`)
    storeBreakdown('corp.example', { email: 20, phone: 1, username: 8, other: 1 }, 'fp-1')
    expect(getSite('corp.example')).toMatchObject({
      host: 'corp.example', count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, count_error: null,
      top_subdomains: [{ domain: 'app.corp.example', count: 15 }, { domain: 'm.corp.example', count: 5 }],
      mark: { status: 'todo', note: 'check', updated_by: 'a@example.test' },
      breakdown: { email: 20, phone: 1, username: 8, other: 1 },
    })
    expect(getSite('nope.example')).toBeNull()
  })
})

describe('out of date', () => {
  test('a site is out of date when it was never counted all-time or was counted against another fingerprint; the biggest come first, never-counted last', () => {
    run({ 'small.example': counted('small.example', { count: 5 }), 'big.example': counted('big.example', { count: 500 }), 'fresh.example': counted('fresh.example') })
    storeCounts({ 'fresh.example': counted('fresh.example') }, 'fp-now')
    run({ 'windowed.example': counted('windowed.example') }, { windowed: true })
    expect(outOfDateHosts('fp-now', 10)).toEqual(['big.example', 'small.example', 'windowed.example'])
    expect(outOfDateHosts('fp-now', 2)).toEqual(['big.example', 'small.example'])
    expect(staleCount('fp-now')).toBe(3)
  })
  test('a site that was too broad is not out of date until the fingerprint changes', () => {
    run({ 'huge.example': notCounted('huge.example', TOO_BROAD) }, { fingerprint: 'fp-now' })
    expect(outOfDateHosts('fp-now', 10)).toEqual([])
    expect(outOfDateHosts('fp-later', 10)).toEqual(['huge.example'])
  })
  test('a stored split is out of date on its own fingerprint, and a site with none never is', () => {
    run({ 'a.example': counted('a.example'), 'b.example': counted('b.example') }, { fingerprint: 'fp-now' })
    storeBreakdown('a.example', { email: 30, phone: 0, username: 0, other: 0 }, 'fp-old')
    expect(breakdownTargets('fp-now', 10)).toEqual(['a.example'])
    expect(staleCount('fp-now')).toBe(1)
    touchBreakdown('a.example', 'fp-now')
    expect(breakdownTargets('fp-now', 10)).toEqual([])
    expect(getSite('a.example')!.breakdown).toMatchObject({ email: 30 })
  })
  test('touching a site with no split does nothing', () => {
    run({ 'b.example': counted('b.example') })
    touchBreakdown('b.example', 'fp-now')
    expect(rowOf('b.example')!.bd_fp).toBeNull()
  })
})

describe('storeBreakdown', () => {
  test('stores the four parts, when and against which fingerprint, and says whether the site was there', () => {
    run({ 'corp.example': counted('corp.example') })
    expect(storeBreakdown('corp.example', { email: 563, phone: 40, username: 397, other: 0 }, 'fp-1')).toBe(true)
    expect(rowOf('corp.example')).toMatchObject({ bd_email: 563, bd_phone: 40, bd_username: 397, bd_other: 0, bd_fp: 'fp-1' })
    expect(rowOf('corp.example')!.bd_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
    expect(storeBreakdown('gone.example', { email: 1, phone: 0, username: 0, other: 0 }, 'fp-1')).toBe(false)
  })
})
