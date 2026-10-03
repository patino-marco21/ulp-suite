import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))
vi.mock('@/lib/clickhouse-disk-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/clickhouse-disk-guard')>('@/lib/clickhouse-disk-guard')
  return { ...actual, checkDiskHeadroom: vi.fn() }
})

import * as dict from '@/lib/search-dictionary'
import { checkDiskHeadroom } from '@/lib/clickhouse-disk-guard'

const GIB = 1024 ** 3
const liveRow = (over: Record<string, unknown> = {}) => ({
  table_uuid: 'uuid-1',
  part_state: '202607:100:0:5;202608:200:0:6',
  mutation_state: '0000000012:(MATERIALIZE COLUMN country_tier)',
  mutations_running: '0',
  builds_running: '0',
  ...over,
})
const fpOf = (over: Record<string, unknown> = {}) => dict.liveStateFromRow(liveRow(over))!.fingerprint

beforeEach(() => {
  dict.resetSearchDictionaryCache()
  dict.recordBuildOutcome({ lastError: null, lastBuildMs: null, lastBuiltAt: null })
  vi.mocked(checkDiskHeadroom).mockResolvedValue({ freeBytes: 300 * GIB, totalBytes: 937 * GIB, ratio: 0.32 })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('configuration', () => {
  test('on unless switched off', () => {
    expect(dict.searchDictionaryEnabled({})).toBe(true)
    expect(dict.searchDictionaryEnabled({ SEARCH_DICTIONARY: '1' })).toBe(true)
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' 0 ']) expect(dict.searchDictionaryEnabled({ SEARCH_DICTIONARY: v }), v).toBe(false)
  })

  test('caps, cron and settle defaults, overrides, and junk falling back to the default', () => {
    expect(dict.searchDictMaxDomains({})).toBe(3000)
    expect(dict.searchDictMaxEmailDomains({})).toBe(300)
    expect(dict.searchDictCronMinutes({})).toBe(10)
    expect(dict.searchDictSettleSeconds({})).toBe(120)
    expect(dict.searchDictMaxDomains({ SEARCH_DICT_MAX_DOMAINS: '500' })).toBe(500)
    expect(dict.searchDictCronMinutes({ SEARCH_DICT_CRON_MINUTES: '0' })).toBe(0)
    expect(dict.searchDictSettleSeconds({ SEARCH_DICT_SETTLE_SECONDS: '5' })).toBe(5)
    for (const junk of ['', 'abc', '-5', 'NaN']) expect(dict.searchDictMaxDomains({ SEARCH_DICT_MAX_DOMAINS: junk }), junk).toBe(3000)
  })
})

describe('buildLiveStateSql', () => {
  const sql = dict.buildLiveStateSql()

  // `system.mutations.command` is wrapped in parentheses -- (CLEAR PROJECTION proj_imported_desc IN PARTITION '202607') -- so an anchored
  // ^CLEAR PROJECTION matches none of them and the dictionary would be invalidated by the daily 05:00Z clear (verified live 2026-10-03:
  // this form excludes 18 of the 19 listed mutations; the one kept is MATERIALIZE COLUMN country_tier).
  test('leaves projection and index mutations out of the fingerprint, with a pattern that allows the opening parenthesis', () => {
    expect(sql).toContain(String.raw`match(command, '^\\(?(CLEAR|MATERIALIZE|DROP|ADD) (PROJECTION|INDEX)')`)
    expect(sql.match(/NOT match\(command/g)).toHaveLength(2)
  })

  test('fingerprints the table uuid, per-partition rows and block range of the ACTIVE parts, and the mutation list', () => {
    expect(sql).toContain("FROM system.tables WHERE database = 'ulp' AND name = 'credentials'")
    expect(sql).toContain('min(min_block_number)')
    expect(sql).toContain('max(max_block_number)')
    expect(sql).toContain("table = 'credentials' AND active GROUP BY partition")
  })

  test('also reports running content mutations and running dictionary builds', () => {
    expect(sql).toContain('AND NOT is_done AND NOT match(command')
    expect(sql).toContain("FROM system.processes WHERE log_comment = 'search_dict_build'")
  })

  test('never goes through the query cache, and stays out of the older route tests\' query-count patterns', () => {
    expect(sql).toContain('use_query_cache = 0')
    expect(sql).not.toMatch(/\) AS t\s/)
    expect(sql).not.toMatch(/AS raw_total/)
  })
})

