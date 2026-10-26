import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildHitScanSql, currentPartsFingerprint, hitSetConjunct, hitSetStillCurrent, isEmptyHitSet, resetSearchHitSetCache, resolveHitSet,
  searchHitSetEnabled, searchHitSetMaxHits, toHitSet, HIT_SET_MAX_CONJUNCT_CHARS, PARTS_FINGERPRINT_SQL, type HitRun, type HitSet,
} from '@/lib/search-hit-set'

/**
 * lib/search-hit-set.ts, with the ClickHouse seam faked (`run`). What each case guards is named in its title; the SQL itself is proven against the
 * real server by __tests__/hit-set-parity.live.test.ts and scripts/e2e-hit-set.ts.
 */

const PART_A = '202610_1612_2827_27_2426'
const PART_B = '202607_0_995_4_1043'
const row = (part: string, off: number | string) => ({ part, off })

interface Call { sql: string; params?: Record<string, unknown>; signal?: AbortSignal }
interface Fake {
  run: HitRun
  calls: Call[]
  scans: () => Call[]
  /** Fingerprints handed out in order; the last one repeats. */
  fingerprints: string[]
  scanRows: Array<Record<string, unknown>>
  scanError: Error | null
  /** When set, a scan stays pending until this resolves (or its signal aborts). */
  holdScan: Promise<void> | null
  scansStarted: number
}

