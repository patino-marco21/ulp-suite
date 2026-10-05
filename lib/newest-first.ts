/**
 * "Newest first" (sort=imported_desc) as exact time windows over proj_imported_desc.
 *
 * Why. The table is ordered by (domain, email, imported_at), so `ORDER BY imported_at DESC LIMIT 200` has no index to read
 * in order: it scans every matching row of every partition and sorts them. Measured on the live table (1.39B rows),
 * 2026-10-01, query cache and condition cache off: a plain browse took 40-48 s, a search for a popular domain 18 s, one for
 * accounts.google.com 45 s with 10 GiB of memory. proj_imported_desc IS sorted newest-first
 * (`negate(toUnixTimestamp(imported_at))`), but ClickHouse does not read a projection in order, and a predicate written on
 * `imported_at` does not range-prune it either: the newest 60 seconds written as `imported_at >= X` read all 495,875,196
 * rows of the newest partition (7.6 s). The same window written on the projection's own key expression read 200,384 rows (0.13 s).
 *
 * What. Run the query as disjoint time windows, newest first, each restricted by a predicate on that key expression, and stop
 * as soon as the page is full: a popular term fills it from the first window or two (the newest import burst is ~15,000
 * rows per second), a rare one walks on down and costs about what the single scan cost. The result is EXACT: every row in a
 * window is strictly newer than every row in the next one, and each window is ordered by the full ORDER BY, so the
 * concatenation is the global order and the first `want` rows are the global top `want`.
 *
 * Rare terms are the catch. The plain query prunes granules with the base table's skip indexes (bloom, ngram, text); a projection
 * has none, so for a term that is rare in the newest data the windows read far more than the plain query does (sandbox:
 * no-match and rare-domain searches took about twice as long windowed). So the windows get a small time budget, each next one is
 * 16x wider than the last (its cost is predicted from the last one), and when it will not fit they HAND OFF: the caller runs the
 * plain query, exactly as it did before this file existed. A rare term costs the plain query plus the ~0.5 s the first windows took.
 *
 * Nothing here knows the route's WHERE: the caller splices windowClause().sql into its own query and passes it `limit`.
 * Anything unexpected (projection not rebuilt yet, a ClickHouse error, a hand-off) is the caller's cue to run the plain query instead.
 */
import { PROJECTION_NAME } from '@/lib/projection-scope'

/** The projection's leading sort key, written verbatim (a test pins it to IMPORTED_DESC_PROJECTION_BODY): only this form range-prunes. */
export const IMPORTED_KEY_EXPR = 'negate(toUnixTimestamp(imported_at))'

/** First window: the newest minute. Each next one is 16x wider, so a table spanning 60 days is covered in 6 steps. */
const FIRST_SPAN_SECONDS = 60
const GROWTH = 16
/**
 * How long the windows may take, in total, before the plain query is run instead. Measured on the live projection (2026-10-01): the
 * newest minute costs 0.11-0.17 s, the next 15 minutes 0.4-1.1 s, the next 4 hours (the whole newest import burst, ~140M rows) 3.7-7.8 s.
 * At 2.5 s the first two windows fit and a third, predicted at 16x the second, does not: a term that fills its page from the newest
 * half hour finishes, anything rarer is handed back after ~0.5 s. Raising it would let mid-rare terms (a word like `ledger`, 8.8 s by
 * windows against 18 s plain) finish too, at the price of wasting more time on terms with no match; tune it from the timings the live
 * parity test prints (NFW_TIMING_ONLY=1).
 */
const HANDOFF_MS = 2_500
/** All windows of one request share the 300 s max_execution_time the plain query had, less a margin. */
const DEFAULT_DEADLINE_MS = 280_000

/** Epoch seconds. `upTo` is INCLUSIVE, `after` is EXCLUSIVE; null = open on that side. */
export interface TimeWindow {
  upTo: number | null
  after: number | null
}

type Row = Record<string, unknown>

