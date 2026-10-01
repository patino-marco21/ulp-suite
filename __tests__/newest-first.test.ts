import { describe, expect, test, vi, beforeEach } from 'vitest'
import {
  IMPORTED_KEY_EXPR,
  planWindows,
  windowClause,
  collectNewestFirst,
  dedupeRows,
  readAnchors,
  runNewestFirst,
  isNewestFirstReady,
  resetNewestFirstReadyCache,
  buildNewestFirstReadySql,
  type TimeWindow,
} from '@/lib/newest-first'
import { IMPORTED_DESC_PROJECTION_BODY } from '@/lib/credentials-projections'

/**
 * "Newest first" (sort=imported_desc) reads proj_imported_desc, whose primary key starts with negate(toUnixTimestamp(imported_at)).
 * ClickHouse only range-prunes that projection when the predicate is written on THAT expression: the same window written on
 * imported_at read all 495,875,196 rows of the newest partition (7.6 s); written on the key it read 200,384 (0.13 s), measured
 * 2026-10-01 on the live table. The query is therefore run as exact, disjoint time windows, newest first, until the page is full.
 */

describe('IMPORTED_KEY_EXPR', () => {
  test('is the projection\'s own leading sort key, verbatim, so the predicate can range-prune it', () => {
    expect(IMPORTED_DESC_PROJECTION_BODY).toContain(`ORDER BY ${IMPORTED_KEY_EXPR}`)
  })

  test('the projection carries every column the browse query filters and de-duplicates on', () => {
    for (const col of ['is_noise', 'content_key_hash']) expect(IMPORTED_DESC_PROJECTION_BODY).toMatch(new RegExp(`\\b${col}\\b`))
  })
})

describe('planWindows', () => {
  const NEWEST = 1_787_960_054
  const DAY = 86_400

  test('starts with a short window at the top and grows each one 16-fold', () => {
    const w = planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 60 * DAY })
    expect(w[0]).toEqual({ upTo: null, after: NEWEST - 60 })
    expect(w[1]).toEqual({ upTo: NEWEST - 60, after: NEWEST - 960 })
    expect(w[2]).toEqual({ upTo: NEWEST - 960, after: NEWEST - 15_360 })
  })

  test('windows are contiguous and disjoint: each one starts exactly where the previous ended', () => {
    const w = planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 60 * DAY })
    for (let i = 1; i < w.length; i++) expect(w[i].upTo).toBe(w[i - 1].after)
  })

  test('the last window is open at the bottom, so nothing older than the first rows is ever missed', () => {
    const w = planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 60 * DAY })
    expect(w[w.length - 1].after).toBeNull()
    expect(w.slice(0, -1).every(x => x.after !== null)).toBe(true)
  })

  test('stops adding windows once one reaches the oldest row', () => {
    const w = planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 60 * DAY })
    expect(w.length).toBeLessThanOrEqual(8)
    const penultimate = w[w.length - 2]
    expect(penultimate.after as number).toBeGreaterThan(NEWEST - 60 * DAY)
  })

  test('data that fits inside the first window is ONE window, open below', () => {
    expect(planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 30 })).toEqual([{ upTo: null, after: null }])
  })

  test('with a cursor the top of the first window is the cursor second, inclusive', () => {
    const cursorTs = NEWEST - 5 * DAY
    const w = planWindows({ upTo: cursorTs, newest: NEWEST, oldest: NEWEST - 60 * DAY })
    expect(w[0]).toEqual({ upTo: cursorTs, after: cursorTs - 60 })
  })

  test('a cursor older than everything leaves one open window', () => {
    expect(planWindows({ upTo: 100, newest: NEWEST, oldest: 200 })).toEqual([{ upTo: 100, after: null }])
  })

  test('a date floor closes the last window just above it instead of leaving it open', () => {
    const floor = NEWEST - 10 * DAY
    const w = planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 60 * DAY, floor })
    expect(w[w.length - 1].after).toBe(floor - 1)
    expect(w.slice(0, -1).every(x => (x.after as number) > floor - 1)).toBe(true)
    expect(w.length).toBeLessThan(planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 60 * DAY }).length + 1)
  })

  test('a floor older than the data changes nothing', () => {
    expect(planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 30 * DAY, floor: NEWEST - 90 * DAY }))
      .toEqual(planWindows({ upTo: null, newest: NEWEST, oldest: NEWEST - 30 * DAY }))
  })

  test('a range that is empty (the top is below the floor) is one window that matches nothing', () => {
    const w = planWindows({ upTo: 100, newest: NEWEST, oldest: 50, floor: 500 })
    expect(w).toEqual([{ upTo: 100, after: 499 }])
    const { params } = windowClause(w[0])
    expect(params.nfwKeyLo).toBeGreaterThanOrEqual(params.nfwKeyHi) // key >= -100 AND key < -499 can never hold
  })

  test('is deterministic and finite for a very wide range', () => {
    const w = planWindows({ upTo: null, newest: NEWEST, oldest: 0 })
    expect(w.length).toBeLessThan(12)
  })
})

