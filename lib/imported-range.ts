/**
 * The "imported after / imported before" bound shared by every surface that returns rows of ulp.credentials, or a list derived from
 * them (design: docs/superpowers/specs/2026-10-05-imported-after-filter-design.md).
 *
 * Semantics. `imported_after` is EXCLUSIVE and `imported_before` INCLUSIVE, both absolute UTC instants to the second, so windows
 * chained as (previous before, next before] never overlap and never leave a gap. A bare date includes its whole UTC day on its own
 * side. The legacy `date_from` / `date_to` are the same parameters under their old names: a bare date means exactly what it always did.
 *
 * SQL. Two forms of the same predicate. The PLAIN form is always correct and keeps the column bare on the left, so partition pruning
 * and the minmax index still apply. The PROJECTION form adds the same bound written on proj_imported_desc's key expression, the only
 * form that range-prunes that projection (see lib/newest-first.ts); it is used only where the measurements allow (planImportedRange).
 * Neither form ever sets `use_skip_indexes`: a projection part has no text index, so reading it turns `hasToken` case-sensitive and
 * silently drops mixed-case matches the table plan returns.
 */
import { IMPORTED_KEY_EXPR, getNewestFirstStatus } from '@/lib/newest-first'

/** Epoch seconds. `lower` is EXCLUSIVE, `upper` is INCLUSIVE; null leaves that side open. */
export interface ImportedRange {
  lower: number | null
  upper: number | null
}

export interface ImportedRangeInput {
  imported_after?: unknown
  imported_before?: unknown
  date_from?: unknown
  date_to?: unknown
}

export type ParsedImportedRange = { ok: true; range: ImportedRange } | { ok: false; error: string }

/** The top of ClickHouse's DateTime: 2106-02-07T06:28:15Z. */
const MAX_EPOCH = 4_294_967_295
const FORMS = 'a date (2026-10-05), a UTC date-time (2026-10-05 14:37:00) or an ISO-8601 time with an offset (2026-10-05T14:37:00-05:00)'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/i

type Side = 'after' | 'before'
interface Instant { epoch: number; bareDate: boolean }

/** Epoch seconds of a UTC calendar time, or null when the fields are not a real date (Feb 30, hour 25, year 0001, ...). */
function utcEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (h > 23 || mi > 59 || s > 59) return null
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return Math.floor(ms / 1000)
}

function parseInstant(text: string): Instant | null {
  const date = DATE_RE.exec(text)
  if (date) {
    const epoch = utcEpoch(+date[1], +date[2], +date[3], 0, 0, 0)
    return epoch === null ? null : { epoch, bareDate: true }
  }
  const dt = DATE_TIME_RE.exec(text)
  if (!dt) return null
  let epoch = utcEpoch(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], +dt[6])
  if (epoch === null) return null
  const zone = dt[7]
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    const hh = +digits.slice(0, 2)
    const mm = +digits.slice(2, 4)
    if (hh > 23 || mm > 59) return null
    epoch -= (zone[0] === '-' ? -1 : 1) * (hh * 3600 + mm * 60)
  }
  return { epoch, bareDate: false }
}

type One = { ok: true; bound: number | null } | { ok: false; error: string }

function parseOne(name: string, value: unknown, side: Side): One {
  if (value === undefined || value === null) return { ok: true, bound: null }
  if (typeof value !== 'string') return { ok: false, error: `${name} must be ${FORMS}` }
  const text = value.trim()
  if (text === '') return { ok: true, bound: null }
  const instant = parseInstant(text)
  if (!instant) return { ok: false, error: `${name} must be ${FORMS}` }
  if (instant.epoch < 0 || instant.epoch > MAX_EPOCH) {
    return { ok: false, error: `${name} is outside the supported range (1970-01-01 to 2106-02-07)` }
  }
  // A bare date includes its whole UTC day: "after" starts one second before midnight (the bound is exclusive), "before" ends at 23:59:59.
  if (side === 'after') {
    const lower = instant.bareDate ? instant.epoch - 1 : instant.epoch
    return { ok: true, bound: lower < 0 ? null : lower }
  }
  return { ok: true, bound: Math.min(MAX_EPOCH, instant.bareDate ? instant.epoch + 86_399 : instant.epoch) }
}

/**
 * Reads the four bound parameters (as strings, from a query string or a JSON body) into one range. `date_from` / `date_to` are the old
 * names of the same bounds; when both spellings are given the stricter bound wins. Absent or empty means open on that side. Anything
 * else that is not one of the accepted forms is an error naming the parameter.
 */
export function parseImportedRange(input: ImportedRangeInput): ParsedImportedRange {
  const lowers: number[] = []
  const uppers: number[] = []
  const fields: Array<[string, Side, unknown]> = [
    ['imported_after', 'after', input.imported_after],
    ['date_from', 'after', input.date_from],
    ['imported_before', 'before', input.imported_before],
    ['date_to', 'before', input.date_to],
  ]
  for (const [name, side, value] of fields) {
    const one = parseOne(name, value, side)
    if (!one.ok) return one
    if (one.bound !== null) (side === 'after' ? lowers : uppers).push(one.bound)
  }
  return {
    ok: true,
    range: {
      lower: lowers.length ? Math.max(...lowers) : null,
      upper: uppers.length ? Math.min(...uppers) : null,
    },
  }
}

