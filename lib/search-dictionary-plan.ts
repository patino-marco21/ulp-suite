/**
 * The domain search plan (design: docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md).
 *
 * A search for ONE positive, domain-shaped term is `P = A or B or C` in the legacy predicate (lib/ulp-search.ts):
 *   A: domain = x OR domain LIKE '%.x'      B: url_host LIKE '%x%'      C: email_domain LIKE '%x%'
 * and ClickHouse cannot prune it once two substring branches sit in the OR. From the dictionaries (lib/search-dictionary.ts) it takes
 *   D = every `domain` of a row satisfying A or B      E = every `email_domain` containing x
 * and the route keeps its legacy WHERE and keyset clause VERBATIM and ANDs a redundant, prunable conjunct onto two disjoint branches:
 *   branch 1: P AND domain IN D                               (primary key on `domain`)
 *   branch 2: P AND domain NOT IN D AND (_part, _part_offset) IN (rows of E through proj_email_domain_rev)
 * Only C can be true outside D, and those rows are exactly what branch 2 reads. Because the legacy predicate stays in every query, an
 * over-inclusive candidate set can only cost time; a wrong row is impossible, and the dictionary's freshness guard exists so that the
 * candidate set is never too SMALL.
 *
 * Two ClickHouse 26.3 facts found by testing (each pinned by a test):
 *  - with a `_part_offset` filter, the predicate is moved to PREWHERE, where the column does not exist ("Not found column _part_offset in
 *    block"); verified on 26.3.17 for sorts led by `domain`, `email` and `length(password)`: `optimize_move_to_prewhere = 0` on THAT branch
 *    fixes it, while `query_plan_optimize_lazy_materialization = 0` alone does not, on the branch or at the top level (the first live
 *    rehearsal showed it; the latter stays in as a second guard);
 *  - `optimize_use_projections = 0` around the offset sub-select destroys its pruning (9-16 s instead of 0.3-1 s), so the sub-select pins
 *    projections on and names the projection.
 *
 * The candidate lists are written into the SQL as literals (lib/clickhouse-literals.ts): a URL parameter above 128 KiB is refused by
 * ClickHouse and the body limit is max_query_size (256 KiB), so the lists are capped by count AND by bytes.
 */
import { executeQuery } from '@/lib/clickhouse'
import { parseULPQuery, buildULPWhere } from '@/lib/ulp-search'
import { dedupeLimitBy, dedupeCountPartial } from '@/lib/ulp-dedupe'
import { chStringArrayLiteral, chReversedArrayLiteral } from '@/lib/clickhouse-literals'
import { isEmailDomainRevProjectionReady, EMAIL_DOMAIN_REV_PROJECTION_NAME } from '@/lib/credentials-projections'
import {
  getSearchDictionaryStatus, searchDictionaryEnabled, searchDictMaxDomains, searchDictMaxEmailDomains, HOST_DICT_TABLE, EMAIL_DICT_TABLE,
  type DictionaryStatus, type Run,
} from '@/lib/search-dictionary'

export const DOMAINS_LITERAL_MAX_BYTES = 90_000
export const EMAIL_LITERAL_MAX_BYTES = 20_000
/** max_query_size is 262,144 and D appears twice in a query; this leaves room for the rest of the SQL. */
export const DICTIONARY_SQL_MAX_CHARS = 240_000

const LOOKUP_TIMEOUT_SECONDS = 8
const VERDICT_TTL_MS = 600_000
const FAILURE_TTL_MS = 60_000
const CACHE_MAX_TERMS = 200
const PROJECTION_READY_TTL_MS = 60_000

// ── the term ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DictionaryTerm {
  /** The lowercased term: `domain = exact`. */
  exact: string
  /** `domain LIKE suffix`, i.e. `%.term`, with `_` escaped as the legacy predicate does. */
  suffix: string
  /** `url_host LIKE like` and `email_domain LIKE like`, i.e. `%term%`. */
  like: string
}

