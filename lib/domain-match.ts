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