describe('windowClause', () => {
  test('writes both bounds on the projection key, as named Int64 parameters', () => {
    const { sql, params } = windowClause({ upTo: 1_000_000, after: 999_000 })
    expect(sql).toBe(` AND ${IMPORTED_KEY_EXPR} >= {nfwKeyLo:Int64} AND ${IMPORTED_KEY_EXPR} < {nfwKeyHi:Int64}`)
    expect(params).toEqual({ nfwKeyLo: -1_000_000, nfwKeyHi: -999_000 })
  })

  test('an open top contributes no condition; an open bottom neither', () => {
    expect(windowClause({ upTo: null, after: 999_000 })).toEqual({ sql: ` AND ${IMPORTED_KEY_EXPR} < {nfwKeyHi:Int64}`, params: { nfwKeyHi: -999_000 } })
    expect(windowClause({ upTo: 1_000_000, after: null })).toEqual({ sql: ` AND ${IMPORTED_KEY_EXPR} >= {nfwKeyLo:Int64}`, params: { nfwKeyLo: -1_000_000 } })
    expect(windowClause({ upTo: null, after: null })).toEqual({ sql: '', params: {} })
  })

  test('the bounds never print as -0', () => {
    expect(String(windowClause({ upTo: 0, after: null }).params.nfwKeyLo)).toBe('0')
  })

  test('never uses imported_at directly in a comparison (that form reads the whole partition)', () => {
    expect(windowClause({ upTo: 5, after: 1 }).sql.replace(IMPORTED_KEY_EXPR, '')).not.toMatch(/\bimported_at\s*(<|>|=)/)
  })
})