/**
 * The term, when the whole search is exactly one positive, non-regex, domain-shaped term; null for everything else (single word, @email, several
 * terms, negation, regex), which keeps today's query. The patterns come out of buildULPWhere's own parameters so they cannot drift from it.
 */
export function dictionaryTermFromQuery(q: string, regex: boolean): DictionaryTerm | null {
  if (regex) return null
  const tokens = parseULPQuery(q)
  if (tokens.length !== 1) return null
  const [token] = tokens
  if (token.type !== 'domain' || token.negate) return null
  const { params } = buildULPWhere(tokens)
  const { dom0, domsuf0, domlk0 } = params
  if (typeof dom0 !== 'string' || typeof domsuf0 !== 'string' || typeof domlk0 !== 'string') return null
  return { exact: dom0, suffix: domsuf0, like: domlk0 }
}

// ── the candidates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DictionaryCandidates {
  /** D: sorted, de-duplicated. */
  domains: string[]
  /** E: sorted. */
  emailDomains: string[]
  /** Neither D nor E has a value: no row can match. */
  empty: boolean
  /** D as a ClickHouse array literal, ready to inline. */
  domainsLiteral: string
  /** reverse(E), bytewise, as an array literal: the key of proj_email_domain_rev. */
  emailRevLiteral: string
}

export interface PlannerDeps {
  run?: Run
  now?: () => number
  status?: () => Promise<DictionaryStatus>
  projectionReady?: () => Promise<boolean>
}

const LOOKUP_SETTINGS = `SETTINGS use_query_cache = 0, max_execution_time = ${LOOKUP_TIMEOUT_SECONDS}`
const SQL_BY_EXACT = `SELECT domain FROM ${HOST_DICT_TABLE} WHERE domain = {exact:String} GROUP BY domain LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`
const SQL_BY_SUFFIX = `SELECT domain FROM ${HOST_DICT_TABLE} WHERE domain LIKE {suffix:String} GROUP BY domain LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`
const SQL_BY_HOST = `SELECT domain FROM ${HOST_DICT_TABLE} WHERE url_host LIKE {like:String} GROUP BY domain LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`
const SQL_BY_EMAIL = `SELECT email_domain FROM ${EMAIL_DICT_TABLE} WHERE email_domain LIKE {like:String} LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`

interface CacheEntry { at: number; ttl: number; value: Promise<DictionaryCandidates | null> }
const cache = new Map<string, CacheEntry>()
let projectionCache: { at: number; value: boolean } | null = null

export function resetDictionaryPlanCache(): void {
  cache.clear()
  projectionCache = null
}

async function projectionIsReady(run: Run, now: () => number): Promise<boolean> {
  const t = now()
  if (projectionCache && t - projectionCache.at < PROJECTION_READY_TTL_MS) return projectionCache.value
  const value = await isEmailDomainRevProjectionReady(sql => run(sql) as Promise<Array<{ parts?: unknown; with_projection?: unknown }>>)
  projectionCache = { at: t, value }
  return value
}

