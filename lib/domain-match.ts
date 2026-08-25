/**
 * Domain-matching predicates and SQL builders shared by the upload-triggered
 * monitor check, the scheduled rescan, and the live monitor-matches endpoint
 * (lib/domain-monitor.ts, lib/monitor-rescan-cron.ts,
 * app/api/monitoring/monitors/[id]/matches/route.ts).
 *
 * "Matches" means: the candidate is the monitored domain itself, or any
 * subdomain of it (label-boundary suffix match — "aave.com" matches
 * "app.aave.com" but not "notaave.com").
 *
 * domainMatches/emailDomainMatches/credentialMatchesDomain/matchCredentialsAgainstIndex
 * are pure, zero-dependency JS predicates for in-process matching.
 * matchConditionSQL/buildDomainSetWhereClause build the equivalent condition
 * as ClickHouse SQL — same semantics, different execution engine — and do
 * depend on lib/ulp-normalize's column expressions.
 */

import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import crypto from 'crypto'

/**
 * Compute a 64-bit hex fingerprint for a credential triple (email, password, domain).
 * Uses 8 bytes (16 hex chars) of SHA-256 — collision probability negligible even at
 * billions of stored fingerprints (birthday bound ~2^32 with 4 bytes was dangerously low).
 * Shared by the upload-triggered check, the scheduled rescan, and the live-matches
 * endpoint's new-since-last-viewed comparison — all three need the exact same
 * fingerprint for a given (email, password, domain) to agree on monitor_credential_seen.
 */
export function credentialFingerprint(email: string, password: string, domain: string): string {
  return crypto.createHash('sha256')
    .update(email).update('\0')
    .update(password).update('\0')
    .update(domain)
    .digest()
    .slice(0, 8)
    .toString('hex')
}

export type MatchMode = 'credential' | 'url' | 'both'

export function domainMatches(candidate: string, monitored: string): boolean {
  const c = candidate.toLowerCase().trim()
  const m = monitored.toLowerCase().trim()
  if (!c || !m) return false
  return c === m || c.endsWith('.' + m)
}

export function emailDomainMatches(email: string, monitored: string): boolean {
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  return domainMatches(email.slice(at + 1), monitored)
}

export function credentialMatchesDomain(
  cred: { domain: string; email: string },
  monitored: string,
  mode: MatchMode,
): boolean {
  if (mode === 'url') return domainMatches(cred.domain, monitored)
  if (mode === 'credential') return emailDomainMatches(cred.email, monitored)
  return domainMatches(cred.domain, monitored) || emailDomainMatches(cred.email, monitored)
}

export function matchModeToMatchType(mode: MatchMode): 'credential_email' | 'url' | 'both' {
  return mode === 'credential' ? 'credential_email' : mode
}

/** Every dot-boundary suffix of a domain, longest first: "a.b.c" -> ["a.b.c", "b.c", "c"]. */
export function domainSuffixChain(domain: string): string[] {
  const d = domain.toLowerCase().trim()
  if (!d) return []
  const labels = d.split('.')
  const chain: string[] = []
  for (let i = 0; i < labels.length; i++) {
    chain.push(labels.slice(i).join('.'))
  }
  return chain
}

/**
 * Normalize a user-entered domain into the bare-hostname shape
 * ulp.credentials.domain/email_domain store, so domainMatches/SQL predicates
 * can ever compare equal. Strips a leading scheme and everything from the
 * first '/' onward — "https://trezor.io/" and "trezor.io/some/path" both
 * become "trezor.io". A stored value with an unstripped trailing slash or
 * path can never match anything: see the design doc's §"Problem".
 */