describe('collectNewestFirst', () => {
  const windows: TimeWindow[] = [
    { upTo: null, after: 900 },
    { upTo: 900, after: 500 },
    { upTo: 500, after: 100 },
    { upTo: 100, after: null },
  ]
  const row = (ts: number, n = 0) => ({ imported_at: ts, n })

  test('concatenates windows in order and asks each for only what is still missing', async () => {
    const asked: Array<{ clause: string; limit: number }> = []
    const answers = [[row(950), row(940)], [row(800)], [row(400), row(300)], []]
    const run = vi.fn(async (c: { sql: string }, limit: number) => { asked.push({ clause: c.sql, limit }); return answers.shift() ?? [] })
    const { rows } = await collectNewestFirst({ windows, want: 5, runWindow: run })
    expect(rows.map(r => r.imported_at)).toEqual([950, 940, 800, 400, 300])
    expect(asked.map(a => a.limit)).toEqual([5, 3, 2])
  })

  test('stops as soon as the page is full: older windows are never queried', async () => {
    const run = vi.fn(async (_c: { sql: string }, limit: number) => Array.from({ length: limit }, (_, i) => row(1000 - i)))
    const out = await collectNewestFirst({ windows, want: 4, runWindow: run })
    expect(run).toHaveBeenCalledTimes(1)
    expect(out.rows).toHaveLength(4)
    expect(out.windowsRun).toBe(1)
  })

  test('runs every window, in order, when matches are rare, and returns what exists', async () => {
    const run = vi.fn(async (_c: { sql: string }, _limit: number) => [] as Array<Record<string, unknown>>)
    const out = await collectNewestFirst({ windows, want: 10, runWindow: run })
    expect(run).toHaveBeenCalledTimes(4)
    expect(out.rows).toEqual([])
  })

  test('never returns more than wanted even if a window misbehaves', async () => {
    const run = async () => [row(9), row(8), row(7), row(6)]
    const out = await collectNewestFirst({ windows, want: 3, runWindow: run })
    expect(out.rows).toHaveLength(3)
  })

  // The plain query prunes granules with the base table's skip indexes; a projection has none, so for a term that is rare in the newest
  // data the windows read far more than the plain query does (sandbox: no-match and rare-domain searches took ~2x as long windowed).
  // The windows therefore only get a small budget: each next window is 16x wider than the last, so its cost is predicted from the
  // last one, and when it will not fit the windows hand the request back to the plain query.
  test('the first window always runs, however small the budget', async () => {
    const run = vi.fn(async () => [] as Array<Record<string, unknown>>)
    const out = await collectNewestFirst({ windows, want: 5, runWindow: run, budgetMs: 0 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(out.handedOff).toBe(true)
  })

  test('hands off, running no further window, when the next window is predicted not to fit the budget', async () => {
    let clock = 0
    const run = vi.fn(async () => { clock += 400; return [] as Array<Record<string, unknown>> }) // 400 ms -> the next is predicted at 6.4 s
    const out = await collectNewestFirst({ windows, want: 5, runWindow: run, budgetMs: 2_500, now: () => clock })
    expect(run).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ handedOff: true, rows: [] })
  })

  test('keeps going while the predicted cost fits: quick windows walk on until the page is full', async () => {
    let clock = 0
    const answers = [[row(950)], [row(800)], [row(400), row(300)]]
    const run = vi.fn(async () => { clock += 10; return answers.shift() ?? [] })
    const out = await collectNewestFirst({ windows, want: 4, runWindow: run, budgetMs: 2_500, now: () => clock })
    expect(out.handedOff).toBe(false)
    expect(out.rows).toHaveLength(4)
    expect(run).toHaveBeenCalledTimes(3)
  })

  test('a page that fills in the first window is never handed off, even if that window was slow', async () => {
    let clock = 0
    const run = async (_c: { sql: string }, limit: number) => { clock += 9_000; return Array.from({ length: limit }, (_, i) => row(1000 - i)) }
    const out = await collectNewestFirst({ windows, want: 3, runWindow: run, budgetMs: 2_500, now: () => clock })
    expect(out.handedOff).toBe(false)
    expect(out.rows).toHaveLength(3)
  })

  test('running out of windows with the page short is a complete answer, not a hand-off', async () => {
    const run = vi.fn(async () => [] as Array<Record<string, unknown>>)
    const out = await collectNewestFirst({ windows, want: 10, runWindow: run, budgetMs: 1_000_000 })
    expect(run).toHaveBeenCalledTimes(4)
    expect(out.handedOff).toBe(false)
  })

  test('an error from a window propagates (the caller falls back to the plain query)', async () => {
    const run = vi.fn(async () => { throw new Error('boom') })
    await expect(collectNewestFirst({ windows, want: 3, runWindow: run })).rejects.toThrow('boom')
  })

  test('want of zero queries nothing', async () => {
    const run = vi.fn(async () => [])
    const out = await collectNewestFirst({ windows, want: 0, runWindow: run })
    expect(run).not.toHaveBeenCalled()
    expect(out.rows).toEqual([])
  })
})