async function lookupCandidates(term: DictionaryTerm, run: Run, deps: PlannerDeps, now: () => number): Promise<DictionaryCandidates | null> {
  const maxDomains = searchDictMaxDomains()
  const maxEmail = searchDictMaxEmailDomains()
  // one above each cap, so "over the cap" is visible without reading the whole answer
  const [exact, suffix, host, email] = await Promise.all([
    run(SQL_BY_EXACT, { exact: term.exact, cap: maxDomains + 1 }),
    run(SQL_BY_SUFFIX, { suffix: term.suffix, cap: maxDomains + 1 }),
    run(SQL_BY_HOST, { like: term.like, cap: maxDomains + 1 }),
    run(SQL_BY_EMAIL, { like: term.like, cap: maxEmail + 1 }),
  ])
  const domains = [...new Set([...exact, ...suffix, ...host].map(r => String(r.domain)))].sort()
  const emailDomains = email.map(r => String(r.email_domain)).sort()
  if (domains.length > maxDomains || emailDomains.length > maxEmail) return null

  const domainsLiteral = chStringArrayLiteral(domains)
  const emailRevLiteral = chReversedArrayLiteral(emailDomains)
  if (Buffer.byteLength(domainsLiteral, 'utf8') > DOMAINS_LITERAL_MAX_BYTES || Buffer.byteLength(emailRevLiteral, 'utf8') > EMAIL_LITERAL_MAX_BYTES) return null

  if (emailDomains.length > 0 && !(await (deps.projectionReady ?? (() => projectionIsReady(run, now)))())) return null
  return { domains, emailDomains, empty: domains.length === 0 && emailDomains.length === 0, domainsLiteral, emailRevLiteral }
}

/**
 * The candidates for a term, or null when today's query should run (feature off, dictionary not fresh, a cap exceeded, the projection missing,
 * the lookup failed). Cached per (dictionary fingerprint, term) for ten minutes, a failure for one; concurrent callers share the one lookup.
 */
export async function resolveDictionaryCandidates(term: DictionaryTerm, deps: PlannerDeps = {}): Promise<DictionaryCandidates | null> {
  if (!searchDictionaryEnabled()) return null
  const run: Run = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const status = await (deps.status ?? (() => getSearchDictionaryStatus(run)))()
  if (status.state !== 'fresh' || !status.fingerprint) return null

  const key = `${status.fingerprint}\u0000${term.exact}`
  const t = now()
  const hit = cache.get(key)
  if (hit && t - hit.at < hit.ttl) return hit.value

  const entry: CacheEntry = { at: t, ttl: VERDICT_TTL_MS, value: Promise.resolve(null) }
  entry.value = lookupCandidates(term, run, deps, now).catch((err: unknown) => {
    entry.ttl = FAILURE_TTL_MS
    console.warn('[search-dictionary] candidate lookup failed -- using the plain query:', err instanceof Error ? err.message : String(err))
    return null
  })
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_MAX_TERMS) cache.delete(cache.keys().next().value as string)
  return entry.value
}

// ── the SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function offsetFilter(c: DictionaryCandidates): string {
  return `(_part, _part_offset) IN (SELECT _part, _part_offset FROM ulp.credentials WHERE reverse(email_domain) IN ${c.emailRevLiteral} `
    + `SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}')`
}

interface Branch {
  /** ANDed onto the route's WHERE. */
  conjunct: string
  /** Appended to the branch's SELECT. */
  settings: string
}

function branchesFor(c: DictionaryCandidates): Branch[] {
  const out: Branch[] = []
  const hasDomains = c.domains.length > 0
  if (hasDomains) out.push({ conjunct: ` AND domain IN ${c.domainsLiteral}`, settings: '' })
  if (c.emailDomains.length > 0) {
    out.push({
      conjunct: `${hasDomains ? ` AND domain NOT IN ${c.domainsLiteral}` : ''} AND ${offsetFilter(c)}`,
      settings: ' SETTINGS optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0',
    })
  }
  return out
}

const union = (selects: string[]): string => (selects.length === 1 ? selects[0] : selects.map(s => `(${s})`).join('\nUNION ALL\n'))

export interface RowsSqlInput {
  /** The route's `where`: search predicate, filters, Declutter, tier and login type. Used verbatim. */
  where: string
  /** The route's keyset clause (`' AND ...'`) or ''. Used verbatim. */
  cursorClause: string
  orderBy: string
  dedupe: boolean
  /** Unique with a sort not led by `domain`: de-duplicate inside a bounded window (the route's DEDUPE_WINDOW_FACTOR). */
  dedupeInWindow: boolean
  rawCols: string
  selectList: string
  sortMaxMemoryBytes: number
  normColsSetting: string
  candidates: DictionaryCandidates
}