describe('liveStateFromRow', () => {
  test('a stable sha1 of the uuid, the part state and the mutation state', () => {
    const a = dict.liveStateFromRow(liveRow())!
    expect(a.fingerprint).toMatch(/^[0-9a-f]{40}$/)
    expect(dict.liveStateFromRow(liveRow())!.fingerprint).toBe(a.fingerprint)
  })

  test('changes when rows arrive, a partition appears, the table is swapped, or a content mutation is added', () => {
    const base = fpOf()
    expect(fpOf({ part_state: '202607:100:0:5;202608:201:0:7' })).not.toBe(base)
    expect(fpOf({ part_state: '202607:100:0:5;202608:200:0:6;202610:5:0:8' })).not.toBe(base)
    expect(fpOf({ table_uuid: 'uuid-2' })).not.toBe(base)
    expect(fpOf({ mutation_state: '0000000012:(MATERIALIZE COLUMN country_tier);0000000019:(DELETE WHERE x = 1)' })).not.toBe(base)
  })

  test('reads the running counts, which arrive as strings', () => {
    expect(dict.liveStateFromRow(liveRow({ mutations_running: '2', builds_running: '1' }))).toMatchObject({ mutationsRunning: 2, buildsRunning: 1 })
  })

  test('an empty mutation list is a valid state; anything unusable fails closed', () => {
    expect(dict.liveStateFromRow(liveRow({ mutation_state: '' }))).not.toBeNull()
    expect(dict.liveStateFromRow(undefined)).toBeNull()
    expect(dict.liveStateFromRow(liveRow({ table_uuid: '' }))).toBeNull()
    expect(dict.liveStateFromRow(liveRow({ part_state: '' }))).toBeNull()
    expect(dict.liveStateFromRow(liveRow({ mutation_state: null }))).toBeNull()
    expect(dict.liveStateFromRow({ total: '7', raw_total: '9' })).toBeNull() // what an older test's mock answers to any query
  })
})

describe('dictionary comment', () => {
  test('round-trips', () => {
    const c = { v: 1, fp: 'a'.repeat(40), builtAt: '2026-10-03T12:00:00.000Z', rows: 85232652 }
    expect(dict.parseDictionaryComment(dict.encodeDictionaryComment(c))).toEqual(c)
    expect(dict.parseDictionaryComment(dict.encodeDictionaryComment({ ...c, rows: null }))).toEqual({ ...c, rows: null })
  })

  test('rejects anything that is not this version\'s comment', () => {
    for (const bad of [undefined, null, '', 'not json', '{}', '{"v":2,"fp":"aaaaaaaaaa","builtAt":"x"}', '{"v":1,"fp":"short","builtAt":"x"}', '{"v":1,"fp":"aaaaaaaaaa"}', 42]) {
      expect(dict.parseDictionaryComment(bad), String(bad)).toBeNull()
    }
  })

  test('refuses to encode a value that would need escaping inside the single-quoted DDL string', () => {
    expect(() => dict.encodeDictionaryComment({ v: 1, fp: "ab'cdefghij", builtAt: 'x', rows: null })).toThrow()
    expect(() => dict.encodeDictionaryComment({ v: 1, fp: 'ab\\cdefghij', builtAt: 'x', rows: null })).toThrow()
  })
})

