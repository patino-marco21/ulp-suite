/**
 * The SQL parts and the answer shaping shared by POST /api/lookup/batch and POST /api/v1/lookup/batch (design:
 * docs/superpowers/specs/2026-10-26-batch-lookup-design.md). The two routes had two copies of this logic; both carried the same defects.
 * The domain half (`domainIn`, `searchedAsField`) is also used by GET /api/v1/lookup?domain=, which cleans its one domain the same way.
 *
 * E-mail. The comparison that decides is `lower(email) IN (lower(v1), ...)` (lib/address-lookup.ts): it finds every stored casing. Its bloom
 * filter alone cannot narrow a long list (bloom_filter(0.05): 1 address keeps 4.4% of the granules, 10 keep 35%, 100 keep 98.7%), so a batch of 100
 * read the whole table and took 26-38 s against the routes' 30 s cap. The raw `email IN (...)` this replaced in d9c5daf was narrowed by the text index
 * instead (100 addresses: 982 of 34,299 granules, 4.4 s). To get that pruning back without giving up the case-insensitive comparison, the WHERE
 * also carries `indexHint(hasAllTokens(email, [words of the address]) OR ...)`. indexHint is used by the index analysis and never evaluated on a row,
 * so the rows returned are decided only by `lower(email) IN (...)` and the hint can only drop granules whose tokens (case-insensitive: the index
 * preprocessor is lower(email)) lack a word of every queried address. A plain `hasAllTokens(email, ...)` filter is NOT equivalent: evaluated on a row it
 * is case-sensitive, and with the index off it lost the mixed-case rows of a real address (52 of 54).
 */
import { addressIn } from '@/lib/address-lookup'
import { asciiLower, BATCH_MAX_ENTRY_LENGTH, cleanEmailEntry, domainEntry, prefilterWords } from '@/lib/batch-input'

/** Rows returned per queried address or domain. */
export const RESULTS_CAP = 50

export interface BatchResult {
  found: boolean
  count: number
  results: unknown[]
  /** What was looked up when it is not what was pasted: a URL's host, the address inside `<...>` or after `mailto:`. */
  searched_as?: string
}

/** The strings of a JSON array field that have something in them; anything else (numbers, nulls, blanks) is ignored. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((e): e is string => typeof e === 'string' && e.trim() !== '') : []
}

/**
 * `searched_as` as a field to spread into an answer: what was looked up, when it is not what was typed (the caller trims and case-folds `typed` the way
 * it echoes it). Nothing when the two agree or when there was nothing to look up (`searched` is '').
 */
export function searchedAsField(searched: string, typed: string): { searched_as?: string } {
  return searched && searched !== typed ? { searched_as: searched } : {}
}

function withSearchedAs(result: BatchResult, searched: string, typed: string): BatchResult {
  return { ...result, ...searchedAsField(searched, typed) }
}

// ── E-mail ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EmailBatchEntry {
  /** The string as sent: the key of the answer. */
  original: string
  /** The login it stands for, as written ('' when there is none). */
  login: string
  /** The login with ASCII case folded, the value compared with lower(email) ('' when the entry is not looked up). */
  key: string
}

export interface EmailBatchGroup {
  /** A WHERE condition on lower(email) (plus the index hint when every address has words); the range bound is added by the route. */
  where: string
  params: Record<string, string | string[]>
}

export interface EmailBatchPlan {
  entries: EmailBatchEntry[]
  /** One query per group: the addresses with a prefilter, then (almost always none) the ones without one. */
  groups: EmailBatchGroup[]
}

function emailGroup(keys: string[], words: string[][] | null): EmailBatchGroup {
  const params: Record<string, string | string[]> = {}
  keys.forEach((key, i) => { params[`email${i}`] = key })
  let where = addressIn(keys.map((_, i) => `email${i}`))
  if (words) {
    const terms = words.map((w, i) => {
      params[`tok${i}`] = w
      return `hasAllTokens(email, {tok${i}:Array(String)})`
    })
    where += ` AND indexHint(${terms.join(' OR ')})`
  }
  return { where, params }
}