/**
 * The route's data query, answered from the candidates. Same rows, same order: each branch is the legacy inner SELECT with one more
 * conjunct, the merge re-applies the ORDER BY, the de-duplication and the LIMIT. Null when there is nothing to search (the caller answers
 * an empty page) or the SQL would not fit max_query_size (the caller runs today's query). References {limit:UInt32} and, in the window form,
 * {windowLimit:UInt32}, which the route already binds.
 */
export function buildDictionaryRowsSql(a: RowsSqlInput): string | null {
  const branches = branchesFor(a.candidates)
  if (branches.length === 0) return null
  const branchLimit = a.dedupeInWindow ? '{windowLimit:UInt32}' : '{limit:UInt32}'
  const branchDedupe = a.dedupeInWindow ? '' : dedupeLimitBy(a.dedupe)
  const select = (b: Branch) => `SELECT ${a.rawCols}, content_key_hash
FROM ulp.credentials
WHERE ${a.where}${a.cursorClause}${b.conjunct}
ORDER BY ${a.orderBy}
${branchDedupe}
LIMIT ${branchLimit}${b.settings}`
  const merged = union(branches.map(select))
  const settings = `SETTINGS max_execution_time = 300,
         timeout_overflow_mode = 'throw',
         http_wait_end_of_query = 1,
         max_bytes_before_external_sort = ${a.sortMaxMemoryBytes},
         ${a.normColsSetting}`
  const sql = a.dedupeInWindow
    ? `SELECT ${a.selectList}
FROM (
  SELECT ${a.rawCols}
  FROM (
    SELECT ${a.rawCols}, content_key_hash
    FROM (${merged})
    ORDER BY ${a.orderBy}
    LIMIT {windowLimit:UInt32}
  )
  ORDER BY ${a.orderBy}
  ${dedupeLimitBy(true)}
  LIMIT {limit:UInt32}
) AS t
${settings}`
    : `SELECT ${a.selectList}
FROM (
  SELECT ${a.rawCols}
  FROM (${merged})
  ORDER BY ${a.orderBy}
  ${dedupeLimitBy(a.dedupe)}
  LIMIT {limit:UInt32}
) AS t
${settings}`
  return sql.length <= DICTIONARY_SQL_MAX_CHARS ? sql : null
}

export interface TotalsSqlInput {
  /** The route's `whereRaw`: the search without the Declutter condition and without the cursor. Used verbatim. */
  whereRaw: string
  dedupe: boolean
  hasUserFilter: boolean
  /** The Declutter condition (`is_noise = 0`) when it is on: it lives inside the aggregate, as in the legacy totals. */
  onlyIf?: string
  candidates: DictionaryCandidates
}

/**
 * The route's totals query (`total` and `raw_total` in one pass), one aggregate per disjoint branch, combined by merging aggregate states
 * (lib/ulp-dedupe.ts dedupeCountPartial) so the number equals the legacy single scan's. Null as buildDictionaryRowsSql.
 */
export function buildDictionaryTotalsSql(a: TotalsSqlInput): string | null {
  const branches = branchesFor(a.candidates)
  if (branches.length === 0) return null
  const { partial, combine } = dedupeCountPartial(a.dedupe, a.hasUserFilter, a.onlyIf)
  const select = (b: Branch) => `SELECT ${partial} AS part_total, count() AS part_rows
FROM ulp.credentials
WHERE ${a.whereRaw}${b.conjunct}${b.settings}`
  const sql = `SELECT ${combine('part_total')} AS total, sum(part_rows) AS raw_total
FROM (${union(branches.map(select))})
SETTINGS optimize_trivial_count_query = 1,
         max_execution_time = 300,
         timeout_overflow_mode = 'break',
         use_query_cache = 0`
  return sql.length <= DICTIONARY_SQL_MAX_CHARS ? sql : null
}