describe('evaluateDictionaryState', () => {
  const live = dict.liveStateFromRow(liveRow())!
  const comment = (fp: string, rows: number | null = 10) => dict.encodeDictionaryComment({ v: 1, fp, builtAt: '2026-10-03T12:00:00.000Z', rows })
  const tables = (hostFp: string, emailFp: string) => [
    { name: 'search_host_dict', comment: comment(hostFp, 85), rows: 85, bytes: 2000 },
    { name: 'search_emaildomain_dict', comment: comment(emailFp, 13), rows: 13, bytes: 100 },
  ]

  test('fresh only when BOTH comments carry the live fingerprint', () => {
    const s = dict.evaluateDictionaryState({ enabled: true, live, tables: tables(live.fingerprint, live.fingerprint) })
    expect(s).toMatchObject({ state: 'fresh', fingerprint: live.fingerprint, pairRows: 85, emailRows: 13, bytes: 2100, builtAt: '2026-10-03T12:00:00.000Z' })
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables(live.fingerprint, 'f'.repeat(40)) }).state).toBe('stale')
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables('f'.repeat(40), live.fingerprint) }).state).toBe('stale')
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables('f'.repeat(40), 'f'.repeat(40)) }).fingerprint).toBeNull()
  })

  test('stale when a comment cannot be read', () => {
    const t = tables(live.fingerprint, live.fingerprint)
    t[1] = { ...t[1], comment: '' }
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: t }).state).toBe('stale')
  })

  test('missing when either table is absent', () => {
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: [] }).state).toBe('missing')
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables(live.fingerprint, live.fingerprint).slice(0, 1) }).state).toBe('missing')
  })

  test('building while a build query runs, disabled when switched off, unknown when the live state cannot be read', () => {
    expect(dict.evaluateDictionaryState({ enabled: true, live: { ...live, buildsRunning: 1 }, tables: tables(live.fingerprint, live.fingerprint) }).state).toBe('building')
    expect(dict.evaluateDictionaryState({ enabled: false, live, tables: [] }).state).toBe('disabled')
    expect(dict.evaluateDictionaryState({ enabled: true, live: null, tables: [] }).state).toBe('unknown')
  })
})

describe('getSearchDictionaryStatus', () => {
  const live = dict.liveStateFromRow(liveRow())!
  const goodTables = [
    { name: 'search_host_dict', comment: dict.encodeDictionaryComment({ v: 1, fp: live.fingerprint, builtAt: '2026-10-03T12:00:00.000Z', rows: 85 }), table_rows: '85', table_bytes: '2000' },
    { name: 'search_emaildomain_dict', comment: dict.encodeDictionaryComment({ v: 1, fp: live.fingerprint, builtAt: '2026-10-03T12:00:00.000Z', rows: 13 }), table_rows: '13', table_bytes: '100' },
  ]
  const router = () => vi.fn(async (sql: string) => (sql.includes('AS table_uuid') ? [liveRow()] : sql.includes('FROM system.tables') ? goodTables : []))

  test('fresh, with the sizes and the build time', async () => {
    const s = await dict.getSearchDictionaryStatus(router(), () => 1000)
    expect(s).toMatchObject({ state: 'fresh', pairRows: 85, emailRows: 13, bytes: 2100, fingerprint: live.fingerprint })
  })

  test('answers from a 3 second cache, then asks again (a "fresh" verdict must not outlive a change to the data for long)', async () => {
    const run = router()
    let t = 1000
    await dict.getSearchDictionaryStatus(run, () => t)
    await dict.getSearchDictionaryStatus(run, () => t)
    t += 2_000
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run).toHaveBeenCalledTimes(2) // the live state and the table list, once
    t += 1_500
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run).toHaveBeenCalledTimes(4)
  })

  test('concurrent callers share one check', async () => {
    const run = router()
    await Promise.all([1, 2, 3].map(() => dict.getSearchDictionaryStatus(run, () => 1000)))
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('fails closed to unknown when ClickHouse errors, and retries after five seconds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValue(new Error('connection refused'))
    let t = 1000
    expect((await dict.getSearchDictionaryStatus(run, () => t)).state).toBe('unknown')
    const calls = run.mock.calls.length
    t += 4_000
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run.mock.calls.length).toBe(calls)
    t += 2_000
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run.mock.calls.length).toBeGreaterThan(calls)
  })

  test('an answer it cannot read is unknown, never fresh', async () => {
    const run = vi.fn(async () => [{ total: '7', raw_total: '9' }])
    expect((await dict.getSearchDictionaryStatus(run, () => 1000)).state).toBe('unknown')
  })

  test('switched off: disabled, and ClickHouse is not asked', async () => {
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    const run = router()
    expect((await dict.getSearchDictionaryStatus(run, () => 1000)).state).toBe('disabled')
    expect(run).not.toHaveBeenCalled()
  })

  test('carries the last build error and duration the cron recorded', async () => {
    dict.recordBuildOutcome({ lastError: 'boom', lastBuildMs: 129_000 })
    const s = await dict.getSearchDictionaryStatus(router(), () => 1000)
    expect(s).toMatchObject({ lastError: 'boom', lastBuildMs: 129_000 })
  })
})