export function normalizeDomainInput(raw: string): string {
  let d = raw.trim().toLowerCase()
  d = d.replace(/^https?:\/\//, '')
  const slashIdx = d.indexOf('/')
  if (slashIdx !== -1) d = d.slice(0, slashIdx)
  return d.trim()
}

export interface MonitorDomainIndexEntry {
  monitorId: number
  mode: MatchMode
}

/** Build a reverse index: monitored domain -> monitors watching it. One entry per (monitor, domain) pair. */
export function buildMonitorDomainIndex(
  monitors: Array<{ id: number; domains: string[]; match_mode: MatchMode }>,
): Map<string, MonitorDomainIndexEntry[]> {
  const index = new Map<string, MonitorDomainIndexEntry[]>()
  for (const monitor of monitors) {
    for (const domain of monitor.domains) {
      const key = domain.toLowerCase().trim()
      if (!key) continue
      const entry: MonitorDomainIndexEntry = { monitorId: monitor.id, mode: monitor.match_mode }
      const list = index.get(key)
      if (list) list.push(entry)
      else index.set(key, [entry])
    }
  }
  return index
}

export interface MatchedCredential {
  monitorId: number
  url: string
  email: string
  password: string
  domain: string
}

/**
 * Reverse-search match: for each credential, walk its domain's (and email
 * domain's) suffix chain against the index instead of scanning every
 * monitored domain — O(label count) per credential instead of O(monitored
 * domains). Equivalent to calling credentialMatchesDomain(cred, d, mode) for
 * every monitored domain d, just computed the other way around.
 */
export function matchCredentialsAgainstIndex(
  creds: Array<{ url: string; email: string; password: string; domain: string }>,
  index: Map<string, MonitorDomainIndexEntry[]>,
): MatchedCredential[] {
  if (index.size === 0) return []
  const matches: MatchedCredential[] = []

  for (const cred of creds) {
    const matchedMonitors = new Set<number>()

    for (const suffix of domainSuffixChain(cred.domain)) {
      const entries = index.get(suffix)
      if (!entries) continue
      for (const entry of entries) {
        if (entry.mode === 'url' || entry.mode === 'both') matchedMonitors.add(entry.monitorId)
      }
    }

    const at = cred.email.lastIndexOf('@')
    if (at !== -1) {
      for (const suffix of domainSuffixChain(cred.email.slice(at + 1))) {
        const entries = index.get(suffix)
        if (!entries) continue
        for (const entry of entries) {
          if (entry.mode === 'credential' || entry.mode === 'both') matchedMonitors.add(entry.monitorId)
        }
      }
    }

    for (const monitorId of matchedMonitors) {
      matches.push({ monitorId, url: cred.url, email: cred.email, password: cred.password, domain: cred.domain })
    }
  }

  return matches
}

// ─── ClickHouse SQL condition builders ─────────────────────────────────────

/**
 * Build the subdomain-aware WHERE fragment for one domain, using the given
 * ClickHouse named-parameter names for its {domain}/{domainSuffix} values.
 * Shared building block for matchConditionSQL (one domain, fixed param
 * names) and buildDomainSetWhereClause (many domains, indexed param names).
 */
function domainConditionSQL(mode: MatchMode, domainParam: string, domainSuffixParam: string): string {
  const urlCond = `((${NORM_DOMAIN_EXPR}) = {${domainParam}:String} OR endsWith((${NORM_DOMAIN_EXPR}), {${domainSuffixParam}:String}))`
  const emailLower = `lower(${NORM_EMAIL_EXPR})`
  // Domain after the LAST '@'. The position(...) > 0 guard is required:
  // ClickHouse's position() returns 0 (not -1) when '@' is absent, which
  // without the guard would make the extraction equal the WHOLE email
  // string — false-matching any row whose raw email column happens to
  // equal or end with a monitored domain (common on corrupted rows with no
  // '@' at all; see lib/ulp-normalize.ts's docstring on Cases A-D).
  const emailDomainExpr = `arrayElement(splitByChar('@', ${emailLower}), -1)`
  const emailCond = `(position(${emailLower}, '@') > 0 AND ((${emailDomainExpr}) = {${domainParam}:String} OR endsWith((${emailDomainExpr}), {${domainSuffixParam}:String})))`
  if (mode === 'url') return urlCond
  if (mode === 'credential') return emailCond
  return `(${urlCond} OR ${emailCond})`
}

/**
 * Build the subdomain-aware WHERE fragment for a monitor's match_mode
 * against a single domain, bound via ClickHouse named parameters {domain}
 * and {domainSuffix}. Moved here from lib/monitor-rescan-cron.ts so the
 * live-matches endpoint and the scheduled rescan share one implementation
 * instead of two.
 */
export function matchConditionSQL(mode: MatchMode): string {
  return domainConditionSQL(mode, 'domain', 'domainSuffix')
}

/**
 * Build a single WHERE fragment matching ANY of the given domains, each
 * bound to its own indexed ClickHouse named parameters (domain0/domainSuffix0,
 * domain1/domainSuffix1, ...) so a monitor's whole domain set can be queried
 * in one ClickHouse round trip instead of one query per domain.
 */
export function buildDomainSetWhereClause(
  domains: string[],
  mode: MatchMode,
): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const parts = domains.map((domain, i) => {
    const d = domain.toLowerCase().trim()
    const domainParam = `domain${i}`
    const domainSuffixParam = `domainSuffix${i}`
    params[domainParam] = d
    params[domainSuffixParam] = `.${d}`
    return domainConditionSQL(mode, domainParam, domainSuffixParam)
  })
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}