/** The bound parameters of a GET request. */
export function importedRangeFromSearchParams(sp: URLSearchParams): ParsedImportedRange {
  return parseImportedRange({
    imported_after: sp.get('imported_after'),
    imported_before: sp.get('imported_before'),
    date_from: sp.get('date_from'),
    date_to: sp.get('date_to'),
  })
}

export function hasImportedRange(range: ImportedRange): boolean {
  return range.lower !== null || range.upper !== null
}

// ── Presentation: JSON echo, response headers, file names ─────────────────────────────────────────────────────────────────────────

/** `2026-08-28T23:30:00Z` */
export function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z')
}

/** The EFFECTIVE window (exclusive lower, inclusive upper) as ISO instants, for a JSON response to echo. */
export function importedRangeEcho(range: ImportedRange): { imported_after: string | null; imported_before: string | null } {
  return {
    imported_after: range.lower === null ? null : epochToIso(range.lower),
    imported_before: range.upper === null ? null : epochToIso(range.upper),
  }
}

/** The echo when a bound was given, else nothing, so a response to a caller that never uses the bound keeps its exact shape. */
export function importedRangeEchoIfSet(range: ImportedRange): { imported_after?: string | null; imported_before?: string | null } {
  return hasImportedRange(range) ? importedRangeEcho(range) : {}
}

/** `X-Export-Imported-After` / `-Before` headers for the bounds that are set. */
export function importedWindowHeaders(range: ImportedRange): Record<string, string> {
  const headers: Record<string, string> = {}
  if (range.lower !== null) headers['X-Export-Imported-After'] = epochToIso(range.lower)
  if (range.upper !== null) headers['X-Export-Imported-Before'] = epochToIso(range.upper)
  return headers
}

/** A file-name suffix that records the window: `_after-20261003T143700Z_before-20261005T143500Z`, or '' when there is none. */
export function importedWindowTag(range: ImportedRange): string {
  const compact = (epoch: number) => epochToIso(epoch).replace(/[-:]/g, '')
  return `${range.lower === null ? '' : `_after-${compact(range.lower)}`}${range.upper === null ? '' : `_before-${compact(range.upper)}`}`
}

// ── SQL ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportedRangeSql {
  /** Conditions to AND into a WHERE (no leading AND). */
  conditions: string[]
  /** Int64 query parameters the conditions refer to. */
  params: Record<string, number>
}

/** The key is -seconds, so the bounds swap and negate; `-0` would print as "0" but keep it a plain 0. */
const negate = (n: number) => (n === 0 ? 0 : -n)

/** PLAIN predicates. Always correct. The column is bare on the left so partition pruning and idx_mm_imported_at apply. */
export function importedRangePlain(range: ImportedRange): ImportedRangeSql {
  const conditions: string[] = []
  const params: Record<string, number> = {}
  if (range.lower !== null) {
    conditions.push('imported_at > toDateTime({impAfter:Int64})')
    params.impAfter = range.lower
  }
  if (range.upper !== null) {
    conditions.push('imported_at <= toDateTime({impBefore:Int64})')
    params.impBefore = range.upper
  }
  return { conditions, params }
}

/** PLAIN plus the same bound on proj_imported_desc's key expression (ts > lower  <=>  -ts < -lower;  ts <= upper  <=>  -ts >= -upper). */
export function importedRangeProjection(range: ImportedRange): ImportedRangeSql {
  const sql = importedRangePlain(range)
  if (range.lower !== null) {
    sql.conditions.push(`${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`)
    sql.params.impKeyHi = negate(range.lower)
  }
  if (range.upper !== null) {
    sql.conditions.push(`${IMPORTED_KEY_EXPR} >= {impKeyLo:Int64}`)
    sql.params.impKeyLo = negate(range.upper)
  }
  return sql
}

/** ` AND a AND b` for the routes that build their WHERE by string concatenation. */
export function importedRangeAndSql(sql: ImportedRangeSql): string {
  return sql.conditions.map(c => ` AND ${c}`).join('')
}

export type ImportedRangeShape =
  /** ORDER BY imported_at (either direction) with a LIMIT: the shape proj_imported_desc serves. */
  | 'time'
  /** count() / uniq() / DISTINCT / GROUP BY over the range: order does not matter, only which rows are read. */
  | 'aggregate'
  /** Any other order (domain, email, password length) or a lookup that a key already narrows: the projection is not chosen. */
  | 'other'

export interface ImportedRangePlanContext {
  shape: ImportedRangeShape
  /** isIndexNeutralSearch(...) of the search; false for word, LIKE-fallback and regex searches. */
  indexNeutral: boolean
  /** Runs a read-only metadata query (the readiness check); routes pass `sql => executeQuery(sql)`. */
  run: (sql: string) => Promise<Array<Record<string, unknown>>>
}

/**
 * Chooses the form. The projection form only when ALL hold: a lower bound is set (it is what prunes), the shape is `time` or
 * `aggregate`, the search is index-neutral (its predicates mean the same on a projection part, which has no text index), and
 * Newest-first's readiness check says the projection is current (it fails closed). Everything else gets the plain form.
 */
export async function planImportedRange(range: ImportedRange, ctx: ImportedRangePlanContext): Promise<ImportedRangeSql> {
  if (range.lower === null || !ctx.indexNeutral || ctx.shape === 'other') return importedRangePlain(range)
  const status = await getNewestFirstStatus(ctx.run)
  return status.ready ? importedRangeProjection(range) : importedRangePlain(range)
}