describe('buildSearchDictionary', () => {
  const NOW = new Date('2026-10-03T12:00:00.000Z')

  function harness(opts: { existing?: boolean; failOn?: RegExp; live?: Record<string, unknown>; counts?: [number, number] } = {}) {
    const events: string[] = []
    const counts = opts.counts ?? [85, 13]
    const client = {
      command: vi.fn(async (a: { query: string; clickhouse_settings?: Record<string, unknown> }) => {
        if (opts.failOn?.test(a.query)) throw new Error(`boom in ${a.query.slice(0, 40)}`)
        events.push(`cmd:${a.query}`)
        return {}
      }),
    }
    const run = vi.fn(async (sql: string) => {
      if (sql.includes('AS table_uuid')) { events.push('run:live'); return [liveRow(opts.live)] }
      if (/FROM system\.tables/.test(sql)) { events.push('run:exists'); return [{ n: opts.existing ? '1' : '0' }] }
      if (/FROM ulp\.search_host_dict__new/.test(sql)) return [{ n: String(counts[0]) }]
      if (/FROM ulp\.search_emaildomain_dict__new/.test(sql)) return [{ n: String(counts[1]) }]
      return []
    })
    return { client, run, events }
  }
  const cmds = (events: string[]) => events.filter(e => e.startsWith('cmd:')).map(e => e.slice(4))
  const at = (events: string[], re: RegExp) => events.findIndex(e => re.test(e))
  const commentOf = (query: string) => dict.parseDictionaryComment(/COMMENT '(.*)'$/.exec(query.replace(/\s+/g, ' ').trim())?.[1])

  test('reads the fingerprint FIRST, builds into shadow tables, then swaps (a first build renames)', async () => {
    const h = harness()
    const result = await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    expect(result).toMatchObject({ pairRows: 85, emailRows: 13, fingerprint: fpOf() })
    expect(h.events[0]).toBe('run:live')
    const e = h.events
    const order = [
      /DROP TABLE IF EXISTS ulp\.search_host_dict__new SYNC/, /CREATE TABLE ulp\.search_host_dict__new/, /CREATE TABLE ulp\.search_emaildomain_dict__new/,
      /INSERT INTO ulp\.search_host_dict__new SELECT domain, url_host FROM ulp\.credentials GROUP BY domain, url_host/,
      /OPTIMIZE TABLE ulp\.search_host_dict__new FINAL/, /ALTER TABLE ulp\.search_host_dict__new MODIFY COMMENT/,
      /INSERT INTO ulp\.search_emaildomain_dict__new SELECT email_domain FROM ulp\.credentials GROUP BY email_domain/,
      /ALTER TABLE ulp\.search_emaildomain_dict__new MODIFY COMMENT/,
      /RENAME TABLE ulp\.search_host_dict__new TO ulp\.search_host_dict/, /RENAME TABLE ulp\.search_emaildomain_dict__new TO ulp\.search_emaildomain_dict/,
    ].map(re => at(e, re))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(at(e, /EXCHANGE/)).toBe(-1)
  })

  test('when the dictionary already exists the swap is EXCHANGE TABLES, and the old copy is dropped afterwards', async () => {
    const h = harness({ existing: true })
    await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    const c = cmds(h.events)
    expect(c).toContain('EXCHANGE TABLES ulp.search_host_dict__new AND ulp.search_host_dict')
    expect(c).toContain('EXCHANGE TABLES ulp.search_emaildomain_dict__new AND ulp.search_emaildomain_dict')
    expect(c.some(q => q.startsWith('RENAME'))).toBe(false)
    expect(at(h.events, /EXCHANGE TABLES ulp\.search_host_dict__new/)).toBeLessThan(h.events.lastIndexOf('cmd:DROP TABLE IF EXISTS ulp.search_host_dict__new SYNC'))
  })

  test('both tables carry the fingerprint read BEFORE the build; the row count is added before the swap', async () => {
    const h = harness()
    await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    const c = cmds(h.events)
    const created = c.filter(q => q.startsWith('CREATE TABLE'))
    expect(created).toHaveLength(2)
    for (const q of created) expect(commentOf(q)).toMatchObject({ v: 1, fp: fpOf(), builtAt: NOW.toISOString(), rows: null })
    const modified = c.filter(q => q.startsWith('ALTER TABLE'))
    expect(modified.map(q => commentOf(q)?.rows)).toEqual([85, 13])
    expect(created[0]).toContain('ENGINE = MergeTree ORDER BY (domain, url_host)')
    expect(created[1]).toContain('ENGINE = MergeTree ORDER BY email_domain')
  })

  test('the two INSERT ... SELECT statements carry the build settings of the spec', async () => {
    const h = harness()
    await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    const inserts = h.client.command.mock.calls.map(c => c[0]).filter(a => a.query.startsWith('INSERT INTO'))
    expect(inserts).toHaveLength(2)
    for (const a of inserts) {
      expect(a.clickhouse_settings).toMatchObject({
        max_threads: 8, max_memory_usage: 6_000_000_000, max_bytes_before_external_group_by: 3_000_000_000,
        async_insert: 0, log_comment: 'search_dict_build', use_query_cache: 0,
      })
    }
  })

  test('a failure half way drops the shadow tables, issues no swap, and records the error', async () => {
    const h = harness({ failOn: /INSERT INTO ulp\.search_emaildomain_dict__new/ })
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })).rejects.toThrow(/boom/)
    const c = cmds(h.events)
    expect(c.some(q => q.startsWith('EXCHANGE') || q.startsWith('RENAME'))).toBe(false)
    expect(c.filter(q => q === 'DROP TABLE IF EXISTS ulp.search_host_dict__new SYNC').length).toBeGreaterThanOrEqual(2)
    expect(c.filter(q => q === 'DROP TABLE IF EXISTS ulp.search_emaildomain_dict__new SYNC').length).toBeGreaterThanOrEqual(2)
    expect(dict.readBuildRecord().lastError).toMatch(/boom/)
  })

  test('an empty copy is never swapped in', async () => {
    const h = harness({ counts: [85, 0] })
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })).rejects.toThrow(/empty/)
    expect(cmds(h.events).some(q => q.startsWith('EXCHANGE') || q.startsWith('RENAME'))).toBe(false)
  })

  test('refuses while another build is running, and when the live fingerprint cannot be read; nothing is created', async () => {
    const busy = harness({ live: { builds_running: '1' } })
    await expect(dict.buildSearchDictionary({ client: busy.client, run: busy.run, log: () => {} })).rejects.toThrow(/already running/)
    expect(busy.client.command).not.toHaveBeenCalled()
    const blind = harness()
    blind.run.mockResolvedValue([])
    await expect(dict.buildSearchDictionary({ client: blind.client, run: blind.run, log: () => {} })).rejects.toThrow(/fingerprint/)
    expect(blind.client.command).not.toHaveBeenCalled()
  })

  test('refuses when the copy would push free space under the disk guard\'s floor, unless told the operator has checked', async () => {
    // floor on a 937 GiB disk = max(50 GiB, 15%) = 140.55 GiB; 143 GiB free minus the 3 GiB the build needs is under it
    vi.mocked(checkDiskHeadroom).mockResolvedValue({ freeBytes: 143 * GIB, totalBytes: 937 * GIB, ratio: 0.15 })
    const h = harness()
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, log: () => {} })).rejects.toBeInstanceOf(dict.DictionaryHeadroomError)
    expect(h.client.command).not.toHaveBeenCalled()
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {}, skipHeadroomCheck: true })).resolves.toBeTruthy()
  })

  test('an unreadable disk counts as no headroom (fail closed)', async () => {
    vi.mocked(checkDiskHeadroom).mockRejectedValue(new Error('system.disks returned no usable row'))
    const h = harness()
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, log: () => {} })).rejects.toBeInstanceOf(dict.DictionaryHeadroomError)
  })

  test('success clears the recorded error, records the duration, and forgets the cached status', async () => {
    dict.recordBuildOutcome({ lastError: 'old failure' })
    const statusRun = vi.fn(async (sql: string) => (sql.includes('AS table_uuid') ? [liveRow()] : []))
    await dict.getSearchDictionaryStatus(statusRun, () => 1000) // fills the cache
    const h = harness()
    const result = await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    expect(result.ms).toBeGreaterThanOrEqual(0)
    expect(dict.readBuildRecord()).toMatchObject({ lastError: null, lastBuiltAt: NOW.toISOString() })
    await dict.getSearchDictionaryStatus(statusRun, () => 1001) // within 3 s: only a reset cache asks again
    expect(statusRun.mock.calls.length).toBeGreaterThan(2)
  })
})
