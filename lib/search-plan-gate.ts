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
import { EMAIL_DOMAIN_REV_PROJECTION_NAME } from '@/lib/credentials-projections'

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

// ── the word plan (plan 2026-10-13-word-search-plan.md, calibrated on 38 real words) ────────────────────────────────────────

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Which requests the word plan answers. Measured on the live table (1.84B rows, 2026-10-13, 38 words inside the dictionary caps, domain A-Z, cold):
 * its three branches cost very differently. T (the text indexes) took 0.5-2.6 s and H (the hosts that contain the word) 0.1-3.1 s for every word with
 * at most 300 candidate domains. E (the e-mail domains that contain the word) took 0.3-1.0 s when at most about 200 rows have such an e-mail domain,
 * 2-8 s for about 400 to 900 rows, 6-26 s from about 1,400 to 7,900: it fetches each row from the base table by position, because proj_email_domain_rev
 * holds positions only, so its cost follows the granules those rows sit in. The number of ROWS behind the matching e-mail domains is therefore what
 * decides, and one cheap probe gives it (0.1-0.4 s, probeEmailDomainRows). The number of candidate e-mail DOMAINS and the text-index hit count did
 * not separate wins from losses (a word with 97,000 hits won 2.3 times; one with 1,800 hits lost 1.4 times), so neither is a gate.
 *   rows   at most 300 candidate domains and at most 300 such rows: 14 of 14 words won, 2.9 to 14 times faster than today's rows query
 *          (plan 1.2-4.6 s, today 9-19 s). From about 1,400 such rows the plan lost (up to 4.5 times slower).
 *   totals at most 5,000 such rows: every word tried won (1.7 to 14.5 times; the slowest plan took 10.1 s). At 6,700-7,900 such rows the plan took
 *          8.4-12.6 s against 14-15 s, too close to its 12 s budget to be worth the risk.
 * The limits are tunable by the environment.
 */
export const wordRowsMaxDomains = (env: Env = process.env): number => envInt(env.SEARCH_WORD_ROWS_MAX_DOMAINS, 300)
export const wordRowsMaxEmailRows = (env: Env = process.env): number => envInt(env.SEARCH_WORD_ROWS_MAX_EMAIL_ROWS, 300)
export const wordTotalsMaxEmailRows = (env: Env = process.env): number => envInt(env.SEARCH_WORD_TOTALS_MAX_EMAIL_ROWS, 5_000)
/** The rows plan may take this long: the slowest word the gate admits took 4.6 s (today's rows query takes 9-19 s); over it, today's query runs. */
export const WORD_ROWS_BUDGET_SECONDS = 8
/** The totals plan may take this long: the slowest admitted word took 10.1 s (today's count takes 13-22 s); over it, today's count runs. */
export const WORD_TOTALS_BUDGET_SECONDS = 12

/** Whether the rows request may use the word plan. `emailRows` is probeEmailDomainRows' answer (0 when there is no e-mail candidate; null = the probe failed). */
export function wordRowsGate(c: { domains: string[] }, emailRows: number | null, env: Env = process.env): boolean {
  return emailRows !== null && emailRows <= wordRowsMaxEmailRows(env) && c.domains.length <= wordRowsMaxDomains(env)
}

/** Whether the totals request may use the word plan (the candidates already fit the dictionary caps). */
export function wordTotalsGate(emailRows: number | null, env: Env = process.env): boolean {
  return emailRows !== null && emailRows <= wordTotalsMaxEmailRows(env)
}

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

/** After an overrun the plan is not tried again for the same key for this long: the next requests go straight to today's query. */
const OVERRUN_TTL_MS = 600_000
const OVERRUN_MAX_KEYS = 500
const overruns = new Map<string, number>()

/**
 * Runs a plan's query. The budget is the max_execution_time in the plan's own SQL; when it is exceeded, or the plan fails for any other reason, the
 * answer is `ok: false` and the caller runs today's query. Never throws, and a plan's timeout is never a 408: today's query has its own 300 s.
 * With a `key` (the plan and the word), an OVERRUN is remembered for ten minutes: the page turns and filter changes of that search then skip the plan
 * instead of paying its budget again. Only a timeout is remembered; any other failure may be transient.
 */
export async function runWithBudget<T>(label: string, run: () => Promise<T>, key?: string, now: () => number = Date.now): Promise<Budgeted<T>> {
  if (key !== undefined) {
    const at = overruns.get(key)
    if (at !== undefined && now() - at < OVERRUN_TTL_MS) return { ok: false, reason: 'budget' }
  }
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    const budget = isTimeoutError(err)
    if (budget && key !== undefined) {
      overruns.delete(key)
      overruns.set(key, now())
      while (overruns.size > OVERRUN_MAX_KEYS) overruns.delete(overruns.keys().next().value as string)
    }
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
  overruns.clear()
}

/** A count by `run(sql, params)`, read from the column `column`, cached ten minutes per `key` (a failure for one minute); concurrent callers share the one query. */
function cachedCount(key: string, column: string, sql: string, params: Record<string, unknown>, what: string, deps: GateDeps): Promise<number | null> {
  const run: Run = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const t = now()
  const hit = probes.get(key)
  if (hit && t - hit.at < hit.ttl) return hit.value

  const entry: ProbeEntry = { at: t, ttl: VERDICT_TTL_MS, value: Promise.resolve(null) }
  entry.value = run(sql, params)
    .then(rows => {
      const n = Number(rows[0]?.[column])
      if (rows[0]?.[column] === undefined || !Number.isFinite(n) || n < 0) throw new Error('the probe did not return a count')
      return n
    })
    .catch((err: unknown) => {
      entry.ttl = FAILURE_TTL_MS
      console.warn(`[search-plan] ${what} probe failed -- using the plain query:`, errorMessage(err))
      return null
    })
  probes.delete(key)
  probes.set(key, entry)
  while (probes.size > CACHE_MAX_TOKENS) probes.delete(probes.keys().next().value as string)
  return entry.value
}

/**
 * How many rows have `word` as a whole token in url, email or password, counted through the text indexes (direct read) and capped at
 * PROBE_CAP_ROWS; null when the probe failed. `word` is lowercase letters and digits. Cached ten minutes per word (a failure for one minute);
 * concurrent callers share the one query.
 */
export function probeTokenHits(word: string, deps: GateDeps = {}): Promise<number | null> {
  return cachedCount(`hits\u0000${word}`, 'hits', PROBE_SQL, { tok: word, cap: PROBE_CAP_ROWS }, 'token', deps)
}

/**
 * How many rows have an e-mail domain in the word plan's candidate list (`emailRevLiteral`: the reversed domains as an array literal, the key of
 * proj_email_domain_rev), counted through that projection (0.1-0.4 s); null when the probe failed. It is the cost driver of branch E, see the gates.
 * Cached ten minutes per word; concurrent callers share the one query.
 */
export function probeEmailDomainRows(word: string, emailRevLiteral: string, deps: GateDeps = {}): Promise<number | null> {
  const sql = `SELECT count() AS rows FROM ulp.credentials WHERE reverse(email_domain) IN ${emailRevLiteral} `
    + `SETTINGS use_query_cache = 0, optimize_use_projections = 1, preferred_optimize_projection_name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}', max_execution_time = ${PROBE_TIMEOUT_SECONDS}`
  return cachedCount(`email-rows\u0000${word}`, 'rows', sql, {}, 'e-mail rows', deps)
}
