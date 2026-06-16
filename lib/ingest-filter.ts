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
 * Three knobs (env), evaluated keep-first:
 *   INGEST_FILTER_KEEP_SUFFIXES  — email-suffixes / URL TLDs to ALWAYS keep, even
 *                                  if their tier is dropped. This is how you keep
 *                                  specific wealthy countries that live in T2/T3
 *                                  (Ireland .ie, UAE .ae, Saudi .sa, …).
 *   INGEST_FILTER_DROP_TIERS     — whole tiers to drop, e.g. "T2,T3". Untiered ('')
 *                                  is NEVER dropped by tier — most high-value users
 *                                  are on generic webmail (@gmail/.com) and untiered,
 *                                  so dropping untiered would throw the baby out.
 *   INGEST_FILTER_DROP_SUFFIXES  — extra email-suffixes / URL TLDs to drop outright.
 *
 * Recommended "wealthy + English-speaking + Gulf oil" target (see .env.example):
 *   DROP_TIERS=T2,T3
 *   KEEP_SUFFIXES=.ie,.mt,.ae,.sa,.qa,.kw,.bh,.om   (+ optional .sg,.lu, Nordics)
 *   → keeps T1 (US/UK/CA/AU/NZ) + untiered + those countries; drops the rest.
 */
import { classifyTier, emailDomainOf, urlTldOf } from '@/lib/country-tiers'

export interface SuffixSet {
  /** Email-domain suffixes (normalized with a leading '.'). */
  suffixes: string[]
  /** URL TLDs (the suffixes without the leading dot). */
  tlds: Set<string>
}

export interface IngestDropPolicy {
  /** Whole tiers to drop (T1/T2/T3). */
  tiers: Set<string>
  /** Drop these email suffixes / URL TLDs. */
  drop: SuffixSet
  /** Keep these even if their tier/suffix would otherwise be dropped (wins). */
  keep: SuffixSet
}

const VALID = new Set(['T1', 'T2', 'T3'])

function parseSuffixSet(raw: string | undefined): SuffixSet {
  const suffixes = (raw ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .map(s => (s.startsWith('.') ? s : `.${s}`))
  return { suffixes, tlds: new Set(suffixes.map(s => s.slice(1))) }
}

export function parseIngestPolicy(env: NodeJS.ProcessEnv = process.env): IngestDropPolicy {
  const tiers = new Set(
    (env.INGEST_FILTER_DROP_TIERS ?? '')
      .split(',').map(t => t.trim().toUpperCase()).filter(t => VALID.has(t)),
  )
  return {
    tiers,
    drop: parseSuffixSet(env.INGEST_FILTER_DROP_SUFFIXES),
    keep: parseSuffixSet(env.INGEST_FILTER_KEEP_SUFFIXES),
  }
}

/** True when the policy would drop at least something (lets callers skip the work). */
export function policyActive(p: IngestDropPolicy): boolean {
  return p.tiers.size > 0 || p.drop.suffixes.length > 0
}

/** Does this credential's email-suffix or URL-TLD fall in the given set? */
function matchesSuffixSet(email: string, url: string, set: SuffixSet): boolean {
  if (set.suffixes.length === 0) return false
  const ed = emailDomainOf(email)
  if (set.suffixes.some(suf => ed.endsWith(suf))) return true
  const tld = urlTldOf(url)
  return tld !== '' && set.tlds.has(tld)
}

/** Whether this credential should be dropped at ingest under the policy. */
export function shouldDropAtIngest(email: string, url: string, p: IngestDropPolicy): boolean {
  // Keep-override wins: an explicitly-kept country is never dropped, even if its
  // tier is in DROP_TIERS (this is how T2/T3 wealthy countries survive a tier drop).
  if (matchesSuffixSet(email, url, p.keep)) return false

  if (p.tiers.size > 0) {
    const tier = classifyTier(email, url)
    // Untiered ('') is intentionally never tier-dropped.
    if (tier !== '' && p.tiers.has(tier)) return true
  }
  if (matchesSuffixSet(email, url, p.drop)) return true
  return false
}
