/**
 * The split of a site's logins by type, e-mail / phone / user name / other (design: docs/superpowers/specs/2026-11-21-site-directory-design.md). It is a
 * query on the stored `login_type` column over the same rows as the site's count: the host and every subdomain, found by the reversed-domain key
 * (lib/site-counts.ts explains why a suffix match needs it). It is worked out when a directory row with none is opened, and again by the refresh for a
 * split that exists; it is never part of a count, because reading `login_type` made the planner read 4 to 10 times the rows (spec, "Measured").
 *
 * At most BREAKDOWN_MAX_PARALLEL run at once in the app: a closed connection does not stop a ClickHouse query, so a quick run of clicks on broad sites
 * would otherwise pile up reads of 18 GiB each.
 */
import { executeQuery } from '@/lib/clickhouse'
import { isDomainRevProjectionReady } from '@/lib/credentials-projections'
import { readLiveState } from '@/lib/search-dictionary'
import { isTooBroad } from '@/lib/site-counts'
import { getSite, siteExists, storeBreakdown } from '@/lib/site-directory'
import type { BreakdownCounts } from '@/lib/site-directory-input'
import { isMarkableHost } from '@/lib/site-marks-input'

export const BREAKDOWN_QUERY_SECONDS = 20
export const BREAKDOWN_MAX_PARALLEL = 2

/**
 * Chosen by measurement (spec, "Measured"): the ranges in PREWHERE read 2.6 M rows on average against 15.4 M for the plain WHERE over six sites from a few
 * hundred rows to 110 M, with identical counts, because `login_type` is then read only for the granules the ranges leave.
 */
const USE_PREWHERE = true

const TOO_BROAD_MESSAGE = 'too broad to break down in the time allowed'
const UNAVAILABLE_MESSAGE = 'The split cannot be worked out right now (the index that finds subdomains is being rebuilt). Try again in a few minutes.'

export class BreakdownError extends Error {
  constructor(message: string, readonly kind: 'too_broad' | 'unavailable') {
    super(message)
    this.name = 'BreakdownError'
  }
}

export function breakdownSql(host: string): { sql: string; params: Record<string, string> } {
  const filter = `reverse(domain) = reverse({host:String}) OR startsWith(reverse(domain), reverse(concat('.', {host:String})))`
  return {
    sql: `SELECT login_type, count() AS n
FROM ulp.credentials
${USE_PREWHERE ? 'PREWHERE' : 'WHERE'} ${filter}
GROUP BY login_type
SETTINGS max_execution_time = ${BREAKDOWN_QUERY_SECONDS}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, max_projection_rows_to_use_projection_index = 200000000`,
    params: { host },
  }
}

/** 64-bit integers come back from ClickHouse's JSON as strings. A blank or unknown type is "other", so the four parts always add up to the site's rows. */
export function bucketsFromRows(rows: unknown[]): BreakdownCounts {
  const counts: BreakdownCounts = { email: 0, phone: 0, username: 0, other: 0 }
  for (const raw of rows as Array<{ login_type: string; n: string | number }>) {
    const key = raw.login_type === 'email' || raw.login_type === 'phone' || raw.login_type === 'username' ? raw.login_type : 'other'
    counts[key] += Number(raw.n)
  }
  return counts
}

/** At most `max` tasks at once; a freed slot is handed straight to the first waiter, so the count never exceeds `max` for an instant. */
export function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active += 1
    else await new Promise<void>(resolve => waiters.push(resolve)) // the slot is handed over: `active` stays as it is
    try {
      return await task()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else active -= 1
    }
  }
}

const limiter = createLimiter(BREAKDOWN_MAX_PARALLEL)

/** The split of one site. Throws BreakdownError('unavailable') without the reversed-domain key on every part, BreakdownError('too_broad') past the time limit. */
export function breakdownFor(host: string): Promise<BreakdownCounts> {
  return limiter(async () => {
    if (!(await isDomainRevProjectionReady(sql => executeQuery(sql)))) throw new BreakdownError(UNAVAILABLE_MESSAGE, 'unavailable')
    const { sql, params } = breakdownSql(host)
    try {
      return bucketsFromRows(await executeQuery(sql, params))
    } catch (err) {
      if (isTooBroad(err)) throw new BreakdownError(TOO_BROAD_MESSAGE, 'too_broad')
      throw err
    }
  })
}

/** For the refresh: works the split out and stores it against the fingerprint the refresh is running at. */
export async function breakdownAndStore(host: string, fingerprint: string | null): Promise<void> {
  storeBreakdown(host, await breakdownFor(host), fingerprint)
}

export interface BreakdownReply {
  status: number
  json: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** POST /api/lookup/directory/breakdown: `{ host }` of a site that is in the directory; answers with the site as the list sends it. */
export async function answerBreakdown(rawBody: unknown): Promise<BreakdownReply> {
  const host = isObject(rawBody) && typeof rawBody.host === 'string' ? rawBody.host : ''
  if (!isMarkableHost(host)) {
    return { status: 400, json: { success: false, error: '"host" must be a site as the counts name it, for example corp.example (no scheme, path, port or www.)' } }
  }
  if (!siteExists(host)) return { status: 404, json: { success: false, error: 'That site is not in the directory' } }
  try {
    // Read BEFORE working the split out: rows that arrive meanwhile leave it out of date for the next refresh.
    const fingerprint = (await readLiveState())?.fingerprint ?? null
    await breakdownAndStore(host, fingerprint)
    return { status: 200, json: { success: true, site: getSite(host) } }
  } catch (error) {
    if (error instanceof BreakdownError) {
      return { status: error.kind === 'too_broad' ? 504 : 503, json: { success: false, error: error.message } }
    }
    console.error('site directory breakdown error:', error)
    return { status: 500, json: { success: false, error: 'Working out the split failed' } }
  }
}
