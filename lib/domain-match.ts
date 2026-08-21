/**
 * Pure domain-matching predicates shared by the upload-triggered monitor
 * check and the scheduled rescan (lib/domain-monitor.ts, lib/monitor-rescan-cron.ts).
 *
 * "Matches" means: the candidate is the monitored domain itself, or any
 * subdomain of it (label-boundary suffix match — "aave.com" matches
 * "app.aave.com" but not "notaave.com").
 */

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