// ─── Two-phase candidate resolution ────────────────────────────────────────
//
// buildDomainSetWhereClause's endsWith() subdomain test is not prunable by any
// index on ulp.credentials: confirmed via `EXPLAIN indexes=1` that a bare
// `domain = 'x'` prunes 37350 granules to 38, while adding `OR endsWith(...)`
// leaves 37350/37350. Without a LIMIT's worth of matching rows to short-circuit
// on, that means a full scan of a 2.4-billion-row table.
//
// The fix is to split the work: resolve which *exact* column values could
// belong to a matching row (phase 1, one narrow column), then filter on that
// value set (phase 2, an exact-value IN-list, which IS prunable). See
// app/api/monitoring/monitors/[id]/matches/route.ts for the measured numbers.

/**
 * Raw stored columns a phase-1 candidate scan can resolve values from.
 * `domain` is ulp.credentials' primary-key leading column; `email_domain` is a
 * MATERIALIZED column holding the raw email's domain, covered by both a
 * bloom-filter and an ngram skip index.
 */
export type CandidateColumn = 'domain' | 'email_domain'

/**
 * Phase 1: which values of ONE raw stored column could belong to a row
 * matching this domain set. Same domain-or-subdomain semantics as
 * domainConditionSQL, but evaluated against a bare column rather than
 * NORM_DOMAIN_EXPR/NORM_EMAIL_EXPR, so ClickHouse reads only that one column
 * instead of the whole (url, email, password) row.
 */
export function buildCandidateColumnWhereClause(
  column: CandidateColumn,
  domains: string[],
): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const parts = domains.map((domain, i) => {
    const d = domain.toLowerCase().trim()
    const eqParam = `${column}Eq${i}`
    const suffixParam = `${column}Suffix${i}`
    params[eqParam] = d
    params[suffixParam] = `.${d}`
    return `(${column} = {${eqParam}:String} OR endsWith(${column}, {${suffixParam}:String}))`
  })
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}

/** One index-prunable phase-2 read, restricted to one column's resolved values. */
export interface CandidateBranch {
  clause: string
  params: Record<string, string[]>
}

/**
 * Phase 2: restrict the scan to the exact column values phase 1 resolved —
 * ONE branch per column, to be run separately and merged, rather than a single
 * ORed clause. `domain IN (...) OR email_domain IN (...)` is prunable by
 * neither the primary key nor either bloom filter, because a granule can only
 * be skipped when the whole expression is provably false and each index sees
 * the other side of the OR as unknown. Measured on a 'both'-mode monitor:
 * 5.65 s as one ORed query, 0.24 s as two branches run in parallel.
 *
 * Each branch excludes the columns already covered by the branches before it,
 * so a row matching two columns is returned once — the same row set the ORed
 * form would produce, not a doubled one. `columns` order is therefore
 * significant: put the most selective column first.
 *
 * `excludedDomains` extends that same disjointness to rows the caller resolves
 * by some OTHER means and merges in separately — for the live-matches endpoint,
 * the `domain IN ('', 'http', 'https')` bucket whose matches phase 1 fetches as
 * rows because normalization can rewrite them into a different domain entirely.
 * Without it that bucket belongs to two pages at once: an `email_domain` branch
 * happily returns the very rows the caller already holds (those rows carry a
 * real `email_domain` even though their `domain` is blank or scheme-only), and
 * mergeMatchPages — which assumes its pages are disjoint — pads the result with
 * duplicates that evict genuinely distinct matches. Measured on real data:
 * `example.com` in `both` mode merged 100 rows carrying just 42 distinct ones,
 * with every row the `domain` branch found evicted. Excluding the bucket in SQL
 * is prunable on the primary key's leading column, so it also stops phase 2
 * from reading the large `domain = ''` range at all.
 *
 * These are pruning accelerators only. The caller still ANDs the real
 * buildDomainSetWhereClause condition onto every branch, so an over-inclusive
 * value set costs time but can never return a wrong row.
 *
 * Columns with no resolved values are dropped (ClickHouse cannot infer the
 * element type of an empty array). No branches at all means phase 1 proved
 * there is nothing to find.
 */
