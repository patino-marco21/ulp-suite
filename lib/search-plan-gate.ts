/**
 * What the token plans share (docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md): the substring plan
 * (lib/search-substring-plan.ts) today, the word plan next.
 *
 * A token plan ANDs a prunable text-index condition onto today's query and keeps every other part of it, so its answer equals today's. It is only
 * worth running when that condition is selective, which a cheap probe through the text indexes tells (0.13 s for a word that matches 1.5 billion
 * rows once the count is capped, 0.3 s for a rare one: measured on the live table, 2026-10-13); and it is only worth waiting for within a budget well
 * under today's query. So every plan has a kill switch, a gate on the probe's count, a time budget that THROWS (ClickHouse's own max_execution_time on
 * the plan's query) and a fallback that runs today's query whenever the plan is not eligible, over the gate, over its budget or failing.
 */
import { executeQuery } from '@/lib/clickhouse'
import { wordLeaves } from '@/lib/ulp-search'
import type { Run } from '@/lib/search-dictionary'

type Env = Record<string, string | undefined>

/** SEARCH_TOKEN_PLANS=0 (or false, off, no) switches every token plan off; absent or anything else leaves them on. */
export function searchTokenPlansEnabled(env: Env = process.env): boolean {
  const v = (env.SEARCH_TOKEN_PLANS ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(v)
}

// ── the measured constants ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The substring plan runs when the rarest whole word of the text matches at most this many rows. The cost follows how many granules hold a hit:
 * a word with 1,158 hits answered in 0.5 s, 21,643 in 2.5 s, 39,772 in 10.7 s, 96,045 in 19 s (only 2x better than today's 35-42 s).
 */
export const SUBSTRING_GATE_HITS = 50_000
/** The plan's query may take this long (today's takes 35 s or more). Over it, today's query runs. */
export const SUBSTRING_BUDGET_SECONDS = 15
/** At most this many whole words of one text are probed, the longest first (long words are rarer). */
export const SUBSTRING_MAX_PROBES = 8
/** A probe counts up to this many rows and stops: one above the biggest gate, so "over the gate" is visible without counting further. */
export const PROBE_CAP_ROWS = SUBSTRING_GATE_HITS + 1
/**
 * The plans read the base table only. A projection part has no text index, so there `hasToken` runs as the plain function, which is case-SENSITIVE
 * (the index lowercases through its preprocessor), and would silently drop rows that LIKE matches (see isIndexNeutralSearch in lib/ulp-search.ts).
 */
export const PLAN_PROJECTIONS_OFF = 'optimize_use_projections = 0'

const PROBE_TIMEOUT_SECONDS = 8
const VERDICT_TTL_MS = 600_000
const FAILURE_TTL_MS = 60_000
const CACHE_MAX_TOKENS = 500

// ── the budget ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A ClickHouse time limit, however it reaches us (the same test the routes use). */
export function isTimeoutError(err: unknown): boolean {
  const msg = errorMessage(err)
  return msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')
}

export type Budgeted<T> = { ok: true; value: T } | { ok: false; reason: 'budget' | 'error' }

/**
 * Runs a plan's query. The budget is the max_execution_time in the plan's own SQL; when it is exceeded, or the plan fails for any other reason, the
 * answer is `ok: false` and the caller runs today's query. Never throws, and a plan's timeout is never a 408: today's query has its own 300 s.
 */
export async function runWithBudget<T>(label: string, run: () => Promise<T>): Promise<Budgeted<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    const budget = isTimeoutError(err)
    console.warn(`[search-plan] ${label} ${budget ? 'ran over its time budget' : 'failed'} -- using the plain query${budget ? '' : `: ${errorMessage(err)}`}`)
    return { ok: false, reason: budget ? 'budget' : 'error' }
  }
}

// ── the probe ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GateDeps {
  run?: Run
  now?: () => number
}

const PROBE_SQL = `SELECT count() AS hits FROM (SELECT 1 FROM ulp.credentials WHERE ${wordLeaves('tok')} LIMIT {cap:UInt32}) `
  + `SETTINGS use_query_cache = 0, ${PLAN_PROJECTIONS_OFF}, max_execution_time = ${PROBE_TIMEOUT_SECONDS}`

interface ProbeEntry { at: number; ttl: number; value: Promise<number | null> }
const probes = new Map<string, ProbeEntry>()

export function resetSearchPlanGateCache(): void {
  probes.clear()
}

/**
 * How many rows have `word` as a whole token in url, email or password, counted through the text indexes (direct read) and capped at
 * PROBE_CAP_ROWS; null when the probe failed. `word` is lowercase letters and digits. Cached ten minutes per word (a failure for one minute);
 * concurrent callers share the one query.
 */
export function probeTokenHits(word: string, deps: GateDeps = {}): Promise<number | null> {
  const run: Run = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const t = now()
  const hit = probes.get(word)
  if (hit && t - hit.at < hit.ttl) return hit.value

  const entry: ProbeEntry = { at: t, ttl: VERDICT_TTL_MS, value: Promise.resolve(null) }
  entry.value = run(PROBE_SQL, { tok: word, cap: PROBE_CAP_ROWS })
    .then(rows => {
      const n = Number(rows[0]?.hits)
      if (rows[0]?.hits === undefined || !Number.isFinite(n) || n < 0) throw new Error('the probe did not return a count')
      return n
    })
    .catch((err: unknown) => {
      entry.ttl = FAILURE_TTL_MS
      console.warn('[search-plan] token probe failed -- using the plain query:', errorMessage(err))
      return null
    })
  probes.delete(word)
  probes.set(word, entry)
  while (probes.size > CACHE_MAX_TOKENS) probes.delete(probes.keys().next().value as string)
  return entry.value
}