function fake(): Fake {
  const f: Fake = {
    calls: [], fingerprints: ['fp-1'], scanRows: [row(PART_A, 7), row(PART_A, 9), row(PART_B, 3)], scanError: null, holdScan: null, scansStarted: 0,
    scans: () => f.calls.filter(c => c.sql.includes('_part_offset AS off')),
    run: async (sql, params, signal) => {
      f.calls.push({ sql, params, signal })
      if (sql.includes('AS fingerprint')) {
        const fp = f.fingerprints.length > 1 ? (f.fingerprints.shift() as string) : f.fingerprints[0]
        return fp === '' ? [] : [{ fingerprint: fp, parts: '15' }]
      }
      if (sql.includes('_part_offset AS off')) {
        f.scansStarted++
        if (f.holdScan) {
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('Query aborted by client'), { name: 'AbortError' })), { once: true })
            f.holdScan!.then(resolve)
          })
        }
        if (f.scanError) throw f.scanError
        return f.scanRows
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`)
    },
  }
  return f
}

const INPUT = { key: 'k1', qClause: 'url LIKE {lk0:String} OR email LIKE {lk0:String}', searchParams: { lk0: '%/a/b%' } }

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  resetSearchHitSetCache()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubEnv('SEARCH_HIT_SET', undefined)
  vi.stubEnv('SEARCH_TOKEN_PLANS', undefined)
  vi.stubEnv('SEARCH_HIT_SET_MAX_HITS', undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  warn.mockRestore()
  resetSearchHitSetCache()
})

describe('toHitSet', () => {
  it('groups the hits by part, sorted by part name and by offset, and counts them', () => {
    const set = toHitSet([row(PART_A, '9'), row(PART_B, 3), row(PART_A, 7)], 'fp', 10)
    expect(set).toEqual({
      fingerprint: 'fp', count: 3,
      parts: [{ part: PART_B, offsets: [3] }, { part: PART_A, offsets: [7, 9] }],
    })
  })

  it('lists nothing when there are more hits than the cap (the scan asked for one more than the cap)', () => {
    expect(toHitSet([row(PART_A, 1), row(PART_A, 2), row(PART_A, 3)], 'fp', 2)).toEqual({ fingerprint: 'fp', parts: null, count: 3 })
  })

  it('an empty scan is an empty set, not "unknown"', () => {
    expect(toHitSet([], 'fp', 5)).toEqual({ fingerprint: 'fp', parts: [], count: 0 })
  })

  it.each([
    ['a part that is not a string', [{ part: 5, off: 1 }]],
    ['an empty part name', [row('', 1)]],
    ['an offset that is not a number', [row(PART_A, 'x')]],
    ['a negative offset', [row(PART_A, -1)]],
    ['an offset beyond 2^53', [row(PART_A, '90071992547409931')]],
  ])('refuses %s (no plan, rather than a guessed one)', (_label, rows) => {
    expect(toHitSet(rows as Array<Record<string, unknown>>, 'fp', 10)).toBeNull()
  })
})

describe('hitSetConjunct', () => {
  const set = (parts: HitSet['parts']): HitSet => ({ fingerprint: 'fp', parts, count: 0 })

  it('writes one group per part: the part name and its offsets', () => {
    const sql = hitSetConjunct(set([{ part: PART_B, offsets: [3] }, { part: PART_A, offsets: [7, 9] }]))
    expect(sql).toBe(` AND ((_part = '${PART_B}' AND _part_offset IN (3)) OR (_part = '${PART_A}' AND _part_offset IN (7,9)))`)
  })

  it('escapes a part name like any other literal', () => {
    expect(hitSetConjunct(set([{ part: "a'b\\c", offsets: [1] }]))).toContain("_part = 'a\\'b\\\\c'")
  })

  it('has nothing to AND for an empty or an unlisted set', () => {
    expect(hitSetConjunct(set([]))).toBeNull()
    expect(hitSetConjunct(set(null))).toBeNull()
  })

  it('gives up when the text would not fit the SQL (today\'s query runs)', () => {
    const offsets = Array.from({ length: Math.ceil(HIT_SET_MAX_CONJUNCT_CHARS / 8) + 100 }, (_, i) => 100_000_000 + i)
    expect(hitSetConjunct(set([{ part: PART_A, offsets }]))).toBeNull()
  })

  it('isEmptyHitSet tells "no hits" from "too many to list"', () => {
    expect(isEmptyHitSet(set([]))).toBe(true)
    expect(isEmptyHitSet(set(null))).toBe(false)
    expect(isEmptyHitSet(set([{ part: PART_A, offsets: [1] }]))).toBe(false)
  })
})

describe('the SQL', () => {
  it('the scan reads positions of the BASE table, one row more than the cap, and throws (never breaks) over its time limit', () => {
    const sql = buildHitScanSql('url LIKE {lk0:String}')
    expect(sql).toContain('SELECT _part AS part, _part_offset AS off FROM ulp.credentials')
    expect(sql).toContain('WHERE (url LIKE {lk0:String})')
    expect(sql).toContain('LIMIT {hsCap:UInt32}')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).toContain("timeout_overflow_mode = 'throw'")
    expect(sql).toContain('use_query_cache = 0')
  })

  it('the fingerprint covers the table uuid and every active part name, and is never answered from the query cache', () => {
    expect(PARTS_FINGERPRINT_SQL).toContain("FROM system.tables WHERE database = 'ulp' AND name = 'credentials'")
    expect(PARTS_FINGERPRINT_SQL).toContain('arraySort(groupArray(name))')
    expect(PARTS_FINGERPRINT_SQL).toContain("table = 'credentials' AND active")
    expect(PARTS_FINGERPRINT_SQL).toContain('use_query_cache = 0')
  })
})

describe('settings', () => {
  it('is on by default and off for SEARCH_HIT_SET=0/false/off/no', () => {
    expect(searchHitSetEnabled({})).toBe(true)
    for (const v of ['0', 'false', 'OFF', ' no ']) expect(searchHitSetEnabled({ SEARCH_HIT_SET: v })).toBe(false)
    expect(searchHitSetEnabled({ SEARCH_HIT_SET: '1' })).toBe(true)
  })

  it('SEARCH_TOKEN_PLANS=0, the switch of every plan that prunes a text search, switches it off too', () => {
    expect(searchHitSetEnabled({ SEARCH_TOKEN_PLANS: '0' })).toBe(false)
  })

  it('lists at most 5,000 hits by default, tunable, and never above the ceiling the SQL can carry', () => {
    expect(searchHitSetMaxHits({})).toBe(5_000)
    expect(searchHitSetMaxHits({ SEARCH_HIT_SET_MAX_HITS: '800' })).toBe(800)
    expect(searchHitSetMaxHits({ SEARCH_HIT_SET_MAX_HITS: '999999' })).toBe(15_000)
    expect(searchHitSetMaxHits({ SEARCH_HIT_SET_MAX_HITS: '0' })).toBe(1)
    expect(searchHitSetMaxHits({ SEARCH_HIT_SET_MAX_HITS: 'lots' })).toBe(5_000)
  })
})

describe('currentPartsFingerprint', () => {
  it('reads it', async () => {
    const f = fake()
    expect(await currentPartsFingerprint(f.run)).toBe('fp-1')
  })

  it.each([
    ['no row', async () => []],
    ['an empty fingerprint', async () => [{ fingerprint: '', parts: '15' }]],
    ['a table with no active parts', async () => [{ fingerprint: 'x', parts: '0' }]],
    ['an error', async () => { throw new Error('connection refused') }],
  ])('is null for %s (no plan on a guess)', async (_label, run) => {
    expect(await currentPartsFingerprint(run as HitRun)).toBeNull()
  })

  it('hitSetStillCurrent compares the fingerprint now with the set\'s', async () => {
    const f = fake()
    const set: HitSet = { fingerprint: 'fp-1', parts: [], count: 0 }
    expect(await hitSetStillCurrent(set, f.run)).toBe(true)
    f.fingerprints = ['fp-2']
    expect(await hitSetStillCurrent(set, f.run)).toBe(false)
  })
})

describe('resolveHitSet', () => {
  it('scans ONCE for the positions, with the search\'s own parameters and a cap of one more than the limit', async () => {
    const f = fake()
    const set = await resolveHitSet(INPUT, { run: f.run })
    expect(set).toEqual({
      fingerprint: 'fp-1', count: 3,
      parts: [{ part: PART_B, offsets: [3] }, { part: PART_A, offsets: [7, 9] }],
    })
    expect(f.scans()).toHaveLength(1)
    expect(f.scans()[0].params).toEqual({ lk0: '%/a/b%', hsCap: 5_001 })
    expect(f.scans()[0].sql).toContain(INPUT.qClause)
  })

  it('the rows request and the totals request of one search share the one scan, and later calls use the cached set', async () => {
    const f = fake()
    const [a, b] = await Promise.all([resolveHitSet(INPUT, { run: f.run }), resolveHitSet(INPUT, { run: f.run })])
    expect(a).toBe(b)
    const c = await resolveHitSet(INPUT, { run: f.run })
    expect(c).toBe(a)
    expect(f.scansStarted).toBe(1)
  })

  it('two different searches do not share a set', async () => {
    const f = fake()
    await resolveHitSet(INPUT, { run: f.run })
    await resolveHitSet({ ...INPUT, key: 'k2' }, { run: f.run })
    expect(f.scansStarted).toBe(2)
  })

  it('a set is only good for the parts it was scanned under: other parts, another scan', async () => {
    const f = fake()
    await resolveHitSet(INPUT, { run: f.run })
    f.fingerprints = ['fp-2'] // an import added a part
    const again = await resolveHitSet(INPUT, { run: f.run })
    expect(f.scansStarted).toBe(2)
    expect(again?.fingerprint).toBe('fp-2')
  })

  it('a set expires after fifteen minutes even when the parts are the same', async () => {
    const f = fake()
    let t = 1_000_000
    await resolveHitSet(INPUT, { run: f.run, now: () => t })
    t += 14 * 60_000
    await resolveHitSet(INPUT, { run: f.run, now: () => t })
    expect(f.scansStarted).toBe(1)
    t += 2 * 60_000
    await resolveHitSet(INPUT, { run: f.run, now: () => t })
    expect(f.scansStarted).toBe(2)
  })

  it('a scan that straddled a change of the parts is thrown away, and the search is left to the plain query for two minutes', async () => {
    const f = fake()
    f.fingerprints = ['fp-1', 'fp-2'] // read before the scan, then at its end: the table had changed meanwhile
    let t = 5_000_000
    expect(await resolveHitSet(INPUT, { run: f.run, now: () => t })).toBeNull()
    expect(f.scansStarted).toBe(1)
    f.fingerprints = ['fp-3'] // the table is quiet again, but this search just proved unstable
    t += 60_000
    expect(await resolveHitSet(INPUT, { run: f.run, now: () => t })).toBeNull()
    expect(f.scansStarted).toBe(1) // no scan again and again while imports keep landing
    t += 61_000
    expect(await resolveHitSet(INPUT, { run: f.run, now: () => t })).not.toBeNull()
    expect(f.scansStarted).toBe(2)
  })

  it('a failed scan is null (today\'s query runs), is said on the warning log, and is not retried at once', async () => {
    const f = fake()
    f.scanError = new Error('Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)')
    expect(await resolveHitSet(INPUT, { run: f.run })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('position scan failed'), expect.stringContaining('TIMEOUT_EXCEEDED'))
    expect(await resolveHitSet(INPUT, { run: f.run })).toBeNull()
    expect(f.scansStarted).toBe(1)
  })

  it('more hits than the cap is an unlisted set, cached like any other (the next click does not scan again)', async () => {
    const f = fake()
    vi.stubEnv('SEARCH_HIT_SET_MAX_HITS', '2')
    const set = await resolveHitSet(INPUT, { run: f.run })
    expect(set).toMatchObject({ parts: null, count: 3 })
    await resolveHitSet(INPUT, { run: f.run })
    expect(f.scansStarted).toBe(1)
  })

  it('a request for a later page uses a set that is there but never starts a scan', async () => {
    const f = fake()
    expect(await resolveHitSet({ ...INPUT, allowScan: false }, { run: f.run })).toBeNull()
    expect(f.scansStarted).toBe(0)
    const first = await resolveHitSet(INPUT, { run: f.run })
    expect(await resolveHitSet({ ...INPUT, allowScan: false }, { run: f.run })).toBe(first)
    expect(f.scansStarted).toBe(1)
  })

  it('does nothing when the feature is off, or when the parts cannot be read', async () => {
    const f = fake()
    vi.stubEnv('SEARCH_HIT_SET', '0')
    expect(await resolveHitSet(INPUT, { run: f.run })).toBeNull()
    expect(f.calls).toHaveLength(0)
    vi.stubEnv('SEARCH_HIT_SET', undefined)
    f.fingerprints = ['']
    expect(await resolveHitSet(INPUT, { run: f.run })).toBeNull()
    expect(f.scansStarted).toBe(0)
  })

  it('rejects with an abort error for a signal that has already fired, without scanning', async () => {
    const f = fake()
    const c = new AbortController()
    c.abort()
    await expect(resolveHitSet({ ...INPUT, signal: c.signal }, { run: f.run })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.scansStarted).toBe(0)
  })

  it('and for a signal that fires while the table\'s parts are being read (still no scan started for nobody)', async () => {
    const f = fake()
    const c = new AbortController()
    const inner = f.run
    f.run = async (sql, params, signal) => {
      const out = await inner(sql, params, signal)
      if (sql.includes('AS fingerprint')) c.abort()
      return out
    }
    await expect(resolveHitSet({ ...INPUT, signal: c.signal }, { run: f.run })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.scansStarted).toBe(0)
  })
})

describe('a scan nobody waits for is killed; one somebody still waits for is not', () => {
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

  it('the only waiter leaves: the scan\'s signal fires after the grace period (so ClickHouse kills it)', async () => {
    vi.useFakeTimers()
    const f = fake()
    f.holdScan = new Promise<void>(() => {}) // never finishes by itself
    const c = new AbortController()
    const waiting = resolveHitSet({ ...INPUT, signal: c.signal }, { run: f.run })
    await flush()
    const scanSignal = f.scans()[0].signal as AbortSignal
    expect(scanSignal.aborted).toBe(false)
    c.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(scanSignal.aborted).toBe(false) // within the grace: a newer request for the same search may still join
    await vi.advanceTimersByTimeAsync(1_600)
    expect(scanSignal.aborted).toBe(true)
  })

  it('a newer request that joins within the grace keeps the scan alive (a filter click replaces the page\'s requests)', async () => {
    vi.useFakeTimers()
    const f = fake()
    let release!: () => void
    f.holdScan = new Promise<void>(resolve => { release = resolve })
    const first = new AbortController()
    const waiting = resolveHitSet({ ...INPUT, signal: first.signal }, { run: f.run })
    await flush()
    const scanSignal = f.scans()[0].signal as AbortSignal
    first.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    const second = resolveHitSet(INPUT, { run: f.run }) // arrives 300 ms later
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scanSignal.aborted).toBe(false)
    release()
    await expect(second).resolves.toMatchObject({ count: 3 })
    expect(f.scansStarted).toBe(1)
  })

  it('one of two waiters leaves: the scan goes on for the other', async () => {
    vi.useFakeTimers()
    const f = fake()
    let release!: () => void
    f.holdScan = new Promise<void>(resolve => { release = resolve })
    const leaving = new AbortController()
    const a = resolveHitSet({ ...INPUT, signal: leaving.signal }, { run: f.run })
    const b = resolveHitSet(INPUT, { run: f.run })
    await flush()
    leaving.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect((f.scans()[0].signal as AbortSignal).aborted).toBe(false)
    release()
    await expect(b).resolves.toMatchObject({ count: 3 })
  })

  it('a scan that was killed leaves nothing behind: no set, no "unstable" mark, and the next request scans again', async () => {
    vi.useFakeTimers()
    const f = fake()
    f.holdScan = new Promise<void>(() => {})
    const c = new AbortController()
    const waiting = resolveHitSet({ ...INPUT, signal: c.signal }, { run: f.run })
    await flush()
    c.abort()
    await expect(waiting).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    f.holdScan = null
    await expect(resolveHitSet(INPUT, { run: f.run })).resolves.toMatchObject({ count: 3 })
    expect(f.scansStarted).toBe(2)
    expect(warn).not.toHaveBeenCalled()
  })
})