export function planEmailBatch(emails: string[]): EmailBatchPlan {
  const entries: EmailBatchEntry[] = emails.map(original => {
    const login = cleanEmailEntry(original)
    return { original, login, key: login.length > 0 && login.length <= BATCH_MAX_ENTRY_LENGTH ? asciiLower(login) : '' }
  })
  const prefiltered: Array<{ key: string; words: string[] }> = []
  const plain: string[] = []
  for (const key of new Set(entries.map(e => e.key).filter(Boolean))) {
    const words = prefilterWords(key)
    if (words) prefiltered.push({ key, words })
    else plain.push(key)
  }
  const groups: EmailBatchGroup[] = []
  if (prefiltered.length > 0) groups.push(emailGroup(prefiltered.map(p => p.key), prefiltered.map(p => p.words)))
  if (plain.length > 0) groups.push(emailGroup(plain, null))
  return { entries, groups }
}

/** Matches rows back to what was asked: every stored casing of an address is returned under it. */
export function emailResults<R extends { email: string }>(entries: EmailBatchEntry[], rows: R[]): Record<string, BatchResult> {
  const byKey = new Map<string, R[]>()
  for (const row of rows) {
    const key = asciiLower(row.email)
    const list = byKey.get(key)
    if (list) list.push(row)
    else byKey.set(key, [row])
  }
  const results: Record<string, BatchResult> = {}
  for (const e of entries) {
    const hits = e.key ? (byKey.get(e.key) ?? []) : []
    results[e.original] = withSearchedAs({ found: hits.length > 0, count: hits.length, results: hits }, e.login, e.original.trim())
  }
  return results
}

// ── Domains ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DomainBatchEntry {
  original: string
  host: string
  candidates: string[]
}

export interface DomainBatchPlan {
  entries: DomainBatchEntry[]
  /** The distinct stored values to look for: `domain IN (values...)`. */
  values: string[]
}

export function planDomainBatch(domains: string[]): DomainBatchPlan {
  const entries = domains.map(original => ({ original, ...domainEntry(original) }))
  return { entries, values: Array.from(new Set(entries.flatMap(e => e.candidates))) }
}

/**
 * `domain IN ({domain0:String}, ...)` and its parameters, for the stored values to look for (at least one: `IN ()` is not SQL). `domain` is the first
 * column of the primary key, so the list is a set of key ranges. Measured on the real table (2.23 billion rows, 15 parts), a list of one value reads
 * exactly the rows that `domain = x` reads (524,248 / 872,272 / 3,338,255 rows for a domain of 39 / 19,574 / 2,388,325 rows) and takes 4-25 ms more
 * (46-104 ms cold); each further value reads 0-270,000 rows more (a neighbouring block of the key per part) at no cost that shows above the noise.
 */
export function domainIn(values: string[]): { where: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  values.forEach((value, i) => { params[`domain${i}`] = value })
  return { where: `domain IN (${values.map((_, i) => `{domain${i}:String}`).join(', ')})`, params }
}

/** Matches rows back to what was asked; an input that stands for several stored values (www., as typed) gets them together, newest first, capped. */
export function domainResults<R extends { domain: string; imported_at?: string }>(entries: DomainBatchEntry[], rows: R[]): Record<string, BatchResult> {
  const byDomain = new Map<string, R[]>()
  for (const row of rows) {
    const list = byDomain.get(row.domain)
    if (list) list.push(row)
    else byDomain.set(row.domain, [row])
  }
  const results: Record<string, BatchResult> = {}
  for (const e of entries) {
    const found = e.candidates.map(c => byDomain.get(c)).filter((list): list is R[] => list !== undefined)
    let hits: R[] = found.length === 1 ? found[0] : found.flat()
    if (found.length > 1) hits = hits.sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? '')).slice(0, RESULTS_CAP)
    results[e.original] = withSearchedAs({ found: hits.length > 0, count: hits.length, results: hits }, e.host, e.original.trim().toLowerCase())
  }
  return results
}
