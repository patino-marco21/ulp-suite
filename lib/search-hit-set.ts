/**
 * The hit-set plan (design: docs/superpowers/specs/2026-10-26-slow-search-latency-design.md).
 *
 * The problem. A text with a special character in it (a URL with a path, `user:pass`, a space) is searched as
 * `url LIKE '%x%' OR email LIKE '%x%' OR password LIKE '%x%'` (the `like` type, lib/ulp-search.ts). Nothing prunes that: every granule of three string columns
 * is read, 150 GiB and about 650 CPU-seconds on 2.2 billion rows, 57-66 s on a quiet machine. The page asks for the rows and for the totals at the same time,
 * so one search is two such scans (121 s and 130 s measured on the quiet machine), and a filter chip (the Email login type, a tier, ...) is a NEW query
 * with the same two scans again (140-260 s as logged on 2026-10-26, while earlier scans for the same search were still running).
 *
 * The observation. What such a search finds is tiny (49 rows for a real login-page search of the owner's) and the cost is all in finding it. Everything
 * else the page can ask for (a login type, a tier, Declutter, Unique, a sort, the next page, the totals) is a cheap filter over those few rows.
 *
 * The plan. Scan ONCE for the positions of the matching rows, `SELECT _part, _part_offset ... WHERE <the search> LIMIT cap + 1`, and keep them. Every rows
 * and totals query of that search then gets one more conjunct, `(_part = 'p' AND _part_offset IN (...)) OR ...`, and keeps every other part of today's
 * query, the search predicate included, so a position list that were too wide could only cost time. Measured on the live table (2.23 billion rows, one
 * real search): the scan 53.6 s, then totals + chip, rows + chip + Declutter, totals and rows without the chip each 0.2-0.3 s, and the legacy query's output
 * byte for byte the same (md5 of the result lines). The first search costs one scan instead of two simultaneous ones; every next click costs ~0.3 s.
 *
 * When the list is valid. Positions are positions in PARTS, and parts come and go: an import adds one (its rows were never scanned), a merge or a mutation
 * replaces some (their names, and the positions inside them, are gone). So the set carries the fingerprint of the table's active parts (the table uuid and every
 * part name) read BEFORE the scan, and it is used only while the table still has exactly those parts: re-read before the set is used, and again after the
 * answering queries ran. A scan that straddled a change is thrown away, and a search whose scan keeps being invalidated is left to today's query for two
 * minutes instead of scanning again and again. Any doubt (an error, a timeout, a change, more hits than the cap, a list that does not fit the SQL) means
 * today's query runs, as it did before this file existed.
 *
 * ClickHouse 26.3 facts this relies on (each measured, 2026-10-26):
 *  - closing the HTTP connection does not stop a statement sent with http_wait_end_of_query=1 (killQuery in lib/clickhouse.ts), so the scan runs under an id
 *    and is KILLed when nobody is waiting for it any more: the waiters are counted, the scan is killed when the last one has left;
 *  - positions refer to BASE parts, so the scan and the answering queries run with `optimize_use_projections = 0`: from a projection `_part_offset` would be
 *    a position in the projection part;
 *  - a `_part_offset` filter makes the planner move it to PREWHERE where the column does not exist, hence `optimize_move_to_prewhere = 0` (the same fix as
 *    branch E of lib/search-dictionary-plan.ts);
 *  - ClickHouse's query-condition cache is NOT a substitute: it writes an entry only when no skip index (here the login-type set index) filters the marks
 *    first and the planner reads the base table with a text-index hint, so a search with the chip on never left anything to reuse, and a text without an
 *    inner whole word never did.
 */
import { executeQuery } from '@/lib/clickhouse'
import { chStringLiteral } from '@/lib/clickhouse-literals'
import { searchTokenPlansEnabled } from '@/lib/search-plan-gate'

