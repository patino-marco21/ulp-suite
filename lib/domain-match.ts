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
    return { clause: `${column} IN {${param}:Array(String)}${exclusions.join('')}`, params }
  })
}
