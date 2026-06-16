/**
 * Ingest-time tier filter — drops low-value rows BEFORE they are inserted.
 *
 * A parsed credential is checked against a drop policy and, if it matches, never
 * reaches ulp.credentials — so it costs no storage, no dedup, no index, no
 * materialized-column compute, and no future query compute. (The line still has
 * to be parsed first: you can't know a row's country tier without reading its
 * email/URL. Parsing is the cheap part; everything downstream is what this saves.)
 *
 * OFF BY DEFAULT and non-destructive to existing data — it only affects NEW
 * ingests, and only when configured. Enabling it permanently discards matching
 * rows at import time (re-import the source to recover them).
 *
 * Config (env):
 *   INGEST_FILTER_DROP_TIERS     — comma tiers to drop, e.g. "T3" or "T2,T3"
 *   INGEST_FILTER_DROP_SUFFIXES  — comma email-suffixes / URL TLDs for precise
 *                                  per-country drops (your "lower T2" picks),
 *                                  e.g. ".pt,.gr,.il,.ae"  (leading dot optional)
 *
 * Tiers are coarse (T1/T2/T3 — see lib/country-tiers.ts). For "lower T2" at
 * country granularity, list those countries' suffixes in DROP_SUFFIXES; they are
 * dropped regardless of tier.
 */
import { classifyTier, emailDomainOf, urlTldOf } from '@/lib/country-tiers'

export interface IngestDropPolicy {
  /** Whole tiers to drop (T1/T2/T3). */
  tiers: Set<string>
  /** Email-domain suffixes to drop (normalized with a leading '.'). */
  suffixes: string[]
  /** URL TLDs to drop (the suffixes without the leading dot). */
  tlds: Set<string>
}

const VALID = new Set(['T1', 'T2', 'T3'])

export function parseIngestPolicy(env: NodeJS.ProcessEnv = process.env): IngestDropPolicy {
  const tiers = new Set(
    (env.INGEST_FILTER_DROP_TIERS ?? '')
      .split(',').map(t => t.trim().toUpperCase()).filter(t => VALID.has(t)),
  )
  const suffixes = (env.INGEST_FILTER_DROP_SUFFIXES ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .map(s => (s.startsWith('.') ? s : `.${s}`))
  const tlds = new Set(suffixes.map(s => s.slice(1)))
  return { tiers, suffixes, tlds }
}

/** True when the policy would drop at least something (lets callers skip the work entirely). */
export function policyActive(p: IngestDropPolicy): boolean {
  return p.tiers.size > 0 || p.suffixes.length > 0
}

/** Whether this credential should be dropped at ingest under the policy. */
export function shouldDropAtIngest(email: string, url: string, p: IngestDropPolicy): boolean {
  if (p.tiers.size > 0) {
    const tier = classifyTier(email, url)
    if (tier && p.tiers.has(tier)) return true
  }
  if (p.suffixes.length > 0) {
    const ed = emailDomainOf(email)
    if (p.suffixes.some(suf => ed.endsWith(suf))) return true
    const tld = urlTldOf(url)
    if (tld && p.tlds.has(tld)) return true
  }
  return false
}