type Env = Record<string, string | undefined>
export type HitRun = (sql: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<Array<Record<string, unknown>>>

export interface HitSetDeps {
  run?: HitRun
  now?: () => number
}

// ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** SEARCH_HIT_SET=0 (or false, off, no) switches the plan off, and so does SEARCH_TOKEN_PLANS=0 (it switches every plan that prunes a text search off). */
export function searchHitSetEnabled(env: Env = process.env): boolean {
  const v = (env.SEARCH_HIT_SET ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(v) && searchTokenPlansEnabled(env)
}

/** Most hits the plan lists. The real searches that were measured found 49; the list travels in the SQL, hence the ceiling. */
export const HIT_SET_DEFAULT_MAX_HITS = 5_000
export const HIT_SET_CEILING_MAX_HITS = 15_000
export const searchHitSetMaxHits = (env: Env = process.env): number =>
  Math.max(1, Math.min(HIT_SET_CEILING_MAX_HITS, envInt(env.SEARCH_HIT_SET_MAX_HITS, HIT_SET_DEFAULT_MAX_HITS)))

/** The scan may take what today's query may. Over it the scan throws, and today's query runs. */
export const HIT_SET_SCAN_SECONDS = 300
/** The answering queries are cheap (0.2-0.3 s on the live table); over this, something is wrong and today's query runs. */
export const HIT_SET_ROWS_BUDGET_SECONDS = 20
export const HIT_SET_TOTALS_BUDGET_SECONDS = 20
/** Settings of every query that filters by position: base parts only, and no PREWHERE move of the `_part_offset` filter. */
export const HIT_SET_ANSWER_SETTINGS = 'optimize_use_projections = 0, optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0'

/** The conjunct must fit the SQL (max_query_size is 256 KiB, the rest of the query is about 10 KiB). */
export const HIT_SET_MAX_CONJUNCT_CHARS = 150_000

const SET_TTL_MS = 900_000
const UNSTABLE_TTL_MS = 120_000
const MAX_SETS = 32
const MAX_UNSTABLE = 200
/** A scan nobody waits for is killed after this long, unless a newer request for the same search joined in the meantime (a filter click replaces the page's requests). */
const KILL_GRACE_MS = 1_500
const FINGERPRINT_TIMEOUT_SECONDS = 10

// ── the fingerprint of the table's parts ────────────────────────────────────────────────────────────────────────────────────

/** One metadata query. The table uuid keeps a swapped table (the dedup swap) apart from its predecessor; the part names are what positions refer to. */
export const PARTS_FINGERPRINT_SQL = `SELECT
  toString(cityHash64((SELECT toString(uuid) FROM system.tables WHERE database = 'ulp' AND name = 'credentials'), arraySort(groupArray(name)))) AS fingerprint,
  count() AS parts
FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active
SETTINGS use_query_cache = 0, max_execution_time = ${FINGERPRINT_TIMEOUT_SECONDS}`

/** The fingerprint of the active parts now, or null when it cannot be read (then no plan: the answer must never rest on a guess). */
export async function currentPartsFingerprint(run: HitRun = executeQuery): Promise<string | null> {
  try {
    const rows = await run(PARTS_FINGERPRINT_SQL)
    const fingerprint = rows[0]?.fingerprint
    const parts = Number(rows[0]?.parts)
    return typeof fingerprint === 'string' && fingerprint !== '' && Number.isFinite(parts) && parts > 0 ? fingerprint : null
  } catch (err) {
    console.warn('[search-hit-set] could not read the parts fingerprint -- using the plain query:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── the set ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HitSet {
  /** The parts fingerprint the scan ran under: the set is good only while the table still has exactly those parts. */
  fingerprint: string
  /** The hits by part, offsets ascending; null when there were more than the cap (nothing is listed). */
  parts: Array<{ part: string; offsets: number[] }> | null
  /** How many hits were found: all of them when `parts` is listed, one more than the cap when it is null. */
  count: number
}

/** The scan: the positions of the rows the search matches, at most `hsCap` of them. `qClause` is buildULPWhere's clause, with its own named parameters. */
export function buildHitScanSql(qClause: string): string {
  return `SELECT _part AS part, _part_offset AS off FROM ulp.credentials WHERE (${qClause}) LIMIT {hsCap:UInt32} `
    + `SETTINGS use_query_cache = 0, optimize_use_projections = 0, max_execution_time = ${HIT_SET_SCAN_SECONDS}, timeout_overflow_mode = 'throw'`
}

/** Turns the scan's rows into a set; null when a row is not what the query selects (then no plan). */
export function toHitSet(rows: Array<Record<string, unknown>>, fingerprint: string, cap: number): HitSet | null {
  if (rows.length > cap) return { fingerprint, parts: null, count: rows.length }
  const byPart = new Map<string, number[]>()
  for (const r of rows) {
    const part = r.part
    const off = Number(r.off)
    if (typeof part !== 'string' || part === '' || !Number.isSafeInteger(off) || off < 0) return null
    const list = byPart.get(part)
    if (list) list.push(off)
    else byPart.set(part, [off])
  }
  const parts = [...byPart.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([part, offsets]) => ({ part, offsets: offsets.sort((a, b) => a - b) }))
  return { fingerprint, parts, count: rows.length }
}

/**
 * What the answering queries AND onto today's WHERE: the listed positions, by part. null when there is nothing to AND (no hits: the caller answers
 * an empty page and zero totals, see `isEmptyHitSet`), the set is not listed, or the text would not fit the SQL.
 */
export function hitSetConjunct(set: HitSet): string | null {
  if (!set.parts || set.parts.length === 0) return null
  const pieces = set.parts.map(p => `(_part = ${chStringLiteral(p.part)} AND _part_offset IN (${p.offsets.join(',')}))`)
  const sql = ` AND (${pieces.join(' OR ')})`
  return sql.length <= HIT_SET_MAX_CONJUNCT_CHARS ? sql : null
}

export const isEmptyHitSet = (set: HitSet): boolean => set.parts !== null && set.parts.length === 0

/** True while the table still has exactly the parts the set was scanned under. Call it after the answering queries ran, too. */
export async function hitSetStillCurrent(set: HitSet, run: HitRun = executeQuery): Promise<boolean> {
  return (await currentPartsFingerprint(run)) === set.fingerprint
}

// ── resolving a set: cache, one shared scan, a scan nobody waits for is killed ───────────────────────────────────────────

interface CacheEntry { set: HitSet; at: number }
interface Flight {
  promise: Promise<HitSet | null>
  controller: AbortController
  waiters: number
  killTimer: ReturnType<typeof setTimeout> | null
}

const sets = new Map<string, CacheEntry>()
const flights = new Map<string, Flight>()
/** Searches whose scan was invalidated or failed: no new scan for them for a while. */
const unstable = new Map<string, number>()

export function resetSearchHitSetCache(): void {
  sets.clear()
  unstable.clear()
  for (const f of flights.values()) { if (f.killTimer) clearTimeout(f.killTimer); f.controller.abort() }
  flights.clear()
}

const abortError = (): Error => Object.assign(new Error('Query aborted by client'), { name: 'AbortError' })

export interface ResolveInput {
  /** The identity of the search predicate: its clause and its parameters. */
  key: string
  /** buildULPWhere's clause (without the route's outer parentheses). */
  qClause: string
  /** buildULPWhere's parameters. */
  searchParams: Record<string, unknown>
  /** The request's signal: leaving early lets the shared scan be killed once no request is left waiting for it. */
  signal?: AbortSignal
  /** false: use a set that is already there, never start a scan (the next page of a search does not start a full-table scan). */
  allowScan?: boolean
}

async function runScan(input: ResolveInput, fingerprint: string, cap: number, run: HitRun, signal: AbortSignal): Promise<HitSet | null> {
  const rows = await run(buildHitScanSql(input.qClause), { ...input.searchParams, hsCap: cap + 1 }, signal)
  // The scan read the parts of ITS moment. If the table changed while it ran, the positions may name parts that are gone, or miss rows of new ones.
  if ((await currentPartsFingerprint(run)) !== fingerprint) return null
  return toHitSet(rows, fingerprint, cap)
}

function startFlight(ck: string, input: ResolveInput, fingerprint: string, run: HitRun, now: () => number): Flight {
  const controller = new AbortController()
  const cap = searchHitSetMaxHits()
  const flight: Flight = { promise: Promise.resolve(null), controller, waiters: 0, killTimer: null }
  flight.promise = runScan(input, fingerprint, cap, run, controller.signal)
    .then(set => {
      if (set) {
        sets.delete(ck)
        sets.set(ck, { set, at: now() })
        while (sets.size > MAX_SETS) sets.delete(sets.keys().next().value as string)
      } else {
        markUnstable(input.key, now)
      }
      return set
    })
    .catch((err: unknown) => {
      // An abort is nobody's failure; anything else (a timeout, a ClickHouse error) leaves the search to today's query for a while.
      if (!controller.signal.aborted) {
        markUnstable(input.key, now)
        console.warn('[search-hit-set] the position scan failed -- using the plain query:', err instanceof Error ? err.message : String(err))
      }
      return null
    })
    .finally(() => { if (flight.killTimer) clearTimeout(flight.killTimer); flights.delete(ck) })
  flights.set(ck, flight)
  return flight
}

function markUnstable(key: string, now: () => number): void {
  unstable.delete(key)
  unstable.set(key, now())
  while (unstable.size > MAX_UNSTABLE) unstable.delete(unstable.keys().next().value as string)
}

function join(flight: Flight, signal: AbortSignal | undefined): Promise<HitSet | null> {
  if (signal?.aborted) return Promise.reject(abortError())
  flight.waiters++
  if (flight.killTimer) { clearTimeout(flight.killTimer); flight.killTimer = null }
  return new Promise<HitSet | null>((resolve, reject) => {
    let settled = false
    const leave = () => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      flight.waiters--
    }
    const onAbort = () => {
      if (settled) return
      leave()
      if (flight.waiters === 0) {
        flight.killTimer = setTimeout(() => { if (flight.waiters === 0) flight.controller.abort() }, KILL_GRACE_MS)
        flight.killTimer.unref?.()
      }
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    flight.promise.then(set => { if (!settled) { leave(); resolve(set) } })
  })
}

/**
 * The set for this search under the table as it is now, or null when today's query should run (feature off, the parts cannot be read, the search's
 * scan is known to be unstable, no scan allowed and none cached, the scan failed or was invalidated). Cached for fifteen minutes per
 * (parts fingerprint, search); concurrent callers share the one scan. Rejects with an abort error when `input.signal` fires.
 */
export async function resolveHitSet(input: ResolveInput, deps: HitSetDeps = {}): Promise<HitSet | null> {
  if (!searchHitSetEnabled()) return null
  // A request that is already gone must not start a scan of 150 GiB for nobody (checked again below: the signal can fire while the parts are read).
  if (input.signal?.aborted) throw abortError()
  const run: HitRun = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const fingerprint = await currentPartsFingerprint(run)
  if (!fingerprint) return null
  if (input.signal?.aborted) throw abortError()

  const ck = `${fingerprint}\u0000${input.key}`
  const t = now()
  const cached = sets.get(ck)
  if (cached && t - cached.at < SET_TTL_MS) return cached.set
  if (cached) sets.delete(ck)

  const flying = flights.get(ck)
  if (flying) return join(flying, input.signal)
  if (input.allowScan === false) return null
  const failedAt = unstable.get(input.key)
  if (failedAt !== undefined && t - failedAt < UNSTABLE_TTL_MS) return null

  return join(startFlight(ck, input, fingerprint, run, now), input.signal)
}