describe('dedupeRows', () => {
  test('keeps the first row of each key, in order, up to the limit', () => {
    const rows = [{ k: 'a', n: 1 }, { k: 'b', n: 2 }, { k: 'a', n: 3 }, { k: 'c', n: 4 }, { k: 'd', n: 5 }]
    expect(dedupeRows(rows, 'k', 3).map(r => r.n)).toEqual([1, 2, 4])
  })

  test('compares keys as text, so a 64-bit hash returned as a string or a number collapses the same way', () => {
    expect(dedupeRows([{ k: '18446744073709551615', n: 1 }, { k: '18446744073709551615', n: 2 }], 'k', 5)).toHaveLength(1)
  })

  test('a limit larger than the distinct count returns them all', () => {
    expect(dedupeRows([{ k: 1 }, { k: 2 }], 'k', 10)).toHaveLength(2)
  })
})

describe('readAnchors', () => {
  test('reads the newest and oldest second in one cheap query, with no cursor and no dates', async () => {
    const run = vi.fn(async () => [{ newest: 1_787_960_054, oldest: 1_782_000_000 }])
    const a = await readAnchors(run)
    expect(a).toEqual({ newest: 1_787_960_054, oldest: 1_782_000_000, upperTs: null, floorTs: null })
    const [sql, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(sql).toMatch(/toUnixTimestamp\(max\(imported_at\)\)/)
    expect(sql).toMatch(/toUnixTimestamp\(min\(imported_at\)\)/)
    expect(params).toEqual({})
  })

  test('converts the cursor\'s imported_at to epoch seconds in ClickHouse, in the table\'s own time zone', async () => {
    const run = vi.fn(async () => [{ newest: 10, oldest: 1, cursor_ts: 7 }])
    const a = await readAnchors(run, { cursorImportedAt: '2026-08-16 20:40:54' })
    expect(a!.upperTs).toBe(7)
    const [sql, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(sql).toMatch(/toUnixTimestamp\(toDateTime\(\{nfwCursor:String\}\)\) AS cursor_ts/)
    expect(params).toEqual({ nfwCursor: '2026-08-16 20:40:54' })
  })

  test('date_from becomes a floor and date_to a ceiling; the upper bound is the smaller of the ceiling and the cursor', async () => {
    const run = vi.fn(async () => [{ newest: 100, oldest: 1, cursor_ts: 60, date_from_ts: 20, date_to_ts: 80 }])
    const a = await readAnchors(run, { cursorImportedAt: 'c', dateFrom: '2026-08-01 00:00:00', dateTo: '2026-08-20 23:59:59' })
    expect(a).toEqual({ newest: 100, oldest: 1, upperTs: 60, floorTs: 20 })
    const [sql, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(sql).toMatch(/\{nfwDateFrom:String\}/)
    expect(sql).toMatch(/\{nfwDateTo:String\}/)
    expect(params).toEqual({ nfwCursor: 'c', nfwDateFrom: '2026-08-01 00:00:00', nfwDateTo: '2026-08-20 23:59:59' })
    const b = await readAnchors(async () => [{ newest: 100, oldest: 1, date_to_ts: 80 }], { dateTo: 'x' })
    expect(b!.upperTs).toBe(80)
  })

  test('numbers that come back as strings are converted', async () => {
    const a = await readAnchors(async () => [{ newest: '1787960054', oldest: '1782000000' }])
    expect(a!.newest).toBe(1_787_960_054)
  })

  test('returns null when the table is empty or the answer is unusable', async () => {
    expect(await readAnchors(async () => [])).toBeNull()
    expect(await readAnchors(async () => [{ newest: 0, oldest: 0 }])).toBeNull()
    expect(await readAnchors(async () => [{ newest: 'x', oldest: 'y' }])).toBeNull()
    expect(await readAnchors(async () => [{ newest: 10, oldest: 1 }], { cursorImportedAt: 'c' })).toBeNull()
  })
})

describe('isNewestFirstReady', () => {
  beforeEach(() => resetNewestFirstReadyCache())
  const ready = { defined: 1, parts: 2, with_projection: 2 }

  test('ready only when the projection has the new definition AND every part of the newest partition carries it', async () => {
    expect(await isNewestFirstReady(async () => [ready])).toBe(true)
    resetNewestFirstReadyCache()
    expect(await isNewestFirstReady(async () => [{ ...ready, defined: 0 }])).toBe(false)
    resetNewestFirstReadyCache()
    expect(await isNewestFirstReady(async () => [{ ...ready, with_projection: 1 }])).toBe(false)
    resetNewestFirstReadyCache()
    expect(await isNewestFirstReady(async () => [{ defined: 1, parts: 0, with_projection: 0 }])).toBe(false)
  })

  test('fails CLOSED: an error, an empty answer or junk means "not ready"', async () => {
    expect(await isNewestFirstReady(async () => { throw new Error('down') })).toBe(false)
    resetNewestFirstReadyCache()
    expect(await isNewestFirstReady(async () => [])).toBe(false)
    resetNewestFirstReadyCache()
    expect(await isNewestFirstReady(async () => [{ defined: 'x' }])).toBe(false)
  })

  test('the answer is cached, so the check does not run on every request', async () => {
    const run = vi.fn(async () => [ready])
    let now = 1_000
    await isNewestFirstReady(run, () => now)
    await isNewestFirstReady(run, () => now + 30_000)
    expect(run).toHaveBeenCalledTimes(1)
    await isNewestFirstReady(run, () => now + 61_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('a failure is not cached for long: the next request tries again', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce([ready])
    expect(await isNewestFirstReady(run, () => 1_000)).toBe(false)
    expect(await isNewestFirstReady(run, () => 1_000 + 6_000)).toBe(true)
  })

  test('the check is metadata only: system.projections and system.parts, never the credentials table', () => {
    const sql = buildNewestFirstReadySql()
    expect(sql).toMatch(/system\.projections/)
    expect(sql).toMatch(/system\.projection_parts/)
    expect(sql).not.toMatch(/FROM ulp\.credentials/)
  })
})

describe('runNewestFirst', () => {
  beforeEach(() => resetNewestFirstReadyCache())
  const readyRow = { defined: 1, parts: 1, with_projection: 1 }
  const ANCHORS = { newest: 1_787_960_054, oldest: 1_782_000_000 }

  /** A scripted ClickHouse: answers the readiness query, the anchor query, then each window query from `windowAnswers`. */
  function fakeRun(opts: { ready?: Record<string, unknown> | null; anchors?: Record<string, unknown> | null; windowAnswers?: Array<Array<Record<string, unknown>>> } = {}) {
    const log: Array<{ sql: string; params: Record<string, unknown> }> = []
    const windowAnswers = [...(opts.windowAnswers ?? [])]
    const run = vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
      log.push({ sql, params })
      if (/system\.projections/.test(sql)) return opts.ready === null ? [] : [opts.ready ?? readyRow]
      if (/max\(imported_at\)/.test(sql)) return opts.anchors === null ? [] : [opts.anchors ?? ANCHORS]
      return windowAnswers.shift() ?? []
    })
    return { run, log }
  }
  const build = (windowSql: string, budgetSeconds: number) => `SELECT 1 /*${budgetSeconds}*/ WHERE 1=1${windowSql} LIMIT {nfwLimit:UInt32}`

  test('not ready: returns null and runs nothing but the metadata check', async () => {
    const { run, log } = fakeRun({ ready: { defined: 0, parts: 1, with_projection: 1 } })
    expect(await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5 })).toBeNull()
    expect(log).toHaveLength(1)
  })

  test('no usable anchors (empty table): returns null', async () => {
    const { run } = fakeRun({ anchors: null })
    expect(await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5 })).toBeNull()
  })

  test('walks the windows newest first with the caller\'s parameters, the window\'s bounds and the remaining limit', async () => {
    const { run, log } = fakeRun({ windowAnswers: [[{ n: 1 }, { n: 2 }], [{ n: 3 }]] })
    const out = await runNewestFirst({ run, buildWindowSql: build, baseParams: { tok0: 'x' }, want: 3 })
    expect(out!.map(r => r.n)).toEqual([1, 2, 3])
    const windowCalls = log.filter(c => c.sql.startsWith('SELECT 1'))
    expect(windowCalls).toHaveLength(2)
    expect(windowCalls[0].params).toMatchObject({ tok0: 'x', nfwLimit: 3, nfwKeyHi: -(ANCHORS.newest - 60) })
    expect(windowCalls[0].params).not.toHaveProperty('nfwKeyLo')
    expect(windowCalls[1].params).toMatchObject({ tok0: 'x', nfwLimit: 1, nfwKeyLo: -(ANCHORS.newest - 60), nfwKeyHi: -(ANCHORS.newest - 960) })
  })

  test('a cursor anchors the first window at the cursor\'s second', async () => {
    const { run, log } = fakeRun({ anchors: { ...ANCHORS, cursor_ts: 1_787_000_000 }, windowAnswers: [[{ n: 1 }]] })
    await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 1, cursorImportedAt: '2026-08-16 20:40:54' })
    const anchorCall = log.find(c => /max\(imported_at\)/.test(c.sql))!
    expect(anchorCall.params).toEqual({ nfwCursor: '2026-08-16 20:40:54' })
    const first = log.find(c => c.sql.startsWith('SELECT 1'))!
    expect(first.params).toMatchObject({ nfwKeyLo: -1_787_000_000, nfwKeyHi: -(1_787_000_000 - 60) })
  })

  test('a date range bounds the windows: nothing newer than date_to, nothing older than date_from is ever scanned', async () => {
    const { run, log } = fakeRun({
      anchors: { ...ANCHORS, date_from_ts: 1_786_000_000, date_to_ts: 1_787_000_000 },
      windowAnswers: [[], [], [], [], [], []],
    })
    await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5, dateFrom: '2026-08-01 00:00:00', dateTo: '2026-08-20 23:59:59' })
    const windowCalls = log.filter(c => c.sql.startsWith('SELECT 1'))
    expect(windowCalls[0].params.nfwKeyLo).toBe(-1_787_000_000)
    const last = windowCalls[windowCalls.length - 1]
    expect(last.params.nfwKeyHi).toBe(-(1_786_000_000 - 1))
    expect(windowCalls.length).toBeLessThan(6)
  })

  test('each window gets what is left of the time budget, in whole seconds, never less than 5', async () => {
    let clock = 0
    const seen: number[] = []
    const { run } = fakeRun({ windowAnswers: [[], [], []] })
    await runNewestFirst({
      run, baseParams: {}, want: 1, deadlineMs: 100_000, handoffMs: 10_000_000, now: () => (clock += 30_000),
      buildWindowSql: (w, secs) => { seen.push(secs); return build(w, secs) },
    })
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen[0]).toBeLessThanOrEqual(100)
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1])
  })

  test('a hand-off returns null, so the route runs the plain query (nothing partial is ever returned)', async () => {
    let clock = 0
    const log: string[] = []
    const run = vi.fn(async (sql: string, _params?: Record<string, unknown>) => {
      log.push(sql)
      if (/system\.projections/.test(sql)) return [readyRow]
      if (/max\(imported_at\)/.test(sql)) return [ANCHORS]
      clock += 5_000 // every window is slow
      return [{ n: 1 }]
    })
    const out = await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 50, now: () => clock })
    expect(out).toBeNull()
    expect(log.filter(q => q.startsWith('SELECT 1'))).toHaveLength(1)
  })

  test('an error from a window propagates so the route can decide (fall back, or answer 408)', async () => {
    const run = vi.fn(async (sql: string) => {
      if (/system\.projections/.test(sql)) return [readyRow]
      if (/max\(imported_at\)/.test(sql)) return [ANCHORS]
      throw new Error('Code: 241. MEMORY_LIMIT_EXCEEDED')
    })
    await expect(runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5 })).rejects.toThrow('MEMORY_LIMIT_EXCEEDED')
  })
})