export function buildCandidateValueBranches(
  columns: Array<{ column: CandidateColumn; values: string[] }>,
  excludedDomains: string[] = [],
): CandidateBranch[] {
  const present = columns.filter(c => c.values.length > 0)
  return present.map(({ column, values }, i) => {
    const param = `${column}Values`
    const params: Record<string, string[]> = { [param]: values }
    const exclusions = present.slice(0, i).map(prior => {
      const priorParam = `${prior.column}Values`
      params[priorParam] = prior.values
      return ` AND NOT ${prior.column} IN {${priorParam}:Array(String)}`
    })
    if (excludedDomains.length > 0) {
      params.excludedDomains = excludedDomains
      exclusions.push(` AND domain NOT IN {excludedDomains:Array(String)}`)
    }
    return { clause: `${column} IN {${param}:Array(String)}${exclusions.join('')}`, params }
  })
}

// ─── Bounded match pages ───────────────────────────────────────────────────

/**
 * One credential as the live-matches endpoint returns it: raw columns plus the
 * normalized domain lib/ulp-normalize.ts derives (see NORM_DOMAIN_EXPR), which
 * is what the reader actually sees and what credentialFingerprint hashes.
 */
export interface MatchRow {
  url: string
  email: string
  password: string
  domain: string
}

/**
 * Full-tiebreak display order for a match page.
 *
 * Deliberately finer than the ClickHouse-side sort, which stops at the
 * primary-key prefix `(domain, email)` because that is the only sort the table
 * can give away for free — asking it for the `(url, password)` tiebreak too
 * measured 14.88 s against 1.25 s on a broad candidate set. Applying the finer
 * order to the already-bounded page pins display order completely at no cost.
 */
export function compareMatches(a: MatchRow, b: MatchRow): number {
  return (
    a.domain.localeCompare(b.domain) ||
    a.email.localeCompare(b.email) ||
    a.url.localeCompare(b.url) ||
    a.password.localeCompare(b.password)
  )
}

/**
 * Merge per-branch pages back into one ordered page of at most `limit` rows.
 *
 * PRECONDITION: the pages cover DISJOINT row sets. Nothing here deduplicates,
 * and the argument below is only valid while that holds — overlapping pages
 * silently pad the result with duplicates that evict distinct matches. The
 * caller owns that invariant; for the live-matches endpoint it is
 * buildCandidateValueBranches' `excludedDomains` that enforces it.
 *
 * Given disjoint pages, each its own top-`limit` in the shared sort order,
 * merging them and keeping the first `limit` yields the same page a single
 * combined query would: if a row is in the global top-`limit` then fewer than
 * `limit` rows sort before it, so it is also within its own page's top-`limit`.
 *
 * Two things make the merge order finer than the query order, so the merged
 * page can differ from a true global sort for rows sitting exactly on the
 * boundary. Both are bounded and deterministic, which is all the is_new badge
 * requires, and neither is reachable by a monitor small enough to return under
 * `limit` rows in the first place.
 *
 * First, compareMatches breaks ties on (url, password) while the query's sort
 * stops at (domain, email) — deliberately, since asking ClickHouse for that
 * tiebreak costs 14.88 s against 1.25 s on a broad candidate set. So when a
 * single (domain, email) group straddles the limit, WHICH of its rows the
 * database returned is not pinned.
 *
 * Second, the merge compares the NORMALIZED domain while the queries sorted on
 * the raw one. They differ only for the Case A–D rows lib/ulp-normalize.ts
 * rewrites, so the merge can pick a slightly different set than a true global
 * sort would when such a row sits on the boundary. Deterministic either way.
 * Measured on a broad monitor (facebook.com, credential mode, merge pool of
 * 179 rows for a 100-row page): 9 distinct rows differed from an unpruned
 * reference query (82 vs. 83 distinct) — not "row-for-row identical," though
 * it is for any monitor whose true match count stays under MATCH_LIMIT, which
 * is the case this endpoint exists to serve.
 *
 * `.flat()` always builds a fresh array, so the sort can never reorder a page
 * the caller still holds — the live-matches endpoint passes in a cached page
 * that gets served again on the next request inside the cache TTL.
 */
export function mergeMatchPages(pages: MatchRow[][], limit: number): MatchRow[] {
  return pages.flat().sort(compareMatches).slice(0, limit)
}