/**
 * The windows to try, newest first. `upTo` is where the range tops out when something bounds it -- the cursor's second when
 * paging, an imported-range ceiling -- and is INCLUSIVE (rows of the same second that sort after the cursor row are still wanted; the
 * route's own keyset clause removes the rest); null leaves the top open. `floor` is the imported-range floor (INCLUSIVE): no row older than it can match,
 * so the last window closes just above it instead of staying open. Without a floor the last window is open below, so nothing
 * older than `oldest` is ever skipped.
 */
export function planWindows(a: { upTo: number | null; newest: number; oldest: number; floor?: number | null }): TimeWindow[] {
  // A ceiling at or above the newest row is no ceiling: hang the windows from the data, not from empty time above it.
  const ceiling = a.upTo !== null && a.upTo < a.newest ? a.upTo : null
  const top = ceiling ?? a.newest
  const bottom = a.floor != null && a.floor - 1 > a.oldest ? a.floor - 1 : null
  const stop = bottom ?? a.oldest
  const windows: TimeWindow[] = []
  let upTo = ceiling
  let span = FIRST_SPAN_SECONDS
  for (let i = 0; i < 40; i++) {
    const after = top - span
    if (after <= stop) {
      windows.push({ upTo, after: bottom })
      return windows
    }
    windows.push({ upTo, after })
    upTo = after
    span *= GROWTH
  }
  windows.push({ upTo, after: bottom })
  return windows
}

/** The WHERE fragment (" AND ...") and its Int64 parameters for one window. The key is -seconds, so the bounds swap and negate. */
export function windowClause(w: TimeWindow): { sql: string; params: Record<string, number> } {
  const parts: string[] = []
  const params: Record<string, number> = {}
  if (w.upTo !== null) {
    parts.push(` AND ${IMPORTED_KEY_EXPR} >= {nfwKeyLo:Int64}`)
    params.nfwKeyLo = w.upTo === 0 ? 0 : -w.upTo
  }
  if (w.after !== null) {
    parts.push(` AND ${IMPORTED_KEY_EXPR} < {nfwKeyHi:Int64}`)
    params.nfwKeyHi = w.after === 0 ? 0 : -w.after
  }
  return { sql: parts.join(''), params }
}

/**
 * Walks the windows until `want` rows are in hand. `runWindow` runs the caller's query for one window, asking for at most `limit`
 * rows. The first window always runs. Before each later one the cost is predicted as GROWTH times the last window's, and if that
 * does not fit in what is left of `budgetMs` the walk stops with `handedOff` set and no rows: the caller runs the plain query. A
 * page that fills is never handed off, and running out of windows with the page short is a complete answer (the whole range was read).
 */
export async function collectNewestFirst(a: {
  windows: TimeWindow[]
  want: number
  /** `projected`: the window lies wholly inside the projection's coverage, so the projection can answer it (skip indexes only hurt there). */
  runWindow: (clause: { sql: string; params: Record<string, number> }, limit: number, window: { projected: boolean }) => Promise<Row[]>
  /** Epoch second where the projection's coverage starts (the oldest row of the newest partition). */
  coveredFrom?: number | null
  budgetMs?: number
  now?: () => number
}): Promise<{ rows: Row[]; windowsRun: number; handedOff: boolean }> {
  const now = a.now ?? Date.now
  const budgetMs = a.budgetMs ?? HANDOFF_MS
  const startedAt = now()
  const rows: Row[] = []
  let windowsRun = 0
  let lastMs = 0

  for (let i = 0; i < a.windows.length && rows.length < a.want; i++) {
    if (i > 0 && now() - startedAt + lastMs * GROWTH >= budgetMs) return { rows: [], windowsRun, handedOff: true }
    const remaining = a.want - rows.length
    const windowStartedAt = now()
    const win = a.windows[i]
    const projected = a.coveredFrom != null && win.after !== null && win.after >= a.coveredFrom
    const got = await a.runWindow(windowClause(win), remaining, { projected })
    lastMs = now() - windowStartedAt
    windowsRun++
    rows.push(...got.slice(0, remaining))
  }
  return { rows, windowsRun, handedOff: false }
}

/** First row per key, in order, up to `limit` rows. Keys compare as text (a UInt64 hash can arrive as a string or a number). */
export function dedupeRows<T extends Row>(rows: T[], key: string, limit: number): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const k = String(row[key])
    if (seen.has(k)) continue
    seen.add(k)
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

