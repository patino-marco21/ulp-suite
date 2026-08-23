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