type Run = (sql: string, params: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>

/**
 * Where the data starts and ends, in epoch seconds, from the partitions' min/max (answered from metadata, milliseconds), plus
 * the cursor's second when paging. Converting the cursor in ClickHouse keeps the table's own time zone out of this file, and parses
 * it exactly as the route's own `imported_at < {c_ia:DateTime}` does. The imported-range bound arrives already as epoch seconds
 * (lib/imported-range.ts): `ceilTs` is the newest second wanted and `floorTs` the oldest, both INCLUSIVE.
 * `upperTs` is the smaller of the cursor and the ceiling; `floorTs` is passed through. null when there is nothing usable
 * (empty table, junk answer): the caller runs the plain query.
 */
export async function readAnchors(
  run: Run,
  opts: { cursorImportedAt?: string | null; floorTs?: number | null; ceilTs?: number | null } = {},
): Promise<{ newest: number; oldest: number; upperTs: number | null; floorTs: number | null } | null> {
  const given = (v: string | null | undefined): v is string => typeof v === 'string' && v !== ''
  const params: Record<string, unknown> = {}
  let sql = `SELECT toUnixTimestamp(max(imported_at)) AS newest, toUnixTimestamp(min(imported_at)) AS oldest`
  if (given(opts.cursorImportedAt)) {
    sql += `, toUnixTimestamp(toDateTime({nfwCursor:String})) AS cursor_ts`
    params.nfwCursor = opts.cursorImportedAt
  }
  sql += ` FROM ulp.credentials`

  const [row] = await run(sql, params)
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
  const newest = num(row?.newest)
  const oldest = num(row?.oldest)
  if (newest === null || oldest === null) return null

  const cursorTs = given(opts.cursorImportedAt) ? num(row?.cursor_ts) : null
  if (given(opts.cursorImportedAt) && cursorTs === null) return null
  const bound = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const uppers = [cursorTs, bound(opts.ceilTs)].filter((v): v is number => v !== null)
  return { newest, oldest, upperTs: uppers.length ? Math.min(...uppers) : null, floorTs: bound(opts.floorTs) }
}

/** What a route needs to run its query newest-first: everything else (readiness, anchors, windows, the time budget) is here. */
export async function runNewestFirst(a: {
  run: (sql: string, params?: Record<string, unknown>) => Promise<Row[]>
  /** The route's data query for one window: splice `windowSql` into its WHERE, end it with `LIMIT {nfwLimit:UInt32}`, and use the budget as max_execution_time. */
  buildWindowSql: (windowSql: string, budgetSeconds: number, window: { projected: boolean }) => string
  /** Parameters of the route's own query (search terms, filters, cursor). */
  baseParams: Record<string, unknown>
  /** Rows wanted in total (the page, or the page times the de-duplication window). */
  want: number
  /** The cursor's imported_at when paging. */
  cursorImportedAt?: string | null
  /** The imported-range bound as epoch seconds (lib/imported-range.ts): the oldest and the newest second wanted, both INCLUSIVE. They bound the windows. */
  floorTs?: number | null
  ceilTs?: number | null
  /** Hard limit for every window together (their max_execution_time); default 280 s, like the plain query's 300 s. */
  deadlineMs?: number
  /** Soft limit: when the windows are predicted to run past it, give up and return null (default HANDOFF_MS). */
  handoffMs?: number
  now?: () => number
}): Promise<Row[] | null> {
  const now = a.now ?? Date.now
  const status = await getNewestFirstStatus(sql => a.run(sql))
  if (!status.ready) return null
  const anchors = await readAnchors((sql, params) => a.run(sql, params), {
    cursorImportedAt: a.cursorImportedAt, floorTs: a.floorTs, ceilTs: a.ceilTs,
  })
  if (!anchors) return null
  // A range that lies wholly older than the projection (a ceiling in July, say) is the plain query's: every window would run on the
  // base table, with nothing to prune them but the minmax index, and then hand off anyway.
  if (anchors.upperTs !== null && status.coveredFrom !== null && anchors.upperTs < status.coveredFrom) return null

  const deadline = now() + (a.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const windows = planWindows({ upTo: anchors.upperTs, newest: anchors.newest, oldest: anchors.oldest, floor: anchors.floorTs })
  const { rows, handedOff } = await collectNewestFirst({
    windows,
    want: a.want,
    budgetMs: a.handoffMs,
    coveredFrom: status.coveredFrom,
    now,
    runWindow: (clause, limit, window) => {
      const budgetSeconds = Math.max(5, Math.min(300, Math.floor((deadline - now()) / 1000)))
      return a.run(a.buildWindowSql(clause.sql, budgetSeconds, window), { ...a.baseParams, ...clause.params, nfwLimit: limit })
    },
  })
  return handedOff ? null : rows
}

// ── Readiness ────────────────────────────────────────────────────────────────

/**
 * Metadata only. Ready means: the projection has the definition this file relies on (it carries is_noise and content_key_hash,
 * the two columns the default Declutter + Unique view needs; an older projection without them cannot serve that query and
 * every window would scan the base table) AND every active part of the newest partition carries it. Older partitions may lack
 * it (they are outside the projection's recency window); windows that reach them are just slower, never wrong.
 * `covered_from` is the oldest second in the newest partition: where the projection's coverage starts.
 */
export function buildNewestFirstReadySql(): string {
  return `WITH (SELECT max(partition) FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active) AS newest_partition
SELECT
  (SELECT count() FROM system.projections
    WHERE database = 'ulp' AND table = 'credentials' AND name = '${PROJECTION_NAME}'
      AND position(query, 'is_noise') > 0 AND position(query, 'content_key_hash') > 0) AS defined,
  (SELECT count() FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = newest_partition) AS parts,
  (SELECT count() FROM system.projection_parts
    WHERE database = 'ulp' AND table = 'credentials' AND name = '${PROJECTION_NAME}' AND active
      AND partition = newest_partition) AS with_projection,
  (SELECT toUnixTimestamp(min(min_time)) FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = newest_partition) AS covered_from`
}

export interface NewestFirstStatus {
  ready: boolean
  /** Epoch second where the projection's coverage starts; null unless ready. */
  coveredFrom: number | null
}

const READY_TTL_MS = 60_000
const FAILED_TTL_MS = 5_000
const NOT_READY: NewestFirstStatus = { ready: false, coveredFrom: null }
let readyCache: { at: number; ttl: number; value: NewestFirstStatus } | null = null
let readyInflight: Promise<NewestFirstStatus> | null = null

export function resetNewestFirstReadyCache(): void {
  readyCache = null
  readyInflight = null
}

/** Fails CLOSED (any error or odd answer = not ready); the answer is cached for a minute, a failure for five seconds. */
export async function getNewestFirstStatus(
  run: (sql: string) => Promise<Array<Record<string, unknown>>>,
  now: () => number = Date.now,
): Promise<NewestFirstStatus> {
  const t = now()
  if (readyCache && t - readyCache.at < readyCache.ttl) return readyCache.value
  if (readyInflight) return readyInflight

  readyInflight = (async () => {
    let value = NOT_READY
    let ttl = FAILED_TTL_MS
    try {
      const [row] = await run(buildNewestFirstReadySql())
      const defined = Number(row?.defined)
      const parts = Number(row?.parts)
      const withProjection = Number(row?.with_projection)
      const coveredFrom = Number(row?.covered_from)
      if (defined === 1 && Number.isFinite(parts) && parts > 0 && parts === withProjection && Number.isFinite(coveredFrom) && coveredFrom > 0) {
        value = { ready: true, coveredFrom }
        ttl = READY_TTL_MS
      }
    } catch (err) {
      console.warn('[newest-first] readiness check failed -- using the plain query:', err instanceof Error ? err.message : String(err))
    }
    readyCache = { at: now(), ttl, value }
    return value
  })()
  try {
    return await readyInflight
  } finally {
    readyInflight = null
  }
}

export async function isNewestFirstReady(
  run: (sql: string) => Promise<Array<Record<string, unknown>>>,
  now: () => number = Date.now,
): Promise<boolean> {
  return (await getNewestFirstStatus(run, now)).ready
}
